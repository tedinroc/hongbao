/**
 * Front end <-> relayer integration on an anvil fork of Mezo testnet.
 *
 * The web app's own client code (getConfig, createPacket, signClaimWithLinkKey,
 * deviceId, postClaim, getPacketApi, getStatsApi and its error mapping) talks to
 * the real Pages Functions handlers, which talk to the fork. Nothing here
 * re-implements either side: if a field name, an error code, a chainId type or
 * the EIP-712 domain drifts between src/ and functions/, a test fails.
 *
 * Skipped unless VITE_FORK_RPC and VITE_FORK_HONGBAO are set:
 *
 *   VITE_FORK_RPC=http://127.0.0.1:8545 VITE_FORK_HONGBAO=0x... VITE_FORK_FROM_BLOCK=123 \
 *     npx vitest run integration
 *
 * By default `/api/*` requests go to the handlers in-process (Node). With
 * VITE_API_BASE=http://127.0.0.1:8788 they go over HTTP to `wrangler pages dev`,
 * which must serve the same fork with RELAYER_PRIVATE_KEY = anvil #2 and
 * ATTESTER_PRIVATE_KEY = anvil #3 (scripts/e2e-fork.sh does this).
 *
 * Accounts: relayer and attester are anvil default-mnemonic #2 and #3 (public
 * test keys); the sender and every recipient are fresh random keys. No key is
 * printed or sent anywhere except, in-process, to the handler as its env.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestClient,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

// Front end
import { hongbaoAbi } from '../src/abi/hongbao';
import * as fe712 from '../src/lib/eip712';
import { deviceId, getConfig, getPacketApi, getStatsApi, postClaim, type ClaimRequest } from '../src/lib/api';
import { HongbaoError, errorCode, type ErrorCode } from '../src/lib/errors';
// Relayer (Pages Functions)
import * as fn712 from '../functions/_lib/eip712';
import type { Env } from '../functions/_lib/env';
import { handleClaim } from '../functions/api/claim';
import { handleConfig } from '../functions/api/config';
import { handlePacket } from '../functions/api/packet';
import { handleStats } from '../functions/api/stats';
import { onRequest as catchAll } from '../functions/api/[[catchall]]';

const FORK = import.meta.env.VITE_FORK_RPC as string | undefined;
const HB = import.meta.env.VITE_FORK_HONGBAO as Address | undefined;
const FROM_BLOCK = (import.meta.env.VITE_FORK_FROM_BLOCK as string | undefined) ?? '0';
const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/$/, '');

// Point the front end's testnet entry at the fork (same approach as src/e2e/fork.test.ts).
vi.mock('../src/lib/chains', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/chains')>();
  const fork = import.meta.env.VITE_FORK_RPC as string | undefined;
  if (!fork) return real;
  const { createPublicClient, http: h } = await import('viem');
  const client = createPublicClient({ chain: real.mezoTestnet, transport: h(fork), batch: { multicall: true } });
  const info = {
    ...real.CHAINS[31611],
    hongbao: import.meta.env.VITE_FORK_HONGBAO as Address,
    rpcUrls: [fork],
    chain: { ...real.mezoTestnet, rpcUrls: { default: { http: [fork] } } },
    deployBlock: BigInt((import.meta.env.VITE_FORK_FROM_BLOCK as string | undefined) ?? '0'),
    enabled: true,
  };
  return {
    ...real,
    CHAINS: { ...real.CHAINS, 31611: info },
    publicClient: (id: number) => (id === 31611 ? client : real.publicClient(id as 31612)),
    chainInfo: (id: number) => (id === 31611 ? info : real.chainInfo(id as 31612)),
  };
});

// The browser keeps the phone wallet and the device id in localStorage.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size;
  },
} as Storage;

const CHAIN = 31611 as const;
const E18 = 10n ** 18n;
const DRIP = 3_000_000_000_000n;
const TIP = 1_000_000_000_000n;
const MESSAGE = '恭喜發財 integration';
const MUSD: Address = '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const ORIGIN = API_BASE || 'https://hongbao.test';

const MNEMONIC = 'test test test test test test test test test test test junk'; // anvil default
const hdKey = (i: number) => toHex(mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey!) as Hex;
const relayerKey = hdKey(2);
const attesterKey = hdKey(3);
const RELAYER = privateKeyToAccount(relayerKey).address;
const ATTESTER = privateKeyToAccount(attesterKey).address;

const env: Env = {
  RELAYER_PRIVATE_KEY: relayerKey,
  ATTESTER_PRIVATE_KEY: attesterKey,
  RPC_31611: FORK,
  HONGBAO_31611: HB,
  DEPLOY_BLOCK_31611: FROM_BLOCK,
  // anvil suggests a >= 1 gwei tip (Mezo: ~16 wei), above the 1 gwei production cap.
  MAX_FEE_PER_GAS_WEI: '5000000000',
};

/* ------------------------------------------------------------------ /api transport */

type Handler = (ctx: { request: Request; env: Env }) => Promise<Response>;
const routes: Record<string, Handler> = {
  '/api/config': handleConfig,
  '/api/claim': handleClaim,
  '/api/packet': handlePacket,
  '/api/stats': handleStats,
};

/** The client IP Cloudflare would report for the current "phone". */
let currentIp = '198.51.100.1';
const realFetch = globalThis.fetch;

/**
 * The front end calls fetch('/api/...') with relative paths. Route those to the
 * handlers (or to wrangler), adding what a same-origin browser request and
 * Cloudflare's edge add: Origin on POST, Sec-Fetch-Site, CF-Connecting-IP.
 * Everything else (the front end's RPC reads) goes to the real fetch.
 */
async function routedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('/api/')) return realFetch(input, init);
  const headers = new Headers(init?.headers);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') headers.set('origin', ORIGIN);
  headers.set('sec-fetch-site', 'same-origin');
  headers.set('cf-connecting-ip', currentIp);
  if (API_BASE) return realFetch(API_BASE + url, { ...init, headers });
  const request = new Request(ORIGIN + url, { ...init, headers });
  const handler = routes[new URL(request.url).pathname];
  if (handler) return handler({ request, env });
  return catchAll({ request, env } as unknown as Parameters<typeof catchAll>[0]);
}

/* ------------------------------------------------------------------ helpers */

interface Phone {
  key: Hex;
  address: Address;
  device: string;
  ip: string;
}

let phoneCount = 0;
/** A fresh phone: new wallet, new localStorage device id, its own IP. */
function newPhone(over: Partial<Phone> = {}): Phone {
  phoneCount++;
  store.delete('hongbao.device.v1');
  const key = generatePrivateKey();
  return {
    key,
    address: privateKeyToAccount(key).address,
    device: deviceId(),
    ip: `198.51.100.${10 + phoneCount}`,
    ...over,
  };
}

async function errOf(p: Promise<unknown>): Promise<{ code: ErrorCode; status?: number; detail?: string }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HongbaoError);
    const h = e as HongbaoError;
    return { code: errorCode(e), status: h.status, detail: h.detail };
  }
  throw new Error('expected the call to fail');
}

/** What the Claim page does after the tap: sign with the link key, POST, wait, read the event. */
async function claimLikeThePage(linkKey: Hex, id: bigint, phone: Phone, payout: fe712.PayoutValue) {
  currentIp = phone.ip;
  const { publicClient } = await import('../src/lib/chains');
  const keySig = await fe712.signClaimWithLinkKey(linkKey, CHAIN, HB!, id, phone.address, payout);
  const req: ClaimRequest = { chainId: CHAIN, packetId: id, recipient: phone.address, payout, keySig, device: phone.device };
  const { txHash } = await postClaim(req);
  const receipt = await publicClient(CHAIN).waitForTransactionReceipt({ hash: txHash, pollingInterval: 250 });
  expect(receipt.status).toBe('success');
  const ev = parseEventLogs({ abi: hongbaoAbi, logs: receipt.logs, eventName: 'Claimed' }).find(
    (l) => l.address.toLowerCase() === HB!.toLowerCase() && l.args.id === id,
  );
  expect(ev).toBeTruthy();
  return { txHash, receipt, amount: ev!.args.amount, paid: Number(ev!.args.payout), relayer: ev!.args.relayer };
}

/* ------------------------------------------------------------------ suite */

describe.skipIf(!FORK || !HB)(`front end ↔ relayer (${API_BASE ? 'HTTP via wrangler' : 'handlers in-process'})`, { timeout: 120_000 }, () => {
  const senderKey = generatePrivateKey();
  const sender = privateKeyToAccount(senderKey).address;
  const linkKey = generatePrivateKey();
  let packetId = 0n;
  let share = 0n;
  let phoneA: Phone;

  const anvil = () => createTestClient({ mode: 'anvil', transport: http(FORK) });

  beforeAll(async () => {
    globalThis.fetch = routedFetch as typeof fetch;
    await anvil().setBalance({ address: sender, value: E18 / 100n });
    // MUSD is OpenZeppelin ERC20: _balances is storage slot 0.
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [sender, 0n]));
    await anvil().setStorageAt({ address: MUSD, index: slot, value: `0x${(50n * E18).toString(16).padStart(64, '0')}` as Hex });
    const { BURNER_KEY } = await import('../src/lib/wallet');
    store.set(BURNER_KEY, JSON.stringify({ v: 1, privateKey: senderKey, createdAt: Date.now() }));
  }, 120_000);

  it('GET /api/config: the front end reads our Hongbao, relayer and attester', async () => {
    const cfg = await getConfig();
    const t = cfg.chains['31611'];
    expect(t?.hongbao).toBe(getAddress(HB!));
    expect(t?.relayer).toBe(RELAYER);
    expect(t?.attester).toBe(ATTESTER);
    expect(t?.enabled).toBe(true);
    expect(cfg.chains['31612']?.enabled).toBe(false);
  });

  it('EIP-712: both sides use the same types and domain, and both equal the contract digests', async () => {
    expect(fe712.CLAIM_TYPES).toEqual(fn712.CLAIM_TYPES);
    expect(fe712.ATTEST_TYPES).toEqual(fn712.ATTEST_TYPES);
    expect(fe712.hongbaoDomain(CHAIN, HB!)).toEqual(fn712.hongbaoDomain(CHAIN, HB!));

    const { publicClient } = await import('../src/lib/chains');
    const pc = publicClient(CHAIN);
    const who = privateKeyToAccount(generatePrivateKey()).address;
    for (const payout of [0, 1, 2] as const) {
      const fe = fe712.claimDigest(CHAIN, HB!, 77n, who, payout);
      const fn = hashTypedData({
        domain: fn712.hongbaoDomain(CHAIN, HB!),
        types: fn712.CLAIM_TYPES,
        primaryType: 'Claim',
        message: { packetId: 77n, recipient: who, payout },
      });
      const onChain = await pc.readContract({ address: HB!, abi: hongbaoAbi, functionName: 'claimDigest', args: [77n, who, payout] });
      expect(fe).toBe(fn);
      expect(fe).toBe(onChain);
    }
    const deadline = 1_900_000_000n;
    const feAttest = hashTypedData(fe712.attestTypedData(CHAIN, HB!, 77n, who, deadline));
    const onChainAttest = await pc.readContract({ address: HB!, abi: hongbaoAbi, functionName: 'attestDigest', args: [77n, who, deadline] });
    expect(feAttest).toBe(onChainAttest);
  });

  it('creates a one-per-person packet the way the Send page does (attester from /api/config)', async () => {
    const cfg = await getConfig();
    const { createPacket } = await import('../src/lib/actions');
    const { burnerHandle } = await import('../src/lib/wallet');
    const created = await createPacket(burnerHandle(sender), CHAIN, { kind: 'musd', amount: 3n * E18 }, {
      shares: 3,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400),
      claimKey: fe712.linkKeyAddress(linkKey),
      attester: cfg.chains['31611']!.attester!,
      dripPerShare: DRIP,
      tipPerShare: TIP,
      message: MESSAGE,
    });
    packetId = created.id;
    expect(created.net).toBe((3n * E18 * 99n) / 100n);
    share = created.net / 3n;
  });

  it('GET /api/packet through getPacketApi equals the chain read', async () => {
    const { readPacketChain } = await import('../src/lib/chainData');
    const api = await getPacketApi(CHAIN, packetId);
    const chain = await readPacketChain(CHAIN, packetId);
    expect(api).toEqual({ ...chain, message: MESSAGE });
    expect(api.attester).toBe(ATTESTER);
    expect(api.sharesLeft).toBe(3);
    expect(api.nextShare).toBe(share);
  });

  it('a claim signed by the front end is accepted and relayed (Earn MEZO)', async () => {
    phoneA = newPhone();
    const r = await claimLikeThePage(linkKey, packetId, phoneA, fe712.Payout.Stake);
    expect(r.amount).toBe(share);
    expect(r.paid).toBe(fe712.Payout.Stake);
    expect(r.relayer).toBe(RELAYER);
    const { readBalances, isClaimed } = await import('../src/lib/chainData');
    const b = await readBalances(CHAIN, phoneA.address);
    expect(b.staked).toBe(share);
    expect(b.btc).toBe(DRIP);
    expect(await isClaimed(CHAIN, packetId, phoneA.address)).toBe(true);
  });

  it('the same wallet again → AlreadyClaimed', async () => {
    const e = await errOf(claimLikeThePage(linkKey, packetId, { ...phoneA, device: newPhone().device, ip: '198.51.100.200' }, 0));
    expect(e.code).toBe('AlreadyClaimed');
    expect(e.status).toBe(409);
  });

  it('a new wallet on the same device → RateLimited (one per person)', async () => {
    const e = await errOf(claimLikeThePage(linkKey, packetId, newPhone({ device: phoneA.device }), 0));
    expect(e.code).toBe('RateLimited');
    expect(e.status).toBe(429);
  });

  it('a new device on the same IP → RateLimited (LIMIT_IP_PER_PACKET = 1)', async () => {
    const e = await errOf(claimLikeThePage(linkKey, packetId, newPhone({ ip: phoneA.ip }), 0));
    expect(e.code).toBe('RateLimited');
  });

  it('a link with the wrong key → BadSignature', async () => {
    const e = await errOf(claimLikeThePage(generatePrivateKey(), packetId, newPhone(), 0));
    expect(e.code).toBe('BadSignature');
    expect(e.status).toBe(400);
  });

  it('an unknown packet → UnknownPacket (claim and packet read)', async () => {
    const e = await errOf(claimLikeThePage(linkKey, 999_999n, newPhone(), 0));
    expect(e.code).toBe('UnknownPacket');
    const e2 = await errOf(getPacketApi(CHAIN, 999_999n));
    expect(e2.code).toBe('UnknownPacket');
  });

  it('mainnet (not enabled yet) → ChainDisabled', async () => {
    currentIp = '198.51.100.250';
    const e = await errOf(
      postClaim({ chainId: 31612, packetId: 1n, recipient: newPhone().address, payout: 0, keySig: `0x${'11'.repeat(65)}`, device: deviceId() }),
    );
    expect(e.code).toBe('ChainDisabled');
  });

  it('Cash and Save payouts reach new phones; then the packet is closed', async () => {
    const cash = newPhone();
    const r1 = await claimLikeThePage(linkKey, packetId, cash, fe712.Payout.Cash);
    expect(r1.paid).toBe(fe712.Payout.Cash);
    const save = newPhone();
    const r2 = await claimLikeThePage(linkKey, packetId, save, fe712.Payout.Save);
    expect(r2.paid).toBe(fe712.Payout.Save);
    const { readBalances } = await import('../src/lib/chainData');
    const bc = await readBalances(CHAIN, cash.address);
    const bs = await readBalances(CHAIN, save.address);
    expect(bc.musd).toBe(r1.amount);
    expect(bs.smusd).toBe(r2.amount);
    expect(r1.amount + r2.amount + share).toBe((3n * E18 * 99n) / 100n);
    const e = await errOf(claimLikeThePage(linkKey, packetId, newPhone(), 0));
    expect(e.code).toBe('PacketClosed');
  });

  it('GET /api/stats through getStatsApi equals the chain and the ledger’s own event scan', async () => {
    const { readStatsChain, loadHongbaoEvents } = await import('../src/lib/chainData');
    const [chain, ev] = await Promise.all([readStatsChain(CHAIN), loadHongbaoEvents(CHAIN)]);
    // Under wrangler the response may come from the 30 s edge cache; wait it out.
    let api = await getStatsApi(CHAIN);
    for (let i = 0; API_BASE && api.stats.claims !== chain.claims && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      api = await getStatsApi(CHAIN);
    }
    expect(api.stats).toEqual(chain);
    const apiClaims = api.recent
      .filter((e) => e.kind === 'claimed' && e.id === packetId)
      .map((e) => `${e.address}|${e.amount}|${e.payout}|${e.txHash}`)
      .sort();
    const chainClaims = ev.claimed
      .filter((e) => e.id === packetId)
      .map((e) => `${e.recipient}|${e.amount}|${e.payout}|${e.txHash}`)
      .sort();
    expect(apiClaims).toHaveLength(3);
    expect(apiClaims).toEqual(chainClaims);
    const created = api.recent.find((e) => e.kind === 'created' && e.id === packetId);
    expect(created?.address).toBe(sender);
    expect(created?.amount).toBe((3n * E18 * 99n) / 100n);
    expect(created?.shares).toBe(3);
  });

  it('/api/config carries addresses only, and unknown /api paths answer JSON (not the SPA page)', async () => {
    currentIp = '198.51.100.251';
    const res = await routedFetch('/api/nope');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('NotFound');
    const cfgText = (await (await routedFetch('/api/config')).text()).toLowerCase();
    expect(cfgText).not.toContain(relayerKey.slice(2).toLowerCase());
    expect(cfgText).not.toContain(attesterKey.slice(2).toLowerCase());
  });

  it('a packet without an attester (one-per-person off) is relayed too', async () => {
    const key = generatePrivateKey();
    const { createPacket } = await import('../src/lib/actions');
    const { burnerHandle } = await import('../src/lib/wallet');
    const created = await createPacket(burnerHandle(sender), CHAIN, { kind: 'musd', amount: E18 }, {
      shares: 2,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3_600),
      claimKey: fe712.linkKeyAddress(key),
      attester: ZERO,
      dripPerShare: DRIP,
      tipPerShare: TIP,
      message: 'open packet',
    });
    // Same device and IP twice is fine here: limits apply to one-per-person packets only.
    const phone = newPhone();
    const r = await claimLikeThePage(key, created.id, phone, fe712.Payout.Save);
    expect(r.paid).toBe(fe712.Payout.Save);
    const r2 = await claimLikeThePage(key, created.id, { ...newPhone(), device: phone.device, ip: phone.ip }, fe712.Payout.Cash);
    expect(r2.paid).toBe(fe712.Payout.Cash);
  });
});
