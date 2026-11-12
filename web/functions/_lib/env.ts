import type { Address, Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

/**
 * Cloudflare Pages bindings used by the relayer/attester.
 * Secrets: RELAYER_PRIVATE_KEY, ATTESTER_PRIVATE_KEY (set with `wrangler pages secret put`).
 * Everything else is optional.
 */
export interface Env {
  RELAYER_PRIVATE_KEY?: string;
  ATTESTER_PRIVATE_KEY?: string;
  /** KV namespace for rate limits. Without it limits live in per-isolate memory. */
  HB_LIMITS?: KVNamespace;
  /** RPC overrides (comma-separated list = fallback order), e.g. a local anvil fork in tests. */
  RPC_31611?: string;
  RPC_31612?: string;
  /** Hongbao address overrides (otherwise config/deployments.json). */
  HONGBAO_31611?: string;
  HONGBAO_31612?: string;
  /** Deploy block overrides (otherwise config/deployments.json); bounds event scans. */
  DEPLOY_BLOCK_31611?: string;
  DEPLOY_BLOCK_31612?: string;
  /** Extra origins allowed to POST (comma-separated), e.g. a local Vite dev server. Same-origin is always allowed. */
  ALLOWED_ORIGINS?: string;
  /** Rate limits for one-per-person packets (defaults from SPEC.md). */
  LIMIT_DEVICE_PER_PACKET?: string;
  LIMIT_IP_PER_PACKET?: string;
  LIMIT_IP_PER_HOUR?: string;
  /** Refuse to relay when the network asks more than this per gas (wei). Default 1 gwei. */
  MAX_FEE_PER_GAS_WEI?: string;
}

/** Minimal Pages context shape the handlers rely on (the real one has more). */
export interface Ctx {
  request: Request;
  env: Env;
  waitUntil?: (p: Promise<unknown>) => void;
}

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export interface Signer {
  address: Address;
  privateKey: Hex;
}

// Address derivation costs an EC multiplication; memoise per isolate.
const signerCache = new Map<string, Signer>();

function signerFrom(raw: string | undefined): Signer | null {
  if (!raw) return null;
  const key = raw.trim();
  if (!KEY_RE.test(key)) return null; // malformed: treat as not configured, never echo it
  let s = signerCache.get(key);
  if (!s) {
    s = { address: privateKeyToAddress(key as Hex), privateKey: key as Hex };
    signerCache.set(key, s);
  }
  return s;
}

export function relayerSigner(env: Env): Signer | null {
  return signerFrom(env.RELAYER_PRIVATE_KEY);
}

export function attesterSigner(env: Env): Signer | null {
  return signerFrom(env.ATTESTER_PRIVATE_KEY);
}

export function intVar(raw: string | undefined, fallback: number, min = 0, max = 1_000_000): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
