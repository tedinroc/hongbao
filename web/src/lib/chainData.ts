import { decodeEventLog, getAbiItem, getAddress, pad, toEventSelector, type Address, type Hex, type Log } from 'viem';
import { hongbaoAbi } from '../abi/hongbao';
import { musdAbi, priceFeedAbi } from '../abi/extra';
import { gaugeAbi, routerAbi, smusdAbi } from '../abi/mezo';
import { chainInfo, publicClient, type ChainId } from './chains';
import { getPacketApi, type PacketView } from './api';
import { HongbaoError } from './errors';

const ZERO: Address = '0x0000000000000000000000000000000000000000';

/** Mezo RPCs refuse eth_getLogs ranges wider than 10,000 blocks. */
const SPAN = 9_000n;
/** When config has no deployBlock, look back this many blocks (about 12 days on testnet). */
const DEFAULT_LOOKBACK = 250_000n;

export type Progress = (done: number, total: number) => void;

function hongbaoOf(chainId: ChainId): Address {
  const hb = chainInfo(chainId).hongbao;
  if (!hb) throw new HongbaoError('NotDeployed');
  return hb;
}

export function scanStart(chainId: ChainId, latest: bigint): bigint {
  const dep = chainInfo(chainId).deployBlock;
  if (dep > 0n) return dep;
  return latest > DEFAULT_LOOKBACK ? latest - DEFAULT_LOOKBACK : 0n;
}

function ranges(from: bigint, to: bigint): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += SPAN + 1n) {
    const b = a + SPAN > to ? to : a + SPAN;
    out.push([a, b]);
  }
  return out;
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

/** Run `fn` over [from, to] in RPC-sized chunks, a few at a time, keeping order. */
export async function scanChunks<T>(
  from: bigint,
  to: bigint,
  fn: (a: bigint, b: bigint) => Promise<T[]>,
  onProgress?: Progress,
  concurrency = 4,
): Promise<T[]> {
  if (to < from) return [];
  const rs = ranges(from, to);
  const results: T[][] = new Array(rs.length);
  let next = 0;
  let done = 0;
  onProgress?.(0, rs.length);
  const worker = async () => {
    while (next < rs.length) {
      const i = next++;
      const [a, b] = rs[i];
      results[i] = await withRetry(() => fn(a, b));
      done++;
      onProgress?.(done, rs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rs.length) }, worker));
  return results.flat();
}

/* ------------------------------------------------------------------ events */

const evCreated = getAbiItem({ abi: hongbaoAbi, name: 'PacketCreated' });
const evClaimed = getAbiItem({ abi: hongbaoAbi, name: 'Claimed' });
const evRefunded = getAbiItem({ abi: hongbaoAbi, name: 'Refunded' });

interface EventBase {
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}

export interface CreatedEvent extends EventBase {
  id: bigint;
  sender: Address;
  net: bigint;
  fee: bigint;
  shares: number;
  expiry: bigint;
  funding: number;
  claimKey: Address;
  attester: Address;
  message: string;
}

export interface ClaimedEvent extends EventBase {
  id: bigint;
  recipient: Address;
  relayer: Address;
  amount: bigint;
  payout: number;
}

export interface RefundedEvent extends EventBase {
  id: bigint;
  to: Address;
  amount: bigint;
  btcReturned: bigint;
  inKind: boolean;
}

function base(l: Log): EventBase {
  return { txHash: l.transactionHash as Hex, blockNumber: l.blockNumber ?? 0n, logIndex: l.logIndex ?? 0 };
}

function toCreated(l: Log, a: Record<string, unknown>): CreatedEvent {
  return {
    ...base(l),
    id: a.id as bigint,
    sender: a.sender as Address,
    net: a.net as bigint,
    fee: a.fee as bigint,
    shares: Number(a.shares),
    expiry: BigInt(a.expiry as bigint),
    funding: Number(a.funding),
    claimKey: a.claimKey as Address,
    attester: a.attester as Address,
    message: String(a.message ?? ''),
  };
}

function toClaimed(l: Log, a: Record<string, unknown>): ClaimedEvent {
  return {
    ...base(l),
    id: a.id as bigint,
    recipient: a.recipient as Address,
    relayer: a.relayer as Address,
    amount: a.amount as bigint,
    payout: Number(a.payout),
  };
}

function toRefunded(l: Log, a: Record<string, unknown>): RefundedEvent {
  return {
    ...base(l),
    id: a.id as bigint,
    to: a.to as Address,
    amount: a.amount as bigint,
    btcReturned: a.btcReturned as bigint,
    inKind: Boolean(a.inKind),
  };
}

export interface HongbaoEvents {
  created: CreatedEvent[];
  claimed: ClaimedEvent[];
  refunded: RefundedEvent[];
  fromBlock: bigint;
  toBlock: bigint;
}

const eventCache = new Map<ChainId, HongbaoEvents>();

/** Every PacketCreated / Claimed / Refunded event; incremental after the first call. */
export async function loadHongbaoEvents(chainId: ChainId, onProgress?: Progress): Promise<HongbaoEvents> {
  const pc = publicClient(chainId);
  const address = hongbaoOf(chainId);
  const latest = await pc.getBlockNumber();
  const cached = eventCache.get(chainId);
  const from = cached ? cached.toBlock + 1n : scanStart(chainId, latest);
  const acc: HongbaoEvents = cached
    ? { ...cached, created: [...cached.created], claimed: [...cached.claimed], refunded: [...cached.refunded] }
    : { created: [], claimed: [], refunded: [], fromBlock: from, toBlock: from - 1n };
  const logs = await scanChunks(
    from,
    latest,
    (a, b) => pc.getLogs({ address, events: [evCreated, evClaimed, evRefunded], fromBlock: a, toBlock: b }),
    onProgress,
  );
  for (const l of logs) {
    const args = (l as unknown as { args: Record<string, unknown> }).args;
    if (l.eventName === 'PacketCreated') acc.created.push(toCreated(l, args));
    else if (l.eventName === 'Claimed') acc.claimed.push(toClaimed(l, args));
    else if (l.eventName === 'Refunded') acc.refunded.push(toRefunded(l, args));
  }
  acc.toBlock = latest;
  eventCache.set(chainId, acc);
  return acc;
}

/** Find one packet's PacketCreated event, newest blocks first (packets are usually recent). */
export async function findPacketCreated(chainId: ChainId, id: bigint): Promise<CreatedEvent | null> {
  const cached = eventCache.get(chainId)?.created.find((e) => e.id === id);
  if (cached) return cached;
  const pc = publicClient(chainId);
  const address = hongbaoOf(chainId);
  const latest = await pc.getBlockNumber();
  const start = scanStart(chainId, latest);
  for (let b = latest; b >= start; b -= SPAN + 1n) {
    const a = b - SPAN < start ? start : b - SPAN;
    const logs = await withRetry(() =>
      pc.getLogs({ address, event: evCreated, args: { id }, fromBlock: a, toBlock: b }),
    );
    if (logs.length) {
      const l = logs[0];
      return toCreated(l, l.args as Record<string, unknown>);
    }
    if (a === start) break;
  }
  return null;
}

/** Claims of one packet from its creation block on. */
export async function packetClaims(chainId: ChainId, id: bigint, fromBlock: bigint): Promise<ClaimedEvent[]> {
  const pc = publicClient(chainId);
  const address = hongbaoOf(chainId);
  const latest = await pc.getBlockNumber();
  const logs = await scanChunks(fromBlock, latest, (a, b) =>
    pc.getLogs({ address, event: evClaimed, args: { id }, fromBlock: a, toBlock: b }),
  );
  return logs.map((l) => toClaimed(l, l.args as Record<string, unknown>));
}

/** Packets a wallet created. */
export async function packetsBySender(chainId: ChainId, sender: Address, onProgress?: Progress): Promise<CreatedEvent[]> {
  const pc = publicClient(chainId);
  const address = hongbaoOf(chainId);
  const latest = await pc.getBlockNumber();
  const logs = await scanChunks(
    scanStart(chainId, latest),
    latest,
    (a, b) => pc.getLogs({ address, event: evCreated, args: { sender }, fromBlock: a, toBlock: b }),
    onProgress,
  );
  return logs.map((l) => toCreated(l, l.args as Record<string, unknown>));
}

/* ------------------------------------------------------------------ packet reads */

/** getPacket + nextShare straight from the chain. Null for an unknown id. */
export async function readPacketChain(chainId: ChainId, id: bigint): Promise<PacketView | null> {
  const pc = publicClient(chainId);
  const address = hongbaoOf(chainId);
  const [p, next] = await Promise.all([
    pc.readContract({ address, abi: hongbaoAbi, functionName: 'getPacket', args: [id] }),
    pc.readContract({ address, abi: hongbaoAbi, functionName: 'nextShare', args: [id] }),
  ]);
  if (p.sender === ZERO) return null;
  return {
    sender: p.sender,
    expiry: BigInt(p.expiry),
    sharesTotal: Number(p.sharesTotal),
    claimKey: p.claimKey,
    sharesLeft: Number(p.sharesLeft),
    refunded: p.refunded,
    attester: p.attester,
    dripPerShare: BigInt(p.dripPerShare),
    remaining: BigInt(p.remaining),
    tipPerShare: BigInt(p.tipPerShare),
    nextShare: next,
    message: null,
  };
}

/** Chain first; our API as a fallback when the RPC is unreachable. */
export async function readPacket(chainId: ChainId, id: bigint): Promise<PacketView | null> {
  try {
    return await readPacketChain(chainId, id);
  } catch (e) {
    if (e instanceof HongbaoError) throw e;
    try {
      return await getPacketApi(chainId, id);
    } catch (apiErr) {
      if (apiErr instanceof HongbaoError && apiErr.code === 'UnknownPacket') return null;
      throw e;
    }
  }
}

export async function isClaimed(chainId: ChainId, id: bigint, who: Address): Promise<boolean> {
  return publicClient(chainId).readContract({
    address: hongbaoOf(chainId),
    abi: hongbaoAbi,
    functionName: 'claimed',
    args: [id, who],
  });
}

export async function readStatsChain(chainId: ChainId) {
  const [packets, claims, volume, recipients, senders, open] = await publicClient(chainId).readContract({
    address: hongbaoOf(chainId),
    abi: hongbaoAbi,
    functionName: 'stats',
  });
  return { packets, claims, volume, recipients, senders, open };
}

export async function readFeeBps(chainId: ChainId): Promise<bigint> {
  return publicClient(chainId).readContract({ address: hongbaoOf(chainId), abi: hongbaoAbi, functionName: 'feeBps' });
}

/* ------------------------------------------------------------------ balances */

export interface Balances {
  btc: bigint;
  musd: bigint;
  smusd: bigint;
  staked: bigint;
  earned: bigint;
  /** MEZO per second this account earns now (for the live counter). */
  ratePerSec: bigint;
  pendingBtc: bigint;
}

export async function readBalances(chainId: ChainId, who: Address): Promise<Balances> {
  const pc = publicClient(chainId);
  const a = chainInfo(chainId).addresses;
  const hb = chainInfo(chainId).hongbao;
  const [btc, musd, smusd, staked, earned, rewardRate, totalStaked, periodFinish, pendingBtc] = await Promise.all([
    pc.getBalance({ address: who }),
    pc.readContract({ address: a.musd, abi: musdAbi, functionName: 'balanceOf', args: [who] }),
    pc.readContract({ address: a.smusd, abi: smusdAbi, functionName: 'balanceOf', args: [who] }),
    pc.readContract({ address: a.gauge, abi: gaugeAbi, functionName: 'balanceOf', args: [who] }),
    pc.readContract({ address: a.gauge, abi: gaugeAbi, functionName: 'earned', args: [who] }),
    pc.readContract({ address: a.gauge, abi: gaugeAbi, functionName: 'rewardRate' }).catch(() => 0n),
    pc.readContract({ address: a.gauge, abi: gaugeAbi, functionName: 'totalSupply' }).catch(() => 0n),
    pc.readContract({ address: a.gauge, abi: gaugeAbi, functionName: 'periodFinish' }).catch(() => 0n),
    hb
      ? pc.readContract({ address: hb, abi: hongbaoAbi, functionName: 'pendingBTC', args: [who] }).catch(() => 0n)
      : Promise.resolve(0n),
  ]);
  const active = BigInt(Math.floor(Date.now() / 1000)) < periodFinish;
  const ratePerSec = active && totalStaked > 0n ? (rewardRate * staked) / totalStaked : 0n;
  return { btc, musd, smusd, staked, earned, ratePerSec, pendingBtc };
}

/* ------------------------------------------------------------------ send context */

export interface SendContext {
  feeBps: bigint;
  maxPerPacket: bigint;
  maxOutstanding: bigint;
  outstanding: bigint;
  paused: boolean;
}

export async function readSendContext(chainId: ChainId): Promise<SendContext> {
  const pc = publicClient(chainId);
  const address = hongbaoOf(chainId);
  const [feeBps, maxPerPacket, maxOutstanding, outstanding, paused] = await Promise.all([
    pc.readContract({ address, abi: hongbaoAbi, functionName: 'feeBps' }),
    pc.readContract({ address, abi: hongbaoAbi, functionName: 'maxPerPacket' }),
    pc.readContract({ address, abi: hongbaoAbi, functionName: 'maxOutstanding' }),
    pc.readContract({ address, abi: hongbaoAbi, functionName: 'outstanding' }),
    pc.readContract({ address, abi: hongbaoAbi, functionName: 'creationPaused' }),
  ]);
  return { feeBps, maxPerPacket, maxOutstanding, outstanding, paused };
}

/** PriceFeed.fetchPrice(): MUSD per BTC (1e18). Null when the oracle is stale. */
export async function readBtcPrice(chainId: ChainId): Promise<bigint | null> {
  try {
    return await publicClient(chainId).readContract({
      address: chainInfo(chainId).addresses.priceFeed,
      abi: priceFeedAbi,
      functionName: 'fetchPrice',
    });
  } catch {
    return null;
  }
}

/** Tigris pool quote for BTC -> MUSD on the volatile pool Hongbao swaps through. */
export async function readPoolQuote(chainId: ChainId, btcIn: bigint): Promise<bigint | null> {
  if (btcIn <= 0n) return null;
  const a = chainInfo(chainId).addresses;
  try {
    const amounts = await publicClient(chainId).readContract({
      address: a.router,
      abi: routerAbi,
      functionName: 'getAmountsOut',
      args: [btcIn, [{ from: a.btc, to: a.musd, stable: false, factory: a.poolFactory }]],
    });
    return amounts[amounts.length - 1] ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ ledger */

export type FollowKind =
  | 'packet'
  | 'gaugeWithdraw'
  | 'gaugeClaim'
  | 'gaugeDeposit'
  | 'smusdWithdraw'
  | 'smusdDeposit';

export interface FollowUp {
  who: Address;
  kind: FollowKind;
  txHash: Hex;
  blockNumber: bigint;
  packetId?: bigint;
}

const SEL = {
  withdraw: toEventSelector('Withdraw(address,uint256)'),
  claimRewards: toEventSelector('ClaimRewards(address,uint256)'),
  gaugeDeposit: toEventSelector('Deposit(address,address,uint256)'),
  smusdDeposit: toEventSelector('Deposit(address,uint256)'),
};

interface RawLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
}

/**
 * Transactions that outside recipients sent themselves after their first claim:
 * gauge withdraw / getReward / deposit, sMUSD withdraw / deposit, or a new packet.
 * Every hit is checked against the transaction's `from`, so a contract acting on
 * someone's behalf (for example Hongbao staking for them) is never counted.
 */
export async function loadFollowUps(
  chainId: ChainId,
  ev: HongbaoEvents,
  isOutside: (a: Address) => boolean,
  onProgress?: Progress,
): Promise<FollowUp[]> {
  const pc = publicClient(chainId);
  const a = chainInfo(chainId).addresses;
  const firstClaim = new Map<Address, bigint>();
  for (const c of ev.claimed) {
    const r = getAddress(c.recipient);
    if (!isOutside(r)) continue;
    const prev = firstClaim.get(r);
    if (prev === undefined || c.blockNumber < prev) firstClaim.set(r, c.blockNumber);
  }
  if (!firstClaim.size) return [];
  const out: FollowUp[] = [];

  for (const p of ev.created) {
    const s = getAddress(p.sender);
    const fc = firstClaim.get(s);
    if (fc !== undefined && p.blockNumber > fc) {
      out.push({ who: s, kind: 'packet', txHash: p.txHash, blockNumber: p.blockNumber, packetId: p.id });
    }
  }

  const claimTx = new Set(ev.claimed.map((c) => c.txHash));
  const who = [...firstClaim.keys()];
  const minBlock = who.reduce((m, w) => (firstClaim.get(w)! < m ? firstClaim.get(w)! : m), ev.toBlock);
  const candidates: FollowUp[] = [];
  for (let i = 0; i < who.length; i += 40) {
    const group = who.slice(i, i + 40);
    const topicAddrs = group.map((w) => pad(w.toLowerCase() as Hex, { size: 32 }));
    const logs = await scanChunks(
      minBlock,
      ev.toBlock,
      (from, to) =>
        pc.request({
          method: 'eth_getLogs',
          params: [
            {
              address: [a.gauge, a.smusd],
              fromBlock: `0x${from.toString(16)}`,
              toBlock: `0x${to.toString(16)}`,
              topics: [[SEL.withdraw, SEL.claimRewards, SEL.gaugeDeposit, SEL.smusdDeposit], topicAddrs],
            },
          ],
        }) as unknown as Promise<RawLog[]>,
      onProgress,
    );
    for (const l of logs) {
      if (claimTx.has(l.transactionHash)) continue;
      const isGauge = getAddress(l.address) === getAddress(a.gauge);
      let kind: FollowKind | null = null;
      let actor: Address | null = null;
      try {
        const d = decodeEventLog({ abi: isGauge ? gaugeAbi : smusdAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
        const args = d.args as Record<string, unknown>;
        actor = getAddress(String(args.from ?? args.user));
        if (isGauge) {
          kind = d.eventName === 'Withdraw' ? 'gaugeWithdraw' : d.eventName === 'ClaimRewards' ? 'gaugeClaim' : d.eventName === 'Deposit' ? 'gaugeDeposit' : null;
        } else {
          kind = d.eventName === 'Withdraw' ? 'smusdWithdraw' : d.eventName === 'Deposit' ? 'smusdDeposit' : null;
        }
      } catch {
        continue;
      }
      const bn = BigInt(l.blockNumber);
      const fc = actor ? firstClaim.get(actor) : undefined;
      if (!kind || !actor || fc === undefined || bn <= fc) continue;
      candidates.push({ who: actor, kind, txHash: l.transactionHash, blockNumber: bn });
    }
  }

  // Keep one entry per transaction, then confirm the recipient really sent it.
  const byTx = new Map<Hex, FollowUp>();
  for (const c of candidates) if (!byTx.has(c.txHash)) byTx.set(c.txHash, c);
  const list = [...byTx.values()].slice(0, 300);
  const checked = await Promise.all(
    list.map(async (c) => {
      try {
        const tx = await pc.getTransaction({ hash: c.txHash });
        return getAddress(tx.from) === c.who ? c : null;
      } catch {
        return null;
      }
    }),
  );
  for (const c of checked) if (c) out.push(c);
  return out.sort((x, y) => (x.blockNumber < y.blockNumber ? 1 : x.blockNumber > y.blockNumber ? -1 : 0));
}

const blockTimes = new Map<string, number>();

/** Unix seconds for a set of blocks (cached; capped to keep RPC use small). */
export async function blockTimestamps(chainId: ChainId, blocks: bigint[], cap = 120): Promise<Map<bigint, number>> {
  const pc = publicClient(chainId);
  const want = [...new Set(blocks.map((b) => b.toString()))].slice(0, cap);
  await Promise.all(
    want.map(async (b) => {
      const k = `${chainId}:${b}`;
      if (blockTimes.has(k)) return;
      try {
        const blk = await pc.getBlock({ blockNumber: BigInt(b) });
        blockTimes.set(k, Number(blk.timestamp));
      } catch {
        /* skip */
      }
    }),
  );
  const out = new Map<bigint, number>();
  for (const b of want) {
    const v = blockTimes.get(`${chainId}:${b}`);
    if (v !== undefined) out.set(BigInt(b), v);
  }
  return out;
}
