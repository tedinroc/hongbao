import { createPublicClient, defineChain, fallback, http, type Address, type Chain, type PublicClient, type Transport } from "viem";
import type { Env } from "./env";

export const SUPPORTED_CHAINS = [31611, 31612] as const;
export type ChainId = (typeof SUPPORTED_CHAINS)[number];

export function isSupportedChain(id: number): id is ChainId {
  return (SUPPORTED_CHAINS as readonly number[]).includes(id);
}

const DEFAULT_RPCS: Record<ChainId, string[]> = {
  31611: ["https://rpc.test.mezo.org"],
  31612: ["https://mainnet.mezo.public.validationcloud.io", "https://rpc-http.mezo.boar.network"],
};

const btc = { name: "Bitcoin", symbol: "BTC", decimals: 18 } as const;

export const CHAINS: Record<ChainId, Chain> = {
  31611: defineChain({
    id: 31611,
    name: "Mezo Testnet",
    nativeCurrency: btc,
    rpcUrls: { default: { http: DEFAULT_RPCS[31611] } },
    blockExplorers: { default: { name: "Mezo Explorer", url: "https://explorer.test.mezo.org" } },
    testnet: true,
  }),
  31612: defineChain({
    id: 31612,
    name: "Mezo",
    nativeCurrency: btc,
    rpcUrls: { default: { http: DEFAULT_RPCS[31612] } },
    blockExplorers: { default: { name: "Mezo Explorer", url: "https://explorer.mezo.org" } },
  }),
};

/** Mezo contracts per chain (SPEC.md "Chains" table). */
export const MEZO: Record<ChainId, { musd: Address; smusd: Address; gauge: Address; mezo: Address; btc: Address; router: Address; poolFactory: Address; priceFeed: Address }> = {
  31611: {
    musd: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
    smusd: "0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16",
    gauge: "0xA6972f35550717280f2538EA77638B29073e3F07",
    mezo: "0x7B7c000000000000000000000000000000000001",
    btc: "0x7b7C000000000000000000000000000000000000",
    router: "0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9",
    poolFactory: "0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A",
    priceFeed: "0x86bCF0841622a5dAC14A313a15f96A95421b9366",
  },
  31612: {
    musd: "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186",
    smusd: "0xb4D498029af77680cD1eF828b967f010d06C51CC",
    gauge: "0x677817bF3e44b90E8F95222F75e2950b7904a401",
    mezo: "0x7B7c000000000000000000000000000000000001",
    btc: "0x7b7C000000000000000000000000000000000000",
    router: "0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706",
    poolFactory: "0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248",
    priceFeed: "0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88",
  },
};

/** Mezo RPCs refuse eth_getLogs spans wider than 10,000 blocks. */
export const LOG_WINDOW = 9_999n;

export function rpcUrls(env: Env, id: ChainId): string[] {
  const raw = id === 31611 ? env.RPC_31611 : env.RPC_31612;
  if (raw) {
    const urls = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\/[^\s]+$/i.test(s));
    if (urls.length) return urls;
  }
  return DEFAULT_RPCS[id];
}

const clientCache = new Map<string, PublicClient>();

export function publicClient(env: Env, id: ChainId): PublicClient {
  const urls = rpcUrls(env, id);
  const cacheKey = `${id}|${urls.join(",")}`;
  const hit = clientCache.get(cacheKey);
  if (hit) return hit;
  // Batch JSON-RPC calls issued together (all Mezo RPCs accept batches): fewer
  // subrequests, less latency and less CPU per claim.
  const opts = { timeout: 12_000, retryCount: 1, batch: { wait: 0 } } as const;
  const transport: Transport = urls.length > 1 ? fallback(urls.map((u) => http(u, opts))) : http(urls[0], opts);
  const client = createPublicClient({ chain: CHAINS[id], transport }) as PublicClient;
  clientCache.set(cacheKey, client);
  return client;
}
