import {
  createWalletClient,
  custom,
  fallback,
  getAddress,
  http,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
  type TransactionReceipt,
  type Transport,
  type TypedDataDefinition,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { addChainParams, chainInfo, publicClient, type ChainId } from './chains';
import { isPrivateKey } from './eip712';
import { HongbaoError } from './errors';

/* ------------------------------------------------------------------ burner wallet */

/** localStorage key for the wallet that lives on this phone. */
export const BURNER_KEY = 'hongbao.wallet.v1';

interface StoredBurner {
  v: 1;
  privateKey: Hex;
  createdAt: number;
  backedUpAt?: number;
}

function readStored(): StoredBurner | null {
  try {
    const raw = localStorage.getItem(BURNER_KEY);
    if (!raw) return null;
    if (isPrivateKey(raw)) return { v: 1, privateKey: raw, createdAt: 0 };
    const o = JSON.parse(raw) as Partial<StoredBurner>;
    if (o && isPrivateKey(o.privateKey)) {
      return { v: 1, privateKey: o.privateKey, createdAt: Number(o.createdAt ?? 0), backedUpAt: o.backedUpAt };
    }
  } catch {
    /* storage blocked or corrupt */
  }
  return null;
}

function writeStored(s: StoredBurner): void {
  localStorage.setItem(BURNER_KEY, JSON.stringify(s));
}

export interface BurnerInfo {
  address: Address;
  createdAt: number;
  backedUp: boolean;
}

export function loadBurner(): BurnerInfo | null {
  const s = readStored();
  if (!s) return null;
  return { address: privateKeyToAccount(s.privateKey).address, createdAt: s.createdAt, backedUp: Boolean(s.backedUpAt) };
}

/** Create the phone wallet if there is none. Throws if storage is unavailable. */
export function getOrCreateBurner(): BurnerInfo {
  const existing = loadBurner();
  if (existing) return existing;
  const privateKey = generatePrivateKey();
  writeStored({ v: 1, privateKey, createdAt: Date.now() });
  const check = readStored();
  if (!check || check.privateKey !== privateKey) throw new Error('This browser does not let us save a wallet.');
  return loadBurner()!;
}

/** Only for the explicit "Back up this wallet" screen. Never log or send the result. */
export function revealBurnerKey(): Hex | null {
  return readStored()?.privateKey ?? null;
}

export function markBurnerBackedUp(): void {
  const s = readStored();
  if (s) writeStored({ ...s, backedUpAt: Date.now() });
}

/** Replace the phone wallet with a backed-up key. */
export function importBurnerKey(key: string): BurnerInfo {
  const k = key.trim().toLowerCase();
  const normalized = (k.startsWith('0x') ? k : `0x${k}`) as Hex;
  if (!isPrivateKey(normalized)) throw new Error('invalid key');
  writeStored({ v: 1, privateKey: normalized, createdAt: Date.now(), backedUpAt: Date.now() });
  return loadBurner()!;
}

function burnerAccount(): Account {
  const s = readStored();
  if (!s) throw new HongbaoError('NoWallet');
  return privateKeyToAccount(s.privateKey);
}

/* ------------------------------------------------------------------ injected wallets (EIP-1193 / EIP-6963) */

export interface InjectedInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface InjectedDetail {
  info: InjectedInfo;
  provider: EIP1193Provider;
}

type LegacyProvider = EIP1193Provider & {
  isMetaMask?: boolean;
  isRabby?: boolean;
  isOkxWallet?: boolean;
  isCoinbaseWallet?: boolean;
  providers?: LegacyProvider[];
};

const announced = new Map<string, InjectedDetail>();
const providerListeners = new Set<() => void>();
let providerSnapshot: InjectedDetail[] = [];
let discoveryStarted = false;

function legacyName(p: LegacyProvider): string {
  if (p.isRabby) return 'Rabby';
  if (p.isOkxWallet) return 'OKX Wallet';
  if (p.isCoinbaseWallet) return 'Coinbase Wallet';
  if (p.isMetaMask) return 'MetaMask';
  return 'Browser wallet';
}

function recompute() {
  const list = [...announced.values()];
  if (!list.length && typeof window !== 'undefined') {
    const eth = (window as unknown as { ethereum?: LegacyProvider }).ethereum;
    if (eth && typeof eth.request === 'function') {
      list.push({ info: { uuid: 'legacy', name: legacyName(eth), icon: '', rdns: 'legacy' }, provider: eth });
    }
  }
  providerSnapshot = list;
  providerListeners.forEach((fn) => fn());
}

/** Start listening for EIP-6963 announcements (idempotent). */
export function startWalletDiscovery(): void {
  if (discoveryStarted || typeof window === 'undefined') return;
  discoveryStarted = true;
  window.addEventListener('eip6963:announceProvider', ((e: CustomEvent<InjectedDetail>) => {
    const d = e.detail;
    if (!d?.info?.uuid || typeof d.provider?.request !== 'function') return;
    announced.set(d.info.uuid, { info: { ...d.info }, provider: d.provider });
    recompute();
  }) as EventListener);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  recompute();
  // Some in-app browsers inject late.
  setTimeout(recompute, 600);
}

export function subscribeProviders(fn: () => void): () => void {
  providerListeners.add(fn);
  return () => providerListeners.delete(fn);
}

export function getProviders(): InjectedDetail[] {
  return providerSnapshot;
}

function rpcCode(e: unknown): number | undefined {
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; data?: { originalError?: { code?: unknown } } };
    if (typeof o.code === 'number') return o.code;
    const inner = o.data?.originalError?.code;
    if (typeof inner === 'number') return inner;
  }
  return undefined;
}

/** Ask the wallet for accounts (shows its connect prompt). */
export async function requestAccounts(p: EIP1193Provider): Promise<Address> {
  try {
    const accounts = (await p.request({ method: 'eth_requestAccounts' })) as string[];
    if (!accounts?.length) throw new HongbaoError('NoWallet');
    return getAddress(accounts[0]);
  } catch (e) {
    if (rpcCode(e) === 4001) throw new HongbaoError('UserRejected');
    throw e;
  }
}

/** Accounts already authorized for this site (no prompt). */
export async function silentAccounts(p: EIP1193Provider): Promise<Address | null> {
  try {
    const accounts = (await p.request({ method: 'eth_accounts' })) as string[];
    return accounts?.length ? getAddress(accounts[0]) : null;
  } catch {
    return null;
  }
}

/** Switch the wallet to `chainId`, adding the Mezo network first if the wallet does not know it. */
export async function ensureChain(p: EIP1193Provider, chainId: ChainId): Promise<void> {
  const hex = `0x${chainId.toString(16)}` as const;
  const current = (await p.request({ method: 'eth_chainId' })) as string;
  if (parseInt(current, 16) === chainId) return;
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    if (rpcCode(e) === 4001) throw new HongbaoError('UserRejected');
    try {
      await p.request({ method: 'wallet_addEthereumChain', params: [addChainParams(chainId)] });
    } catch (e2) {
      if (rpcCode(e2) === 4001) throw new HongbaoError('UserRejected');
      throw new HongbaoError('WrongChain', e2 instanceof Error ? e2.message : undefined);
    }
    const after = (await p.request({ method: 'eth_chainId' })) as string;
    if (parseInt(after, 16) !== chainId) {
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    }
  }
  const final = (await p.request({ method: 'eth_chainId' })) as string;
  if (parseInt(final, 16) !== chainId) throw new HongbaoError('WrongChain');
}

/* ------------------------------------------------------------------ one wallet interface for every page */

export type WalletKind = 'burner' | 'injected';

/** What Send, Me and the post-claim actions use to sign and send. */
export interface WalletHandle {
  kind: WalletKind;
  address: Address;
  /** Display name: the injected wallet's name; the phone wallet is labelled by the UI. */
  name: string;
  icon: string;
  /** A viem wallet client on `chainId` (an injected wallet is switched first). */
  client(chainId: ChainId): Promise<WalletClient<Transport, Chain, Account>>;
  signTypedData(chainId: ChainId, data: TypedDataDefinition): Promise<Hex>;
}

function rpcTransport(chainId: ChainId): Transport {
  const urls = chainInfo(chainId).rpcUrls;
  const ts = urls.map((u) => http(u, { timeout: 20_000 }));
  return ts.length > 1 ? fallback(ts) : ts[0];
}

export function burnerHandle(address: Address): WalletHandle {
  return {
    kind: 'burner',
    address,
    name: '',
    icon: '',
    async client(chainId) {
      const account = burnerAccount();
      if (account.address !== address) throw new HongbaoError('NoWallet', 'The wallet on this phone changed.');
      return createWalletClient({ account, chain: chainInfo(chainId).chain, transport: rpcTransport(chainId) });
    },
    async signTypedData(_chainId, data) {
      const account = burnerAccount();
      if (!account.signTypedData) throw new HongbaoError('NoWallet');
      return account.signTypedData(data);
    },
  };
}

export function injectedHandle(detail: InjectedDetail, address: Address): WalletHandle {
  const { provider } = detail;
  return {
    kind: 'injected',
    address,
    name: detail.info.name,
    icon: detail.info.icon,
    async client(chainId) {
      await ensureChain(provider, chainId);
      return createWalletClient({ account: address, chain: chainInfo(chainId).chain, transport: custom(provider) });
    },
    async signTypedData(chainId, data) {
      const wc = await this.client(chainId);
      return wc.signTypedData({ ...(data as TypedDataDefinition), account: wc.account });
    },
  };
}

/* ------------------------------------------------------------------ sending contract calls */

export interface ContractCall {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

/**
 * Simulate (so reverts come back as named errors before anything is signed),
 * send from the wallet, then wait for the receipt on our own public client.
 */
export async function sendContract(
  w: WalletHandle,
  chainId: ChainId,
  call: ContractCall,
  onHash?: (hash: Hex) => void,
): Promise<TransactionReceipt> {
  const pc = publicClient(chainId);
  const base = {
    address: call.address,
    abi: call.abi as Abi,
    functionName: call.functionName,
    args: call.args ?? [],
    ...(call.value !== undefined ? { value: call.value } : {}),
  };
  await pc.simulateContract({ ...base, account: w.address } as Parameters<typeof pc.simulateContract>[0]);
  const wc = await w.client(chainId);
  const hash = await wc.writeContract({
    ...base,
    account: wc.account,
    chain: wc.chain,
  } as Parameters<typeof wc.writeContract>[0]);
  onHash?.(hash);
  const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 1_500 });
  if (receipt.status !== 'success') throw new HongbaoError('Unknown', `Transaction ${hash} reverted.`);
  return receipt;
}
