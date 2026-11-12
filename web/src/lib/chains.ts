import { createPublicClient, defineChain, fallback, getAddress, http, type Address, type Chain, type PublicClient } from 'viem';
import deploymentsJson from '../../../config/deployments.json';

/** Chain ids Hongbao knows about. */
export const TESTNET_ID = 31611 as const;
export const MAINNET_ID = 31612 as const;
export type ChainId = typeof TESTNET_ID | typeof MAINNET_ID;
export const CHAIN_IDS: readonly ChainId[] = [MAINNET_ID, TESTNET_ID];

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export const mezoTestnet = defineChain({
  id: TESTNET_ID,
  name: 'Mezo Testnet',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.test.mezo.org'] } },
  blockExplorers: { default: { name: 'Mezo Explorer', url: 'https://explorer.test.mezo.org' } },
  contracts: { multicall3: { address: MULTICALL3 } },
  testnet: true,
});

export const mezoMainnet = defineChain({
  id: MAINNET_ID,
  name: 'Mezo',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://mainnet.mezo.public.validationcloud.io', 'https://rpc-http.mezo.boar.network'],
    },
  },
  blockExplorers: { default: { name: 'Mezo Explorer', url: 'https://explorer.mezo.org' } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

/** Mezo contract addresses (SPEC.md, "Chains"). */
export interface MezoAddresses {
  musd: Address;
  smusd: Address;
  gauge: Address;
  mezo: Address;
  btc: Address;
  router: Address;
  poolFactory: Address;
  priceFeed: Address;
}

const MEZO_TOKEN = '0x7B7c000000000000000000000000000000000001' as const;
const BTC_TOKEN = '0x7b7C000000000000000000000000000000000000' as const;

const ADDRESSES: Record<ChainId, MezoAddresses> = {
  [TESTNET_ID]: {
    musd: '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503',
    smusd: '0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16',
    gauge: '0xA6972f35550717280f2538EA77638B29073e3F07',
    mezo: MEZO_TOKEN,
    btc: BTC_TOKEN,
    router: '0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9',
    poolFactory: '0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A',
    priceFeed: '0x86bCF0841622a5dAC14A313a15f96A95421b9366',
  },
  [MAINNET_ID]: {
    musd: '0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186',
    smusd: '0xb4D498029af77680cD1eF828b967f010d06C51CC',
    gauge: '0x677817bF3e44b90E8F95222F75e2950b7904a401',
    mezo: MEZO_TOKEN,
    btc: BTC_TOKEN,
    router: '0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706',
    poolFactory: '0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248',
    priceFeed: '0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88',
  },
};

interface DeploymentEntry {
  name?: string;
  hongbao: string | null;
  deployBlock: number | string | null;
  enabled: boolean;
}

const deployments = deploymentsJson as unknown as Partial<Record<string, DeploymentEntry>>;

export interface ChainInfo {
  id: ChainId;
  chain: Chain;
  /** i18n key for the human name. */
  nameKey: 'chain.testnet' | 'chain.mainnet';
  testnet: boolean;
  explorer: string;
  rpcUrls: readonly string[];
  addresses: MezoAddresses;
  /** Hongbao contract from config/deployments.json, or null before deploy. */
  hongbao: Address | null;
  /** First block worth scanning for Hongbao events. */
  deployBlock: bigint;
  /** Enabled in config and deployed. */
  enabled: boolean;
}

function toAddressOrNull(v: unknown): Address | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
  if (/^0x0{40}$/.test(v)) return null;
  return getAddress(v);
}

/**
 * Local QA only: the Vite dev server can point testnet at an anvil fork
 * (VITE_DEV_FORK_RPC, VITE_DEV_FORK_HONGBAO, VITE_DEV_FORK_FROM_BLOCK).
 * `import.meta.env.DEV` is false in `vite build`, so production always uses the
 * RPCs above and config/deployments.json.
 */
const devFork: { rpc: string; hongbao: string; fromBlock: string } | null =
  import.meta.env.DEV && import.meta.env.VITE_DEV_FORK_RPC
    ? {
        rpc: String(import.meta.env.VITE_DEV_FORK_RPC),
        hongbao: String(import.meta.env.VITE_DEV_FORK_HONGBAO ?? ''),
        fromBlock: String(import.meta.env.VITE_DEV_FORK_FROM_BLOCK ?? '0'),
      }
    : null;

function makeInfo(id: ChainId, baseChain: Chain): ChainInfo {
  const fork = id === TESTNET_ID ? devFork : null;
  const chain: Chain = fork ? { ...baseChain, rpcUrls: { default: { http: [fork.rpc] } } } : baseChain;
  const dep: DeploymentEntry | undefined = fork
    ? { hongbao: fork.hongbao, deployBlock: fork.fromBlock, enabled: true }
    : deployments[String(id)];
  const hongbao = toAddressOrNull(dep?.hongbao);
  const rawBlock = dep?.deployBlock;
  let deployBlock = 0n;
  if (typeof rawBlock === 'number' && Number.isFinite(rawBlock)) deployBlock = BigInt(Math.max(0, Math.floor(rawBlock)));
  else if (typeof rawBlock === 'string' && /^\d+$/.test(rawBlock)) deployBlock = BigInt(rawBlock);
  return {
    id,
    chain,
    nameKey: id === TESTNET_ID ? 'chain.testnet' : 'chain.mainnet',
    testnet: id === TESTNET_ID,
    explorer: chain.blockExplorers!.default.url,
    rpcUrls: chain.rpcUrls.default.http,
    addresses: ADDRESSES[id],
    hongbao,
    deployBlock,
    enabled: Boolean(dep?.enabled) && hongbao !== null,
  };
}

export const CHAINS: Record<ChainId, ChainInfo> = {
  [TESTNET_ID]: makeInfo(TESTNET_ID, mezoTestnet),
  [MAINNET_ID]: makeInfo(MAINNET_ID, mezoMainnet),
};

export function isChainId(n: unknown): n is ChainId {
  return n === TESTNET_ID || n === MAINNET_ID;
}

export function parseChainId(v: string | number | null | undefined): ChainId | null {
  const n = typeof v === 'number' ? v : Number(v);
  return isChainId(n) ? n : null;
}

export function chainInfo(id: ChainId): ChainInfo {
  return CHAINS[id];
}

/** Chains a user can act on right now (enabled and deployed). Mainnet first. */
export function enabledChains(): ChainInfo[] {
  return CHAIN_IDS.map((id) => CHAINS[id]).filter((c) => c.enabled);
}

/** The chain pages show by default: mainnet when live, else testnet. */
export function defaultChainId(): ChainId {
  const live = enabledChains();
  if (live.length) return live[0].id;
  const deployed = CHAIN_IDS.map((id) => CHAINS[id]).find((c) => c.hongbao);
  return deployed ? deployed.id : TESTNET_ID;
}

const clients = new Map<ChainId, PublicClient>();

/** One cached viem public client per chain; reads are batched through Multicall3. */
export function publicClient(id: ChainId): PublicClient {
  let c = clients.get(id);
  if (!c) {
    const info = CHAINS[id];
    // Mezo RPCs accept JSON-RPC batches (checked 2026-11-11), so group bursts of calls.
    const transports = info.rpcUrls.map((url) =>
      http(url, { timeout: 15_000, retryCount: 1, batch: { batchSize: 30, wait: 16 } }),
    );
    c = createPublicClient({
      chain: info.chain,
      transport: transports.length > 1 ? fallback(transports) : transports[0],
      batch: { multicall: { wait: 16 } },
      pollingInterval: 2_000,
    }) as PublicClient;
    clients.set(id, c);
  }
  return c;
}

export function txUrl(id: ChainId, hash: string): string {
  return `${CHAINS[id].explorer}/tx/${hash}`;
}

export function addressUrl(id: ChainId, address: string): string {
  return `${CHAINS[id].explorer}/address/${address}`;
}

/** Parameters for wallet_addEthereumChain (EIP-3085). */
export function addChainParams(id: ChainId) {
  const info = CHAINS[id];
  return {
    chainId: `0x${id.toString(16)}`,
    chainName: info.chain.name,
    nativeCurrency: info.chain.nativeCurrency,
    rpcUrls: [...info.rpcUrls],
    blockExplorerUrls: [info.explorer],
  };
}
