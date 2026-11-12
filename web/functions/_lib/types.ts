/**
 * Response shapes of /api/* (importable by the web app as types only).
 * All uint256 amounts are decimal strings in wei (MUSD/sMUSD/BTC: 18 decimals).
 * Every error is `{ error: <code>, message: <English fallback>, ...extra }`
 * where <code> is a contract custom-error name (AlreadyClaimed, Expired, ...)
 * or a relayer code (RateLimited, ForeignAttester, ...); see _lib/errors.ts.
 */
import type { Address, Hex } from "viem";
import type { ClaimedEvent, CreatedEvent, RefundedEvent } from "./logs";

export type { ClaimedEvent, CreatedEvent, RefundedEvent };

export interface ApiChainConfig {
  chainId: number;
  name: string;
  hongbao: Address | null;
  relayer: Address | null;
  attester: Address | null;
  enabled: boolean;
  deployBlock: number | null;
}

/** GET /api/config */
export interface ApiConfig {
  chains: Record<"31611" | "31612", ApiChainConfig>;
}

/** POST /api/claim body */
export interface ApiClaimRequest {
  chainId: number;
  packetId: number | string;
  recipient: Address;
  /** 0 Stake, 1 Save, 2 Cash */
  payout: 0 | 1 | 2;
  /** EIP-712 Claim(packetId, recipient, payout) signed by the link key */
  keySig: Hex;
  /** random per-browser id (8-64 chars [A-Za-z0-9_-]); required for one-per-person packets */
  device?: string;
}

/** POST /api/claim 200 */
export interface ApiClaimResponse {
  txHash: Hex;
  chainId: number;
  packetId: string;
  recipient: Address;
  relayer: Address;
  /** true when our attester co-signed (one-per-person packet) */
  attested: boolean;
  /** from the pre-send simulation; the Claimed event is authoritative */
  expected: { amount: string; payout: "Stake" | "Save" | "Cash" };
}

export type PacketStatus = "open" | "empty" | "expired" | "refunded";

/** GET /api/packet?chainId=&id=[&recipient=] */
export interface ApiPacket {
  chainId: number;
  id: string;
  hongbao: Address;
  status: PacketStatus;
  packet: {
    sender: Address;
    expiry: number;
    sharesTotal: number;
    claimKey: Address;
    sharesLeft: number;
    refunded: boolean;
    attester: Address;
    dripPerShare: string;
    remaining: string;
    tipPerShare: string;
  };
  nextShare: string;
  /** "ours" = one-per-person via this site; "none" = anyone with the link; "foreign" = cannot be relayed here */
  attesterMode: "ours" | "none" | "foreign";
  /** present when ?recipient= was given */
  claimedBy?: boolean;
  /** PacketCreated event (message etc.), null if not found in the scanned range */
  created: CreatedEvent | null;
  block: { number: number; timestamp: number };
}

/** GET /api/stats?chainId= */
export interface ApiStats {
  chainId: number;
  hongbao: Address;
  stats: { packets: string; claims: string; volume: string; recipients: string; senders: string; open: string };
  recent: { created: CreatedEvent[]; claimed: ClaimedEvent[]; refunded: RefundedEvent[]; fromBlock: number; toBlock: number };
  block: { number: number; timestamp: number };
}

export interface ApiErrorBody {
  error: string;
  message: string;
  [k: string]: unknown;
}
