import { PublicKey } from "@solana/web3.js";

export interface PositionConfig {
  pubkey: PublicKey;
  poolPubkey: PublicKey;
  strategy: "SELL" | "BUY" | "AUTO";
  label: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
}
