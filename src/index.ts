import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  Commitment,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import DLMM from "@meteora-ag/dlmm";
import { BN } from "@coral-xyz/anchor";
import bs58 from "bs58";
import dotenv from "dotenv";
import { CONFIG, getTokenSymbol, loadJupiterTokenList } from "./config";
import { PositionConfig } from "./types";
import { Dashboard } from "./dashboard";
import {
  getPositionStrategy,
  setPositionStrategy,
  getAllPositionStrategies,
  addHarvest,
  getHarvests,
  getTotalSol,
} from "./persistence";
import { startWebServer, broadcastState } from "./web";

dotenv.config();

// --- Env validation (fix 3.11) ---

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("FATAL: RPC_URL not set in environment");
  process.exit(1);
}

let wallet: Keypair;
try {
  const raw = process.env.PRIVATE_KEY;
  if (!raw) throw new Error("PRIVATE_KEY not set");
  wallet = Keypair.fromSecretKey(bs58.decode(raw));
} catch (e: any) {
  console.error(`FATAL: Invalid PRIVATE_KEY — ${e.message}`);
  process.exit(1);
}

const BASE_POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30000");
const USE_DASHBOARD = process.env.DASHBOARD !== "false";
const WEB_PORT = parseInt(process.env.WEB_PORT || "3000");

// fix 3.13 — single commitment level used everywhere
const COMMITMENT: Commitment = "confirmed";

const MIN_SOL_LAMPORTS = 1_000_000;
const MIN_TOKEN_AMOUNT = 1_000_000;

// fix 3.9 — buffer in basis points, scaled per pool's bin step
const RANGE_BUFFER_BPS = 50; // 0.5% price buffer

const POLL_FAST = 5000;
const FAST_MODE_DURATION = 120000;

// fix 3.5 — retry helper with exponential backoff
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 1000;

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries: number = MAX_RETRIES
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      if (attempt < retries) {
        const delay = BASE_RETRY_DELAY * Math.pow(2, attempt);
        console.warn(`[retry] ${label} attempt ${attempt + 1} failed, retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// --- Types ---

interface PoolCache {
  dlmm: DLMM;
  activeId: number;
  binStep: number;
  tokenXMint: string;
  tokenYMint: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
}

interface DiscoveredPosition {
  config: PositionConfig;
  range: { lower: number; upper: number };
  priceRange: { lower: string; upper: string };
}

// --- Harvester ---

class Harvester {
  private connection: Connection;
  private wallet: Keypair;
  private pools: Map<string, PoolCache> = new Map();
  private positions: DiscoveredPosition[] = [];
  private lastActiveIds: Map<string, number> = new Map();
  private dashboard: Dashboard;

  // Adaptive polling
  private lastHarvestTime: number = 0;
  private currentPollInterval: number = BASE_POLL_INTERVAL;
  private pollTimer: NodeJS.Timeout | null = null;

  // fix 3.7 — idempotency: track in-flight withdrawals
  private inflight: Set<string> = new Set();

  // fix 3.12 — graceful shutdown
  private shuttingDown: boolean = false;

  constructor() {
    this.connection = new Connection(RPC_URL!, { commitment: COMMITMENT });
    this.wallet = wallet;
    this.dashboard = new Dashboard();

    // fix 3.12 — graceful shutdown handlers
    const shutdown = () => this.shutdown();
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  private async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log("Shutting down gracefully...");

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for in-flight withdrawals to settle
    if (this.inflight.size > 0) {
      this.log(`Waiting for ${this.inflight.size} in-flight withdrawal(s)...`);
      const deadline = Date.now() + 30_000;
      while (this.inflight.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    this.log("Shutdown complete.");
    process.exit(0);
  }

  log(msg: string) {
    if (!USE_DASHBOARD) console.log(msg);
  }

  // fix 3.9 — range buffer scales with bin step
  getRangeBuffer(binStep: number): number {
    return Math.max(1, Math.ceil(RANGE_BUFFER_BPS / binStep));
  }

  isInRange(activeId: number, range: { lower: number; upper: number }, binStep: number): boolean {
    const buffer = this.getRangeBuffer(binStep);
    return activeId >= (range.lower - buffer) && activeId <= (range.upper + buffer);
  }

  determineIntent(activeId: number, lowerBin: number, upperBin: number): "SELL" | "BUY" {
    if (lowerBin > activeId) return "SELL";
    if (upperBin < activeId) return "BUY";

    // fix 3.10 — warn on wide ranges where midpoint heuristic is fragile
    const rangeWidth = upperBin - lowerBin;
    if (rangeWidth > 100) {
      this.log(`  ⚠ Wide range (${rangeWidth} bins) — midpoint inference may be wrong. Consider using STRATEGY_OVERRIDES.`);
    }

    const midBin = (lowerBin + upperBin) / 2;
    return activeId < midBin ? "SELL" : "BUY";
  }

  // fix 3.2 — correct Meteora price calculation
  private binIdToPrice(activeId: number, binStep: number): string {
    // Meteora DLMM: price = (1 + binStep/10000) ^ (activeId - 8388608)
    const price = Math.pow(1 + binStep / 10000, activeId - 8388608);
    return String(price);
  }

  async discoverPositions() {
    this.log("Discovering positions...");

    const allPositions = await withRetry(
      () => DLMM.getAllLbPairPositionsByUser(this.connection, this.wallet.publicKey),
      "getAllLbPairPositionsByUser"
    );

    this.log(`Found ${allPositions.size} pools with positions`);

    this.positions = [];
    this.pools.clear();

    const persistedStrategies = getAllPositionStrategies();

    for (const [poolKey, positionInfo] of allPositions) {
      // Guard: SDK can return pool entries with null/empty position data
      if (!positionInfo?.lbPairPositionsData || positionInfo.lbPairPositionsData.length === 0) {
        this.log(`Pool ${poolKey.slice(0, 8)}... has no position data, skipping`);
        continue;
      }

      // fix: null = all pools (from config.ts changes)
      if (CONFIG.watchPools !== null) {
        const watching = CONFIG.watchPools.some((p) => p.toBase58() === poolKey);
        if (!watching) continue;
      }

      const poolPubkey = new PublicKey(poolKey);
      const activeId = positionInfo.lbPair.activeId;
      const tokenXMint = positionInfo.tokenX.mint.address.toBase58();
      const tokenYMint = positionInfo.tokenY.mint.address.toBase58();
      const tokenXSymbol = getTokenSymbol(tokenXMint);
      const tokenYSymbol = getTokenSymbol(tokenYMint);

      const dlmm = await withRetry(
        () => DLMM.create(this.connection, poolPubkey),
        `DLMM.create ${poolKey.slice(0, 8)}`
      );

      const binStep = dlmm.lbPair.binStep;

      // Get token decimals from the DLMM instance
      const tokenXDecimals = positionInfo.tokenX.mint.decimals;
      const tokenYDecimals = positionInfo.tokenY.mint.decimals;

      this.pools.set(poolKey, {
        dlmm,
        activeId,
        binStep,
        tokenXMint,
        tokenYMint,
        tokenXSymbol,
        tokenYSymbol,
        tokenXDecimals,
        tokenYDecimals,
      });

      this.lastActiveIds.set(poolKey, activeId);

      this.log(
        `Pool ${tokenXSymbol}/${tokenYSymbol} (step=${binStep}): ${positionInfo.lbPairPositionsData.length} positions`
      );

      for (const lbPosition of positionInfo.lbPairPositionsData) {
        const binData = lbPosition.positionData.positionBinData;
        if (binData.length === 0) continue;

        const sortedBins = [...binData].sort((a, b) => a.binId - b.binId);
        const lowerBin = sortedBins[0].binId;
        const upperBin = sortedBins[sortedBins.length - 1].binId;
        const lowerPrice = sortedBins[0].price;
        const upperPrice = sortedBins[sortedBins.length - 1].price;

        const posKey = lbPosition.publicKey.toBase58();
        let strategy: "SELL" | "BUY";

        // Priority: config override > persisted > inferred
        if (posKey in CONFIG.strategyOverrides) {
          strategy = CONFIG.strategyOverrides[posKey];
          this.log(`  Position ${posKey.slice(0, 8)}... [${strategy}] (override)`);
        } else if (persistedStrategies[posKey]) {
          strategy = persistedStrategies[posKey];
          this.log(`  Position ${posKey.slice(0, 8)}... [${strategy}] (persisted)`);
        } else {
          strategy = this.determineIntent(activeId, lowerBin, upperBin);
          setPositionStrategy(posKey, strategy);
          this.log(`  Position ${posKey.slice(0, 8)}... [${strategy}] (inferred, saved)`);
        }

        const config: PositionConfig = {
          pubkey: lbPosition.publicKey,
          poolPubkey,
          strategy,
          label: `${tokenXSymbol}/${tokenYSymbol}`,
          tokenXSymbol,
          tokenYSymbol,
        };

        const discovered: DiscoveredPosition = {
          config,
          range: { lower: lowerBin, upper: upperBin },
          priceRange: { lower: lowerPrice, upper: upperPrice },
        };

        this.positions.push(discovered);
        this.dashboard.initPosition(config, discovered.range, discovered.priceRange, tokenXDecimals, tokenYDecimals);
      }
    }

    this.log(`Total: ${this.positions.length} positions discovered`);
  }

  // fix 3.8 — batch ATA checks with getMultipleAccountsInfo
  async ensureATAs() {
    const mintEntries: { mintStr: string; mint: PublicKey }[] = [];
    const seen = new Set<string>();
    for (const pool of this.pools.values()) {
      for (const m of [pool.tokenXMint, pool.tokenYMint]) {
        if (!seen.has(m)) {
          seen.add(m);
          mintEntries.push({ mintStr: m, mint: new PublicKey(m) });
        }
      }
    }

    // Batch fetch all mint accounts to detect token program
    const mintAccounts = await withRetry(
      () => this.connection.getMultipleAccountsInfo(mintEntries.map((e) => e.mint)),
      "getMultipleAccountsInfo (mints)"
    );

    // Build ATA list
    const ataChecks: {
      mintStr: string;
      mint: PublicKey;
      ata: PublicKey;
      tokenProgramId: PublicKey;
    }[] = [];

    for (let i = 0; i < mintEntries.length; i++) {
      const { mintStr, mint } = mintEntries[i];
      const info = mintAccounts[i];
      if (!info) {
        this.log(`Mint not found: ${mintStr}`);
        continue;
      }
      const tokenProgramId = info.owner;
      const ata = await getAssociatedTokenAddress(mint, this.wallet.publicKey, false, tokenProgramId);
      ataChecks.push({ mintStr, mint, ata, tokenProgramId });
    }

    // Batch fetch all ATA accounts
    const ataAccounts = await withRetry(
      () => this.connection.getMultipleAccountsInfo(ataChecks.map((e) => e.ata)),
      "getMultipleAccountsInfo (ATAs)"
    );

    // Create missing ATAs
    for (let i = 0; i < ataChecks.length; i++) {
      if (!ataAccounts[i]) {
        const { mintStr, mint, ata, tokenProgramId } = ataChecks[i];
        this.log(`Creating ATA for ${getTokenSymbol(mintStr)}...`);
        const ix = createAssociatedTokenAccountInstruction(
          this.wallet.publicKey,
          ata,
          this.wallet.publicKey,
          mint,
          tokenProgramId
        );
        const tx = new Transaction().add(ix);
        await withRetry(
          () => sendAndConfirmTransaction(this.connection, tx, [this.wallet], { commitment: COMMITMENT }),
          `createATA ${mintStr.slice(0, 8)}`
        );
      }
    }
  }

  async getPositionBalances(dlmm: DLMM, positionPubkey: PublicKey) {
    const positions = await withRetry(
      () => dlmm.getPositionsByUserAndLbPair(this.wallet.publicKey),
      `getPositionBalances ${positionPubkey.toBase58().slice(0, 8)}`
    );
    const position = positions.userPositions.find(
      (p) => p.publicKey.toBase58() === positionPubkey.toBase58()
    );

    if (!position) {
      return { xBalance: 0n, yBalance: 0n, binsWithX: [] as number[], binsWithY: [] as number[] };
    }

    let xBalance = 0n,
      yBalance = 0n;
    const binsWithX: number[] = [],
      binsWithY: number[] = [];

    for (const bin of position.positionData.positionBinData) {
      const xAmt = BigInt(bin.positionXAmount);
      const yAmt = BigInt(bin.positionYAmount);
      xBalance += xAmt;
      yBalance += yAmt;
      if (xAmt > 0n) binsWithX.push(bin.binId);
      if (yAmt > 0n) binsWithY.push(bin.binId);
    }

    return { xBalance, yBalance, binsWithX, binsWithY };
  }

  // fix 3.1 — only withdraw from fully-converted bins (past the active bin)
  // SELL strategy: harvest Y from bins BELOW active bin (fully converted X→Y)
  // BUY strategy: harvest X from bins ABOVE active bin (fully converted Y→X)
  private getSafeWithdrawBins(
    strategy: "SELL" | "BUY",
    activeId: number,
    binsWithTarget: number[]
  ): number[] {
    if (strategy === "SELL") {
      // Y token accumulates in bins below active — those are fully converted
      return binsWithTarget.filter((binId) => binId < activeId);
    } else {
      // X token accumulates in bins above active — those are fully converted
      return binsWithTarget.filter((binId) => binId > activeId);
    }
  }

  async withdrawFromBins(
    dlmm: DLMM,
    positionPubkey: PublicKey,
    bins: number[],
    label: string,
    tokenSymbol: string,
    amount: bigint,
    decimals: number
  ): Promise<string | null> {
    const posKey = positionPubkey.toBase58();

    // fix 3.7 — idempotency guard
    if (this.inflight.has(posKey)) {
      this.log(`[${label}] Skipping — withdrawal already in-flight`);
      return null;
    }

    if (bins.length === 0) return null;

    this.inflight.add(posKey);

    try {
      const fromBinId = Math.min(...bins);
      const toBinId = Math.max(...bins);

      const transactions = await withRetry(
        () =>
          dlmm.removeLiquidity({
            user: this.wallet.publicKey,
            position: positionPubkey,
            fromBinId,
            toBinId,
            bps: new BN(10000), // 100% of these specific bins is safe — they're fully converted
            shouldClaimAndClose: false,
          }),
        `removeLiquidity ${label}`
      );

      let lastSig = "";
      for (const tx of transactions) {
        lastSig = await withRetry(
          () =>
            sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
              commitment: COMMITMENT,
            }),
          `sendTx ${label}`
        );
        this.log(`[${label}] Withdrawn: ${lastSig}`);
      }

      // fix 2.1/3.4 — correct amount formatting, no "M" suffix
      this.dashboard.logHarvest(label, tokenSymbol, Number(amount), decimals, lastSig);

      const adjusted = Number(amount) / Math.pow(10, decimals);
      const amountStr =
        decimals >= 9
          ? `${adjusted.toFixed(4)} ${tokenSymbol}`
          : `${adjusted.toFixed(2)} ${tokenSymbol}`;

      await addHarvest({
        time: new Date().toISOString(),
        timestamp: Date.now(),
        label,
        tokenSymbol,
        amount: amountStr,
        txSig: lastSig,
      }).catch((e: any) =>
        this.log(`Failed to persist harvest: ${e.message?.slice(0, 50) || "Unknown"}`)
      );

      this.lastHarvestTime = Date.now();
      this.adjustPollRate();

      return lastSig;
    } catch (error: any) {
      const msg = error.message?.slice(0, 50) || "Unknown";
      this.log(`[${label}] Failed: ${msg}`);
      this.dashboard.logError(`${label}: ${msg}`);
      return null;
    } finally {
      // fix 3.7 — always clear inflight, even on error
      this.inflight.delete(posKey);
    }
  }

  private adjustPollRate(): void {
    const timeSinceHarvest = Date.now() - this.lastHarvestTime;
    const shouldBeFast = this.lastHarvestTime > 0 && timeSinceHarvest < FAST_MODE_DURATION;
    const targetInterval = shouldBeFast ? POLL_FAST : BASE_POLL_INTERVAL;

    if (targetInterval !== this.currentPollInterval) {
      this.currentPollInterval = targetInterval;
      const modeStr = shouldBeFast ? "⚡ FAST MODE" : "normal";
      this.log(`Poll rate: ${targetInterval / 1000}s (${modeStr})`);

      this.dashboard.updatePollRate(targetInterval, shouldBeFast);

      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = setInterval(() => this.pollWithAdaptive(), this.currentPollInterval);
      }
    }
  }

  async checkAndHarvest(pos: DiscoveredPosition) {
    if (this.shuttingDown) return;

    const poolKey = pos.config.poolPubkey.toBase58();
    const pool = this.pools.get(poolKey);
    if (!pool) return;

    const { xBalance, yBalance, binsWithX, binsWithY } = await this.getPositionBalances(
      pool.dlmm,
      pos.config.pubkey
    );

    this.dashboard.updatePosition(pos.config.pubkey.toBase58(), Number(xBalance), Number(yBalance));

    const label = `${pos.config.label} ${pos.config.pubkey.toBase58().slice(0, 6)}`;

    // fix 3.1 — only withdraw fully-converted bins
    if (pos.config.strategy === "SELL" && yBalance > BigInt(MIN_SOL_LAMPORTS) && binsWithY.length > 0) {
      const safeBins = this.getSafeWithdrawBins("SELL", pool.activeId, binsWithY);
      if (safeBins.length > 0) {
        this.log(`[${label}] SELL triggered — harvesting ${pool.tokenYSymbol} from ${safeBins.length} safe bins`);
        await this.withdrawFromBins(
          pool.dlmm,
          pos.config.pubkey,
          safeBins,
          label,
          pool.tokenYSymbol,
          yBalance,
          pool.tokenYDecimals
        );
      }
    }

    if (pos.config.strategy === "BUY" && xBalance > BigInt(MIN_TOKEN_AMOUNT) && binsWithX.length > 0) {
      const safeBins = this.getSafeWithdrawBins("BUY", pool.activeId, binsWithX);
      if (safeBins.length > 0) {
        this.log(`[${label}] BUY triggered — harvesting ${pool.tokenXSymbol} from ${safeBins.length} safe bins`);
        await this.withdrawFromBins(
          pool.dlmm,
          pos.config.pubkey,
          safeBins,
          label,
          pool.tokenXSymbol,
          xBalance,
          pool.tokenXDecimals
        );
      }
    }
  }

  // fix 3.2 — correct price formula with offset
  async refreshPrices(): Promise<Map<string, { activeId: number; price: string }>> {
    const prices = new Map<string, { activeId: number; price: string }>();

    for (const [poolKey, pool] of this.pools) {
      try {
        await withRetry(() => pool.dlmm.refetchStates(), `refetchStates ${poolKey.slice(0, 8)}`);
        const activeId = pool.dlmm.lbPair.activeId;
        pool.activeId = activeId;

        const price = this.binIdToPrice(activeId, pool.binStep);
        prices.set(poolKey, { activeId, price });
      } catch (e) {
        this.log(`Failed to refresh ${poolKey.slice(0, 8)}`);
      }
    }

    return prices;
  }

  async run() {
    this.log(`Wallet: ${this.wallet.publicKey.toBase58()}`);

    // Load Jupiter token list before discovery
    await loadJupiterTokenList();

    await this.discoverPositions();

    if (this.positions.length === 0) {
      this.log("No positions found. Exiting.");
      return;
    }

    await this.ensureATAs();

    startWebServer(WEB_PORT);

    this.log(`\nStarting harvester (${BASE_POLL_INTERVAL / 1000}s base, ${POLL_FAST / 1000}s on activity)`);

    await this.pollAll();
    if (USE_DASHBOARD) this.dashboard.print();
    this.broadcastWebState();

    this.pollTimer = setInterval(() => this.pollWithAdaptive(), this.currentPollInterval);
  }

  private broadcastWebState() {
    const state = {
      activeId: this.dashboard.activeId,
      uptime: Date.now() - this.dashboard.startTime.getTime(),
      pollCount: this.dashboard.pollCount,
      harvestCount: getHarvests().length,
      totalSol: getTotalSol(),
      pollInterval: this.currentPollInterval,
      fastMode: this.currentPollInterval === POLL_FAST,
      positions: this.positions.map((pos) => {
        const dashPos = this.dashboard.positions.get(pos.config.pubkey.toBase58());
        const pool = this.pools.get(pos.config.poolPubkey.toBase58());
        return {
          pubkey: pos.config.pubkey.toBase58(),
          strategy: pos.config.strategy,
          label: pos.config.label,
          tokenXSymbol: pos.config.tokenXSymbol,
          tokenYSymbol: pos.config.tokenYSymbol,
          tokenXMint: pool?.tokenXMint || null,
          tokenYMint: pool?.tokenYMint || null,
          tokenXDecimals: pool?.tokenXDecimals || 6,
          tokenYDecimals: pool?.tokenYDecimals || 9,
          rangeLower: pos.range.lower,
          rangeUpper: pos.range.upper,
          priceLower: pos.priceRange.lower,
          priceUpper: pos.priceRange.upper,
          xBalance: dashPos?.xBalance || 0,
          yBalance: dashPos?.yBalance || 0,
          lastHarvest: dashPos?.lastHarvest || null,
        };
      }),
      harvests: getHarvests(),
      errors: this.dashboard.errors,
    };
    broadcastState(state);
  }

  private async pollWithAdaptive() {
    if (this.shuttingDown) return;
    await this.poll();
    if (USE_DASHBOARD) this.dashboard.print();
    this.broadcastWebState();

    if (this.currentPollInterval === POLL_FAST) {
      this.adjustPollRate();
    }
  }

  // fix 3.3 — update price for ALL pools, not just the first
  async pollAll() {
    const prices = await this.refreshPrices();

    for (const [_poolKey, priceData] of prices) {
      this.dashboard.updatePrice(priceData.activeId, priceData.price);
    }

    // fix 3.6 — parallel position checking grouped by pool
    const byPool = new Map<string, DiscoveredPosition[]>();
    for (const pos of this.positions) {
      const key = pos.config.poolPubkey.toBase58();
      if (!byPool.has(key)) byPool.set(key, []);
      byPool.get(key)!.push(pos);
    }

    // Process pools in parallel, positions within a pool in parallel
    const poolResults = await Promise.allSettled(
      [...byPool.values()].map(async (poolPositions) => {
        const results = await Promise.allSettled(
          poolPositions.map((pos) => this.checkAndHarvest(pos))
        );
        for (const r of results) {
          if (r.status === "rejected") {
            const pos = poolPositions[results.indexOf(r)];
            this.dashboard.logError(`${pos.config.label}: ${r.reason?.message?.slice(0, 40)}`);
          }
        }
      })
    );

    for (const r of poolResults) {
      if (r.status === "rejected") {
        this.dashboard.logError(`Pool error: ${r.reason?.message?.slice(0, 40)}`);
      }
    }
  }

  async poll() {
    try {
      const prices = await this.refreshPrices();

      // fix 3.3 — update all pool prices
      const affected: DiscoveredPosition[] = [];
      for (const pos of this.positions) {
        const poolKey = pos.config.poolPubkey.toBase58();
        const priceData = prices.get(poolKey);
        const lastActiveId = this.lastActiveIds.get(poolKey);
        const pool = this.pools.get(poolKey);

        if (!priceData || !pool) continue;

        const inRange = this.isInRange(priceData.activeId, pos.range, pool.binStep);
        const wasInRange =
          lastActiveId !== undefined && this.isInRange(lastActiveId, pos.range, pool.binStep);

        if (inRange || (wasInRange && !inRange)) {
          affected.push(pos);
        }
      }

      for (const [poolKey, priceData] of prices) {
        this.lastActiveIds.set(poolKey, priceData.activeId);
        this.dashboard.updatePrice(priceData.activeId, priceData.price);
      }

      if (affected.length > 0) {
        this.log(`Checking ${affected.length} positions in range...`);

        // fix 3.6 — parallel checking
        const results = await Promise.allSettled(
          affected.map((pos) => this.checkAndHarvest(pos))
        );
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status === "rejected") {
            this.dashboard.logError(
              `${affected[i].config.label}: ${r.reason?.message?.slice(0, 40)}`
            );
          }
        }
      }
    } catch (e: any) {
      this.dashboard.logError(`Poll: ${e.message?.slice(0, 50)}`);
    }
  }
}

new Harvester().run().catch(console.error);