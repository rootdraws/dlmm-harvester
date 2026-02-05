import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import fs from "fs";

// --- Types (fix 4.5) ---

export interface DashboardPosition {
  pubkey: string;
  strategy: string;
  label: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tokenXMint: string | null;
  tokenYMint: string | null;
  tokenXDecimals: number;
  tokenYDecimals: number;
  rangeLower: number;
  rangeUpper: number;
  priceLower: string;
  priceUpper: string;
  xBalance: number;
  yBalance: number;
  lastHarvest: string | null;
}

export interface DashboardState {
  activeId: number;
  uptime: number;
  pollCount: number;
  harvestCount: number;
  totalSol: number;
  pollInterval: number;
  fastMode: boolean;
  positions: DashboardPosition[];
  harvests: any[];
  errors: string[];
  // Enriched by this module
  solPrice: number | null;
  tokenPrices: Record<string, { price: number; lastUpdated: number }>;
}

// --- State (initialized lazily in startWebServer) ---

let app: express.Express | null = null;
let server: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;
let priceInterval: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;

let currentState: DashboardState | null = null;
let cachedSolPrice: number | null = null;
let cachedSolPriceUpdated: number = 0;
let cachedTokenPrices: Record<string, { price: number; lastUpdated: number }> = {};
let lastPriceFetch: number = 0;
let tokenMints: Record<string, string> = {};
let consecutiveFailures: number = 0;

// --- Price fetching ---

const PRICE_INTERVAL = 30_000;
const MAX_BACKOFF = 300_000; // 5 min cap

function getPriceInterval(): number {
  if (consecutiveFailures === 0) return PRICE_INTERVAL;
  // fix 4.2 — exponential backoff on failures
  return Math.min(PRICE_INTERVAL * Math.pow(2, consecutiveFailures), MAX_BACKOFF);
}

async function fetchPrices(force = false): Promise<void> {
  const now = Date.now();
  const interval = getPriceInterval();
  if (!force && now - lastPriceFetch < interval) return;
  lastPriceFetch = now;

  let hadError = false;

  // SOL from CoinGecko
  try {
    const solRes = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );
    // fix 4.2 — check status before parsing
    if (!solRes.ok) {
      console.warn(`CoinGecko returned ${solRes.status}`);
      hadError = true;
    } else {
      const solData = (await solRes.json()) as any;
      const price = solData?.solana?.usd;
      if (typeof price === "number") {
        cachedSolPrice = price;
        cachedSolPriceUpdated = now;
      }
    }
  } catch (e) {
    console.warn(`CoinGecko fetch failed: ${e}`);
    hadError = true;
  }

  // fix 4.3 — batch DexScreener calls: comma-separated mints in one request
  const mintEntries = Object.entries(tokenMints);
  if (mintEntries.length > 0) {
    try {
      const allMints = mintEntries.map(([_, mint]) => mint).join(",");
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${allMints}`);

      if (!res.ok) {
        console.warn(`DexScreener returned ${res.status}`);
        hadError = true;
      } else {
        const data = (await res.json()) as any;
        if (data.pairs && Array.isArray(data.pairs)) {
          // Build a map of mint -> best Solana pair by liquidity
          const bestByMint = new Map<string, any>();

          for (const pair of data.pairs) {
            if (pair.chainId !== "solana") continue;
            const mint = pair.baseToken?.address;
            if (!mint) continue;

            const existing = bestByMint.get(mint);
            if (!existing || (pair.liquidity?.usd || 0) > (existing.liquidity?.usd || 0)) {
              bestByMint.set(mint, pair);
            }
          }

          // Map back to symbols
          for (const [symbol, mint] of mintEntries) {
            const pair = bestByMint.get(mint);
            if (pair) {
              const price = parseFloat(pair.priceUsd);
              if (!isNaN(price)) {
                cachedTokenPrices[symbol] = { price, lastUpdated: now };
              }
            }
          }
        }
      }
    } catch (e) {
      // fix 4.6 — log errors instead of swallowing
      console.warn(`DexScreener fetch failed: ${e}`);
      hadError = true;
    }
  }

  // Track consecutive failures for backoff
  consecutiveFailures = hadError ? consecutiveFailures + 1 : 0;
}

export function trackToken(symbol: string, mint: string): void {
  if (!tokenMints[symbol] && mint) {
    console.log(`Tracking token: ${symbol} = ${mint}`);
    tokenMints[symbol] = mint;
    fetchPrices(true);
  }
}

// --- Broadcasting ---

export function broadcastState(state: any) {
  if (!wss) return;

  // Auto-track tokens from positions
  if (state.positions) {
    for (const pos of state.positions) {
      if (pos.tokenXSymbol && pos.tokenXSymbol !== "SOL" && pos.tokenXMint) {
        trackToken(pos.tokenXSymbol, pos.tokenXMint);
      }
      if (pos.tokenYSymbol && pos.tokenYSymbol !== "SOL" && pos.tokenYMint) {
        trackToken(pos.tokenYSymbol, pos.tokenYMint);
      }
    }
  }

  // Flatten token prices for broadcast (include staleness info)
  const tokenPricesFlat: Record<string, number> = {};
  for (const [sym, data] of Object.entries(cachedTokenPrices)) {
    tokenPricesFlat[sym] = data.price;
  }

  currentState = {
    ...state,
    solPrice: cachedSolPrice,
    solPriceUpdated: cachedSolPriceUpdated,
    tokenPrices: tokenPricesFlat,
    tokenPriceAge: Object.fromEntries(
      Object.entries(cachedTokenPrices).map(([sym, data]) => [
        sym,
        Date.now() - data.lastUpdated,
      ])
    ),
  };

  const data = JSON.stringify(currentState);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// --- Static file path resolution (fix 4.8) ---

function resolveWebDir(): string {
  // Try multiple paths to handle src/ vs dist/ execution
  const candidates = [
    path.join(__dirname, "../web"),
    path.join(__dirname, "../../web"),
    path.join(process.cwd(), "web"),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.existsSync(path.join(dir, "index.html"))) {
      return dir;
    }
  }

  console.warn("Web directory not found, static serving disabled. Tried:", candidates);
  return candidates[0]; // fallback, express will just 404
}

// --- Server (fix 4.4 — all initialization inside startWebServer) ---

export function startWebServer(port: number = 3000) {
  app = express();
  server = createServer(app);
  wss = new WebSocketServer({ server });

  // fix 4.7 — WebSocket heartbeat to clean dead connections
  const HEARTBEAT_INTERVAL = 30_000;
  const WS_TIMEOUT = 35_000;

  wss.on("connection", (ws: WebSocket & { isAlive?: boolean }) => {
    console.log("Web client connected");
    ws.isAlive = true;

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    if (currentState) {
      ws.send(JSON.stringify(currentState));
    }

    ws.on("close", () => console.log("Web client disconnected"));
  });

  heartbeatInterval = setInterval(() => {
    if (!wss) return;
    for (const client of wss.clients) {
      const ws = client as WebSocket & { isAlive?: boolean };
      if (ws.isAlive === false) {
        console.log("Terminating dead WebSocket connection");
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL);

  // Static files
  const webDir = resolveWebDir();
  app.use(express.static(webDir));

  // Start price fetching only when server starts
  fetchPrices();
  priceInterval = setInterval(() => fetchPrices(), PRICE_INTERVAL);

  // fix 4.1 — bind to localhost only
  const host = process.env.WEB_HOST || "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`Web dashboard: http://${host}:${port}`);
  });
}

export function stopWebServer() {
  if (priceInterval) clearInterval(priceInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (wss) wss.close();
  if (server) server.close();
  priceInterval = null;
  heartbeatInterval = null;
  wss = null;
  server = null;
  app = null;
}
