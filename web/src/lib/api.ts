import { getAddress, isAddress, parseUnits, type Address, type Hex } from 'viem';
import { HongbaoError, normalizeCode, type ErrorCode } from './errors';
import type { PayoutValue } from './eip712';

export { HongbaoError, errorCode, errorDetail } from './errors';

/* ------------------------------------------------------------------ types */

export interface ApiChainConfig {
  hongbao: Address | null;
  relayer: Address | null;
  attester: Address | null;
  enabled: boolean;
}

export interface ApiConfig {
  chains: Partial<Record<string, ApiChainConfig>>;
}

export interface StatsView {
  packets: bigint;
  claims: bigint;
  /** Net MUSD put into packets (wei). */
  volume: bigint;
  recipients: bigint;
  senders: bigint;
  /** sMUSD held for open packets (wei): MUSD waiting in Mezo savings. */
  open: bigint;
}

export type RecentKind = 'created' | 'claimed' | 'refunded';

export interface RecentEvent {
  kind: RecentKind;
  id: bigint;
  /** Sender for created, recipient for claimed, receiver for refunded. */
  address: Address | null;
  amount: bigint;
  txHash: Hex | null;
  blockNumber: bigint | null;
  timestamp: number | null;
  payout: number | null;
  shares: number | null;
}

export interface StatsPayload {
  stats: StatsView;
  recent: RecentEvent[];
  updatedAt: number | null;
}

export interface PacketView {
  sender: Address;
  expiry: bigint;
  sharesTotal: number;
  claimKey: Address;
  sharesLeft: number;
  refunded: boolean;
  attester: Address;
  dripPerShare: bigint;
  remaining: bigint;
  tipPerShare: bigint;
  nextShare: bigint;
  message: string | null;
}

export interface ClaimRequest {
  chainId: number;
  packetId: bigint;
  recipient: Address;
  payout: PayoutValue;
  keySig: Hex;
  device: string;
}

/* ------------------------------------------------------------------ helpers */

const ZERO: Address = '0x0000000000000000000000000000000000000000';

/** Integer counts: number, decimal string, hex string or bigint. */
export function toBigInt(v: unknown, fallback = 0n): bigint {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
    if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v.trim())) return BigInt(v.trim());
  } catch {
    /* fall through */
  }
  return fallback;
}

/**
 * Token amounts (18 decimals). Wei integers pass through. Values that are plainly
 * human units — a decimal point, or an integer below 1e12 (no real MUSD amount in
 * wei is that small: the minimum share is 1e16) — are scaled by 1e18.
 */
export function toAmount(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (!Number.isInteger(v) || Math.abs(v) < 1e12) return parseUnits(String(v), 18);
    return BigInt(Math.trunc(v));
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d+\.\d+$/.test(s)) return parseUnits(s, 18);
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
    if (/^\d+$/.test(s)) {
      const n = BigInt(s);
      return n !== 0n && n < 1_000_000_000_000n ? n * 10n ** 18n : n;
    }
  }
  return 0n;
}

function toAddr(v: unknown): Address | null {
  return typeof v === 'string' && isAddress(v, { strict: false }) ? getAddress(v) : null;
}

function toHash(v: unknown): Hex | null {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : null;
}

function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Normalize the six numbers of Hongbao.stats() from an object or a tuple. */
export function normalizeStats(v: unknown): StatsView {
  if (Array.isArray(v)) {
    const [packets, claims, volume, recipients, senders, open] = v;
    return {
      packets: toBigInt(packets),
      claims: toBigInt(claims),
      volume: toAmount(volume),
      recipients: toBigInt(recipients),
      senders: toBigInt(senders),
      open: toAmount(open),
    };
  }
  const o = asRecord(v) ?? {};
  return {
    packets: toBigInt(pick(o, 'packets', 'packetCount')),
    claims: toBigInt(pick(o, 'claims', 'totalClaims')),
    volume: toAmount(pick(o, 'volume', 'totalVolume')),
    recipients: toBigInt(pick(o, 'recipients', 'uniqueRecipients')),
    senders: toBigInt(pick(o, 'senders', 'uniqueSenders')),
    open: toAmount(pick(o, 'open', 'outstanding')),
  };
}

function normalizeRecent(v: unknown): RecentEvent | null {
  const o = asRecord(v);
  if (!o) return null;
  const args = asRecord(o.args) ?? {};
  const all = { ...args, ...o };
  const name = String(pick(all, 'kind', 'type', 'event', 'eventName', 'name') ?? '').toLowerCase();
  let kind: RecentKind | null = null;
  if (name.includes('claim')) kind = 'claimed';
  else if (name.includes('creat') || name.includes('packet')) kind = 'created';
  else if (name.includes('refund')) kind = 'refunded';
  if (!kind) return null;
  const address =
    kind === 'created'
      ? toAddr(pick(all, 'sender', 'from', 'address'))
      : kind === 'claimed'
        ? toAddr(pick(all, 'recipient', 'to', 'address'))
        : toAddr(pick(all, 'to', 'sender', 'address'));
  const ts = pick(all, 'timestamp', 'time', 'blockTime');
  let timestamp: number | null = null;
  if (typeof ts === 'number') timestamp = ts > 1e12 ? Math.floor(ts / 1000) : ts;
  else if (typeof ts === 'string' && /^\d+$/.test(ts)) timestamp = Number(ts);
  else if (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))) timestamp = Math.floor(Date.parse(ts) / 1000);
  const block = pick(all, 'blockNumber', 'block');
  const payoutRaw = pick(all, 'payout');
  const payout =
    typeof payoutRaw === 'string' && /^(stake|save|cash)$/i.test(payoutRaw)
      ? { stake: 0, save: 1, cash: 2 }[payoutRaw.toLowerCase() as 'stake' | 'save' | 'cash']
      : payoutRaw;
  const shares = pick(all, 'shares', 'sharesTotal');
  return {
    kind,
    id: toBigInt(pick(all, 'id', 'packetId')),
    address,
    amount: toAmount(pick(all, 'amount', 'net', 'value')),
    txHash: toHash(pick(all, 'txHash', 'transactionHash', 'hash', 'tx')),
    blockNumber: block === undefined ? null : toBigInt(block),
    timestamp,
    payout: payout === undefined ? null : Number(payout),
    shares: shares === undefined ? null : Number(shares),
  };
}

/**
 * Accepts `/api/stats` (`{stats, recent: {created, claimed, refunded}, block}`),
 * a flat `recent` array, or the snapshot file's per-chain entry.
 */
export function normalizeStatsPayload(v: unknown): StatsPayload {
  const o = asRecord(v) ?? {};
  const statsSrc = o.stats !== undefined ? o.stats : o;
  const recentSrc = pick(o, 'recent', 'events', 'activity');
  let rawEvents: unknown[] = [];
  if (Array.isArray(recentSrc)) {
    rawEvents = recentSrc;
  } else {
    const ro = asRecord(recentSrc);
    if (ro) {
      const tag = (list: unknown, kind: string) =>
        Array.isArray(list) ? list.map((e) => ({ ...(asRecord(e) ?? {}), kind })) : [];
      rawEvents = [...tag(ro.created, 'created'), ...tag(ro.claimed, 'claimed'), ...tag(ro.refunded, 'refunded')];
    }
  }
  const recent = rawEvents
    .map(normalizeRecent)
    .filter((e): e is RecentEvent => e !== null)
    .sort((a, b) => {
      const x = a.blockNumber ?? 0n;
      const y = b.blockNumber ?? 0n;
      return x < y ? 1 : x > y ? -1 : 0;
    });
  const blockTs = asRecord(o.block)?.timestamp;
  const up = pick(o, 'updatedAt', 'generatedAt', 'asOf', 'timestamp') ?? blockTs;
  let updatedAt: number | null = null;
  if (typeof up === 'number') updatedAt = up > 1e12 ? up : up * 1000;
  else if (typeof up === 'string' && !Number.isNaN(Date.parse(up))) updatedAt = Date.parse(up);
  return { stats: normalizeStats(statsSrc), recent, updatedAt };
}

/** Normalize `/api/packet` into the same shape as an on-chain read. */
export function normalizePacket(v: unknown): PacketView | null {
  const o = asRecord(v);
  if (!o) return null;
  const p = asRecord(o.packet) ?? o;
  const sender = toAddr(p.sender);
  if (!sender) return null;
  const msg = pick(o, 'message') ?? pick(p, 'message') ?? asRecord(o.created)?.message;
  return {
    sender,
    expiry: toBigInt(p.expiry),
    sharesTotal: Number(toBigInt(p.sharesTotal)),
    claimKey: toAddr(p.claimKey) ?? ZERO,
    sharesLeft: Number(toBigInt(p.sharesLeft)),
    refunded: p.refunded === true || p.refunded === 'true',
    attester: toAddr(p.attester) ?? ZERO,
    dripPerShare: toBigInt(p.dripPerShare),
    remaining: toBigInt(p.remaining),
    tipPerShare: toBigInt(p.tipPerShare),
    nextShare: toBigInt(pick(o, 'nextShare') ?? pick(p, 'nextShare')),
    message: typeof msg === 'string' ? msg : null,
  };
}

/** Turn an API error body into a known code (or Unknown with the server's text). */
export function apiErrorFrom(status: number, body: unknown): HongbaoError {
  const o = asRecord(body);
  const candidates: unknown[] = [];
  let detail = '';
  if (o) {
    const err = o.error;
    const eo = asRecord(err);
    // SimulationReverted carries the contract's own error name in `revert`; prefer it.
    if (typeof o.revert === 'string') candidates.push(o.revert);
    if (eo) {
      candidates.push(eo.code, eo.name, eo.errorName, eo.error);
      if (typeof eo.message === 'string') detail = eo.message;
    } else {
      candidates.push(err);
    }
    candidates.push(o.code, o.errorName, o.reason, o.name);
    if (!detail && typeof o.message === 'string') detail = o.message;
    if (!detail && typeof o.detail === 'string') detail = o.detail;
    if (!detail && typeof err === 'string' && !normalizeCode(err)) detail = err;
  } else if (typeof body === 'string') {
    detail = body.slice(0, 200);
  }
  let code: ErrorCode | null = null;
  for (const c of candidates) {
    code = normalizeCode(c);
    if (code) break;
  }
  if (!code && detail) {
    const m = detail.match(/\b([A-Z][A-Za-z0-9]+)\b/g) ?? [];
    for (const w of m) {
      code = normalizeCode(w);
      if (code) break;
    }
  }
  if (!code) {
    if (status === 429) code = 'RateLimited';
    else if (status === 400 || status === 422) code = 'BadRequest';
    else if (status === 404) code = 'NotDeployed';
    else if (status >= 500) code = 'RelayerUnavailable';
    else code = 'Unknown';
  }
  return new HongbaoError(code, detail || undefined, status);
}

async function request(path: string, init?: RequestInit, timeoutMs = 12_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      signal: ctrl.signal,
      headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    });
  } catch (e) {
    throw new HongbaoError('Network', e instanceof Error ? e.message : undefined);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!res.ok) throw apiErrorFrom(res.status, body);
  if (typeof body === 'string') {
    // An HTML page here means the API is not deployed (SPA fallback answered).
    throw new HongbaoError('RelayerUnavailable', 'The API did not answer with JSON.', res.status);
  }
  const ro = asRecord(body);
  if (ro && (ro.ok === false || (ro.error !== undefined && ro.error !== null && ro.txHash === undefined))) {
    throw apiErrorFrom(res.status, body);
  }
  return body;
}

/* ------------------------------------------------------------------ endpoints */

let configPromise: Promise<ApiConfig> | null = null;

/** GET /api/config (cached for the page's lifetime; a failure is not cached). */
export function getConfig(): Promise<ApiConfig> {
  if (!configPromise) {
    configPromise = request('/api/config')
      .then((body) => {
        const o = asRecord(body) ?? {};
        const chainsIn = asRecord(o.chains) ?? {};
        const chains: ApiConfig['chains'] = {};
        for (const [id, raw] of Object.entries(chainsIn)) {
          const c = asRecord(raw) ?? {};
          chains[id] = {
            hongbao: toAddr(c.hongbao),
            relayer: toAddr(c.relayer),
            attester: toAddr(c.attester),
            enabled: c.enabled === true,
          };
        }
        return { chains };
      })
      .catch((e) => {
        configPromise = null;
        throw e;
      });
  }
  return configPromise;
}

/** POST /api/claim. The link key is never part of this body; only its signature is. */
export async function postClaim(req: ClaimRequest): Promise<{ txHash: Hex }> {
  const body = {
    chainId: req.chainId,
    packetId: req.packetId <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(req.packetId) : req.packetId.toString(),
    recipient: req.recipient,
    payout: req.payout,
    keySig: req.keySig,
    device: req.device,
  };
  const res = await request('/api/claim', { method: 'POST', body: JSON.stringify(body) }, 45_000);
  const o = asRecord(res) ?? {};
  const txHash = toHash(pick(o, 'txHash', 'hash', 'transactionHash'));
  if (!txHash) throw new HongbaoError('RelayerUnavailable', 'No transaction hash in the response.');
  return { txHash };
}

/** GET /api/packet?chainId&id */
export async function getPacketApi(chainId: number, id: bigint): Promise<PacketView> {
  const body = await request(`/api/packet?chainId=${chainId}&id=${id.toString()}`);
  const p = normalizePacket(body);
  if (!p) throw new HongbaoError('UnknownPacket');
  return p;
}

/** GET /api/stats?chainId */
export async function getStatsApi(chainId: number): Promise<StatsPayload> {
  const body = await request(`/api/stats?chainId=${chainId}`);
  return normalizeStatsPayload(body);
}

/* ------------------------------------------------------------------ device id */

const DEVICE_KEY = 'hongbao.device.v1';

/** Random per-device id the relayer uses for its one-claim-per-device limit. */
export function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing && /^[0-9a-f]{32}$/.test(existing)) return existing;
  } catch {
    /* storage blocked */
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    localStorage.setItem(DEVICE_KEY, id);
  } catch {
    /* storage blocked: the id lives for this page only */
  }
  return id;
}
