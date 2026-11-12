import { getAddress, isAddress, type Address, type Hex } from "viem";
import { isSupportedChain, type ChainId } from "./chains";
import { ApiError } from "./errors";

const bad = (field: string, why: string) => new ApiError("BadRequest", 400, `${field}: ${why}`, { field });

const UINT256_MAX = (1n << 256n) - 1n;

export function parseChainId(v: unknown): ChainId {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,10}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n)) throw bad("chainId", "must be an integer");
  if (!isSupportedChain(n)) throw new ApiError("UnsupportedChain", 400, undefined, { field: "chainId" });
  return n;
}

export function parsePacketId(v: unknown, field = "packetId"): bigint {
  let id: bigint;
  if (typeof v === "number" && Number.isSafeInteger(v)) id = BigInt(v);
  else if (typeof v === "string" && /^\d{1,78}$/.test(v)) id = BigInt(v);
  else throw bad(field, "must be a positive integer");
  if (id < 1n || id > UINT256_MAX) throw bad(field, "out of range");
  return id;
}

export function parseAddress(v: unknown, field: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw bad(field, "must be a 0x address");
  // Lower-case is accepted; mixed case must carry a valid EIP-55 checksum.
  if (!isAddress(v, { strict: true })) throw bad(field, "bad checksum");
  return getAddress(v);
}

/** 0 Stake, 1 Save, 2 Cash. Accepts the numbers or the names. */
export function parsePayout(v: unknown): 0 | 1 | 2 {
  if (v === 0 || v === 1 || v === 2) return v;
  if (typeof v === "string") {
    const m: Record<string, 0 | 1 | 2> = { "0": 0, "1": 1, "2": 2, stake: 0, save: 1, cash: 2 };
    const r = m[v.toLowerCase()];
    if (r !== undefined) return r;
  }
  throw bad("payout", "must be 0 (Stake), 1 (Save) or 2 (Cash)");
}

/** 65-byte r||s||v ECDSA signature. */
export function parseSignature(v: unknown, field: string): Hex {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(v)) throw bad(field, "must be a 65-byte hex signature");
  return v.toLowerCase() as Hex;
}

/** Client device id (random, kept in localStorage). */
export function parseDevice(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) throw bad("device", "must be 8-64 chars of [A-Za-z0-9_-]");
  return v;
}

export function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ApiError("BadRequest", 400, "Body must be a JSON object.");
  return v as Record<string, unknown>;
}
