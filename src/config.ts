import { PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config();

// Re-export for backward compat — all consumers should migrate to import from types.ts
export type { PositionConfig } from "./types";

// --- Helpers ---

function parsePubkey(raw: string, label: string): PublicKey {
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`Invalid pubkey for ${label}: "${raw}"`);
  }
}

function parseWatchPools(): PublicKey[] | null {
  const raw = process.env.WATCH_POOLS; // comma-separated pubkeys, or empty/unset = all
  if (!raw || raw.trim() === "") return null;
  return raw.split(",").map((s, i) => parsePubkey(s.trim(), `WATCH_POOLS[${i}]`));
}

function parseStrategyOverrides(): Record<string, "SELL" | "BUY"> {
  // Format: "pubkey1:SELL,pubkey2:BUY"
  const raw = process.env.STRATEGY_OVERRIDES;
  if (!raw || raw.trim() === "") return {};

  const overrides: Record<string, "SELL" | "BUY"> = {};
  for (const entry of raw.split(",")) {
    const [key, strat] = entry.trim().split(":");
    if (!key || !strat) continue;
    if (strat !== "SELL" && strat !== "BUY") {
      console.warn(`Invalid strategy override "${strat}" for ${key}, skipping`);
      continue;
    }
    // Validate the pubkey format
    parsePubkey(key, `STRATEGY_OVERRIDES`);
    overrides[key] = strat;
  }
  return overrides;
}

function parseFallbackSymbols(): Record<string, string> {
  // Stable defaults that will never change
  const defaults: Record<string, string> = {
    "So11111111111111111111111111111111111111112": "SOL",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
  };

  // Additional symbols from env: "mint1:SYM1,mint2:SYM2"
  const raw = process.env.TOKEN_SYMBOLS;
  if (raw && raw.trim() !== "") {
    for (const entry of raw.split(",")) {
      const [mint, symbol] = entry.trim().split(":");
      if (mint && symbol) defaults[mint] = symbol;
    }
  }

  return defaults;
}

// --- Jupiter token list (fetched at runtime) ---

let jupiterTokens: Map<string, string> = new Map();
let jupiterLoaded = false;

export async function loadJupiterTokenList(): Promise<void> {
  try {
    const res = await fetch("https://token.jup.ag/all");
    if (!res.ok) throw new Error(`Jupiter API returned ${res.status}`);
    const tokens = (await res.json()) as Array<{ address: string; symbol: string }>;
    jupiterTokens = new Map(tokens.map((t) => [t.address, t.symbol]));
    jupiterLoaded = true;
    console.log(`Loaded ${jupiterTokens.size} tokens from Jupiter`);
  } catch (e) {
    console.warn(`Failed to load Jupiter token list, using fallbacks only: ${e}`);
  }
}

export function getTokenSymbol(mint: string): string {
  // Priority: fallback overrides > Jupiter > truncated address
  const fallback = CONFIG.fallbackSymbols[mint];
  if (fallback) return fallback;

  const jup = jupiterTokens.get(mint);
  if (jup) return jup;

  return mint.slice(0, 4) + "…" + mint.slice(-4);
}

export function isJupiterLoaded(): boolean {
  return jupiterLoaded;
}

// --- Config ---

export const CONFIG = {
  // null = watch all pools, PublicKey[] = watch specific pools only
  watchPools: parseWatchPools(),

  // key = position pubkey string, value = forced strategy
  strategyOverrides: parseStrategyOverrides(),

  // Stable token symbols + any from env — used as fallback when Jupiter is unavailable
  fallbackSymbols: parseFallbackSymbols(),
};
