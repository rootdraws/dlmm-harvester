import * as fs from "fs";
import * as path from "path";

interface PositionIntent {
  pubkey: string;
  strategy: "SELL" | "BUY";
  savedAt: number;
}

export interface HarvestRecord {
  time: string;
  timestamp: number;
  label: string;
  tokenSymbol: string;
  amount: string;
  txSig: string;
}

interface State {
  positions: Record<string, PositionIntent>;
  harvests: HarvestRecord[];
  totalSol: number;
}

const STATE_FILE = path.join(process.cwd(), "data", "state.json");

// --- Mutex for read-modify-write safety ---
// Prevents parallel harvests from clobbering each other

let writeLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => T): Promise<T> {
  let release: () => void;
  const next = new Promise<void>((r) => (release = r));
  const prev = writeLock;
  writeLock = next;

  return prev.then(() => {
    try {
      const result = fn();
      return result;
    } finally {
      release!();
    }
  });
}

// --- File I/O ---

function ensureDataDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadState(): State {
  ensureDataDir();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        positions: parsed.positions || {},
        harvests: parsed.harvests || [],
        totalSol: parsed.totalSol || 0,
      };
    }
  } catch (e) {
    console.error("Failed to load state:", e);
  }
  return { positions: {}, harvests: [], totalSol: 0 };
}

function saveState(state: State): void {
  ensureDataDir();
  // Write to temp file first, then rename — atomic on most filesystems
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// --- Parse amount from formatted string ---
// "0.0234 SOL" → 0.0234, "150.50 USDC" → 150.50

function parseAmount(amountStr: string): number {
  const match = amountStr.match(/^([\d.]+)/);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  return isNaN(val) ? 0 : val;
}

// --- Public API ---

export function getPositionStrategy(pubkey: string): "SELL" | "BUY" | null {
  const state = loadState();
  return state.positions[pubkey]?.strategy || null;
}

export function setPositionStrategy(pubkey: string, strategy: "SELL" | "BUY"): void {
  return withLock(() => {
    const state = loadState();
    state.positions[pubkey] = {
      pubkey,
      strategy,
      savedAt: Date.now(),
    };
    saveState(state);
  }) as any; // fire-and-forget is fine for strategy saves
}

export function getAllPositionStrategies(): Record<string, "SELL" | "BUY"> {
  const state = loadState();
  const result: Record<string, "SELL" | "BUY"> = {};
  for (const [k, v] of Object.entries(state.positions)) {
    result[k] = v.strategy;
  }
  return result;
}

export async function addHarvest(harvest: HarvestRecord): Promise<void> {
  await withLock(() => {
    const state = loadState();

    state.harvests.unshift(harvest);
    if (state.harvests.length > 500) {
      state.harvests = state.harvests.slice(0, 500);
    }

    // Track SOL total
    if (harvest.tokenSymbol === "SOL" || harvest.tokenSymbol.includes("SOL")) {
      const amt = parseAmount(harvest.amount);
      if (amt > 0) {
        state.totalSol += amt;
      }
    }

    saveState(state);
  });
}

export function getHarvests(): HarvestRecord[] {
  const state = loadState();
  return state.harvests;
}

export function getTotalSol(): number {
  const state = loadState();
  return state.totalSol;
}
