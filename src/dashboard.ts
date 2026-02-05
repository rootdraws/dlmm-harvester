import { PositionConfig } from "./types";
import { EventEmitter } from "events";

interface PositionStatus {
  config: PositionConfig;
  range: { lower: number; upper: number } | null;
  priceRange: { lower: string; upper: string } | null;
  xBalance: number;
  yBalance: number;
  xDecimals: number;
  yDecimals: number;
  inRange: boolean;
  lastHarvest: string | null;
}

interface HarvestLog {
  time: string;
  label: string;
  type: string;
  amount: string;
  txSig: string;
}

function subscript(n: number): string {
  const subs = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
  return String(n).split('').map(d => subs[parseInt(d)]).join('');
}

// Deterministic time formatting — no locale variance (fix 2.4)
function formatTimestamp(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Events emitted:
 *   "harvest"  → { label, type, amount, txSig }
 *   "error"    → { message }
 *   "update"   → void (any state change — for external renderers)
 */
export class Dashboard extends EventEmitter {
  activeId: number = 0;
  activePrice: string = "0";
  positions: Map<string, PositionStatus> = new Map();
  harvests: HarvestLog[] = [];
  errors: string[] = [];
  startTime: Date = new Date();
  pollCount: number = 0;
  harvestCount: number = 0;
  pollInterval: number = 30000;
  fastMode: boolean = false;

  // Current Y-token price in USD for liquidity bar normalization (fix 2.2)
  yTokenPrice: number = 0;

  constructor() {
    super();
  }

  // fix 2.5 — position removal
  initPosition(
    config: PositionConfig,
    range: { lower: number; upper: number } | null,
    priceRange: { lower: string; upper: string } | null,
    xDecimals: number,
    yDecimals: number,
  ) {
    this.positions.set(config.pubkey.toBase58(), {
      config,
      range,
      priceRange,
      xBalance: 0,
      yBalance: 0,
      xDecimals,
      yDecimals,
      inRange: false,
      lastHarvest: null,
    });
    this.emit("update");
  }

  removePosition(pubkey: string) {
    this.positions.delete(pubkey);
    this.emit("update");
  }

  setYTokenPrice(price: number) {
    this.yTokenPrice = price;
  }

  updatePrice(activeId: number, activePrice?: string) {
    this.activeId = activeId;
    if (activePrice) this.activePrice = activePrice;
    this.pollCount++;

    for (const [_, pos] of this.positions) {
      if (pos.range) {
        pos.inRange = activeId >= pos.range.lower && activeId <= pos.range.upper;
      }
    }
    this.emit("update");
  }

  updatePosition(pubkey: string, xBalance: number, yBalance: number) {
    const pos = this.positions.get(pubkey);
    if (pos) {
      pos.xBalance = xBalance;
      pos.yBalance = yBalance;
      this.emit("update");
    }
  }

  updatePollRate(interval: number, fast: boolean) {
    this.pollInterval = interval;
    this.fastMode = fast;
  }

  logHarvest(label: string, type: string, amount: number, decimals: number, txSig: string) {
    const time = formatTimestamp();

    // fix 2.1 — use actual decimals, no misleading "M" suffix
    const adjusted = amount / Math.pow(10, decimals);
    const amountStr = decimals >= 9
      ? `${adjusted.toFixed(4)} ${type}`
      : `${adjusted.toFixed(2)} ${type}`;

    this.harvests.unshift({ time, label, type, amount: amountStr, txSig });
    this.harvestCount++;
    if (this.harvests.length > 20) this.harvests.pop();

    for (const [_, pos] of this.positions) {
      if (label.includes(pos.config.label)) {
        pos.lastHarvest = time;
      }
    }

    this.emit("harvest", { label, type, amount: amountStr, txSig });
    this.emit("update");
  }

  logError(msg: string) {
    const time = formatTimestamp();
    this.errors.unshift(`[${time}] ${msg}`);
    if (this.errors.length > 10) this.errors.pop();
    this.emit("error", { message: msg });
    this.emit("update");
  }

  private uptime(): string {
    const ms = Date.now() - this.startTime.getTime();
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${h}h ${m}m ${s}s`;
  }

  private formatPrice(price: string): string {
    const num = parseFloat(price);
    if (num === 0) return "0";
    if (num >= 0.01) return num.toFixed(4);
    
    const str = num.toFixed(20);
    const match = str.match(/^0\.(0+)([1-9]\d*)/);
    if (match) {
      const zeros = match[1].length;
      const significant = match[2].slice(0, 4);
      return `0.0${subscript(zeros)}${significant}`;
    }
    return num.toPrecision(4);
  }

  // fix 2.3 — decimals is now required, no silent default
  private formatBalance(balance: number, decimals: number): string {
    const val = balance / Math.pow(10, decimals);
    if (val >= 1000000) return (val / 1000000).toFixed(1) + "M";
    if (val >= 1000) return (val / 1000).toFixed(1) + "K";
    if (val >= 1) return val.toFixed(2);
    if (val > 0) return val.toFixed(4);
    return "—";
  }

  // fix 2.2 — uses actual Y token price instead of hardcoded $200
  private liquidityBar(xBal: number, yBal: number, xDec: number, yDec: number, w: number = 28): string {
    const xVal = xBal / Math.pow(10, xDec);
    const yPrice = this.yTokenPrice > 0 ? this.yTokenPrice : 1;
    const yVal = (yBal / Math.pow(10, yDec)) * yPrice;
    const total = xVal + yVal;
    
    if (total === 0) return "│" + " ".repeat(w) + "│";
    
    const xWidth = Math.min(w, Math.max(0, Math.round((xVal / total) * w)));
    const yWidth = w - xWidth;
    
    return "│" + "█".repeat(xWidth) + "░".repeat(yWidth) + "│";
  }

  private rangeBar(current: number, lower: number, upper: number, w: number = 28): string {
    if (current < lower) return "◄" + "─".repeat(w - 1) + " ";
    if (current > upper) return " " + "─".repeat(w - 1) + "►";
    
    const range = upper - lower;
    if (range === 0) return "│" + "─".repeat(w) + "│";
    
    const pos = Math.floor(((current - lower) / range) * w);
    const clampedPos = Math.max(0, Math.min(w - 1, pos));
    return " " + "─".repeat(clampedPos) + "▼" + "─".repeat(w - clampedPos - 1) + " ";
  }

  render(): string {
    const W = 74;
    const L: string[] = [];

    L.push("");
    L.push("  ┌" + "─".repeat(W - 4) + "┐");
    L.push("  │" + " DLMM HARVESTER".padEnd(W - 4) + "│");
    L.push("  ├" + "─".repeat(W - 4) + "┤");

    const up = this.uptime();
    const pollStr = this.fastMode ? `⚡${this.pollInterval/1000}s` : `${this.pollInterval/1000}s`;
    L.push("  │" + `  UP ${up.padEnd(12)} POLLS ${String(this.pollCount).padEnd(6)} HARVESTS ${this.harvestCount}  [${pollStr}]`.padEnd(W - 4) + "│");
    L.push("  ├" + "─".repeat(W - 4) + "┤");

    // Positions
    let posNum = 0;
    for (const [pubkey, p] of this.positions) {
      posNum++;
      const strat = p.config.strategy;
      const status = p.inRange ? "* ACTIVE *" : "  idle   ";
      const pair = p.config.label;
      const shortKey = pubkey.slice(0, 6);

      let rangeStr = "";
      if (p.priceRange) {
        rangeStr = `${this.formatPrice(p.priceRange.lower)} → ${this.formatPrice(p.priceRange.upper)}`;
      }

      L.push("  │" + ` ${posNum}. ${pair} [${strat}]`.padEnd(28) + `${rangeStr}`.padEnd(W - 32) + "│");
      L.push("  │" + `    ${shortKey}...`.padEnd(18) + `${status}`.padEnd(W - 22) + "│");

      const bar = this.liquidityBar(p.xBalance, p.yBalance, p.xDecimals, p.yDecimals);
      const xStr = this.formatBalance(p.xBalance, p.xDecimals);
      const yStr = this.formatBalance(p.yBalance, p.yDecimals);
      L.push("  │" + `    ${p.config.tokenXSymbol.padEnd(4)} ${bar} ${p.config.tokenYSymbol.padStart(4)}`.padEnd(W - 4) + "│");
      L.push("  │" + `    ${xStr.padEnd(10)}`.padEnd(20) + `${yStr.padStart(12)}`.padEnd(W - 24) + "│");

      if (p.range) {
        const rangeIndicator = this.rangeBar(this.activeId, p.range.lower, p.range.upper);
        L.push("  │" + `    lo ${rangeIndicator} hi`.padEnd(W - 4) + "│");
      }

      if (p.lastHarvest) {
        L.push("  │" + `    └─ last harvest: ${p.lastHarvest}`.padEnd(W - 4) + "│");
      }

      L.push("  │" + " ".repeat(W - 4) + "│");
    }

    // Harvest log
    L.push("  ├" + "─".repeat(W - 4) + "┤");
    L.push("  │" + " HARVEST LOG".padEnd(W - 4) + "│");

    if (this.harvests.length === 0) {
      L.push("  │" + "   waiting for fills...".padEnd(W - 4) + "│");
    } else {
      for (const h of this.harvests.slice(0, 5)) {
        const line = `   ${h.time}  ${h.amount.padEnd(16)} ${h.txSig.slice(0, 16)}...`;
        L.push("  │" + line.padEnd(W - 4) + "│");
      }
    }

    // Errors
    if (this.errors.length > 0) {
      L.push("  ├" + "─".repeat(W - 4) + "┤");
      L.push("  │" + " ERRORS".padEnd(W - 4) + "│");
      for (const e of this.errors.slice(0, 3)) {
        L.push("  │" + `   ${e.slice(0, W - 8)}`.padEnd(W - 4) + "│");
      }
    }

    L.push("  └" + "─".repeat(W - 4) + "┘");
    L.push("");

    return L.join("\n");
  }

  print() {
    console.clear();
    console.log(this.render());
  }
}
