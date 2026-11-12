import { encodeEventTopics, numberToHex, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { PAYOUTS, hongbaoAbi } from "./abi";
import { LOG_WINDOW } from "./chains";
import { Memo } from "./http";

export interface CreatedEvent {
  id: string;
  sender: Address;
  net: string;
  fee: string;
  shares: number;
  expiry: number;
  funding: "MUSD" | "BTC";
  claimKey: Address;
  attester: Address;
  message: string;
  blockNumber: number;
  txHash: Hex;
  timestamp: number | null;
}

export interface ClaimedEvent {
  id: string;
  recipient: Address;
  relayer: Address;
  amount: string;
  payout: "Stake" | "Save" | "Cash";
  blockNumber: number;
  txHash: Hex;
  timestamp: number | null;
}

export interface RefundedEvent {
  id: string;
  to: Address;
  amount: string;
  btcReturned: string;
  inKind: boolean;
  blockNumber: number;
  txHash: Hex;
  timestamp: number | null;
}

interface RpcLog {
  address: Address;
  topics: [Hex, ...Hex[]] | [];
  data: Hex;
  blockNumber: Hex | null;
  transactionHash: Hex | null;
  logIndex: Hex | null;
  blockTimestamp?: Hex;
  removed?: boolean;
}

async function rawLogs(client: PublicClient, address: Address, from: bigint, to: bigint, topics?: (Hex | Hex[] | null)[]) {
  return (await client.request({
    method: "eth_getLogs",
    params: [{ address, fromBlock: numberToHex(from), toBlock: numberToHex(to), ...(topics ? { topics } : {}) }],
  } as never)) as RpcLog[];
}

const num = (h: Hex | null | undefined) => (h ? Number(BigInt(h)) : 0);
const ts = (h: Hex | undefined) => (h ? Number(BigInt(h)) : null);

interface Decoded {
  created: CreatedEvent[];
  claimed: ClaimedEvent[];
  refunded: RefundedEvent[];
}

function decode(logs: RpcLog[]): Decoded {
  const out: Decoded = { created: [], claimed: [], refunded: [] };
  const live = logs.filter((l) => !l.removed && l.topics.length > 0);
  const parsed = parseEventLogs({ abi: hongbaoAbi, logs: live as never, strict: true });
  for (const p of parsed as unknown as (RpcLog & { eventName: string; args: Record<string, unknown> })[]) {
    const base = { blockNumber: num(p.blockNumber), txHash: p.transactionHash as Hex, timestamp: ts(p.blockTimestamp) };
    const a = p.args;
    if (p.eventName === "PacketCreated") {
      out.created.push({
        id: String(a.id),
        sender: a.sender as Address,
        net: String(a.net),
        fee: String(a.fee),
        shares: Number(a.shares),
        expiry: Number(a.expiry),
        funding: Number(a.funding) === 1 ? "BTC" : "MUSD",
        claimKey: a.claimKey as Address,
        attester: a.attester as Address,
        message: String(a.message ?? ""),
        ...base,
      });
    } else if (p.eventName === "Claimed") {
      out.claimed.push({
        id: String(a.id),
        recipient: a.recipient as Address,
        relayer: a.relayer as Address,
        amount: String(a.amount),
        payout: PAYOUTS[Number(a.payout)] ?? "Save",
        ...base,
      });
    } else if (p.eventName === "Refunded") {
      out.refunded.push({
        id: String(a.id),
        to: a.to as Address,
        amount: String(a.amount),
        btcReturned: String(a.btcReturned),
        inKind: Boolean(a.inKind),
        ...base,
      });
    }
  }
  return out;
}

const newestFirst = <T extends { blockNumber: number }>(xs: T[]) => xs.sort((a, b) => b.blockNumber - a.blockNumber);

/**
 * Most recent PacketCreated / Claimed / Refunded events, scanning backwards in
 * 10k-block windows (the Mezo RPC limit) until `limit` of each are found, the
 * deploy block is reached, or `maxWindows` windows were read.
 */
export async function recentEvents(
  client: PublicClient,
  address: Address,
  floor: bigint | null,
  opts: { limit?: number; maxWindows?: number } = {},
): Promise<Decoded & { fromBlock: number; toBlock: number }> {
  const limit = opts.limit ?? 20;
  const maxWindows = opts.maxWindows ?? 6;
  const latest = await client.getBlockNumber();
  const lo = floor ?? 0n;
  const acc: Decoded = { created: [], claimed: [], refunded: [] };
  let to = latest;
  let from = latest;
  for (let w = 0; w < maxWindows && to >= lo; w++) {
    from = to > lo + LOG_WINDOW ? to - LOG_WINDOW : lo;
    const d = decode(await rawLogs(client, address, from, to));
    acc.created.push(...d.created);
    acc.claimed.push(...d.claimed);
    acc.refunded.push(...d.refunded);
    if (acc.created.length >= limit && acc.claimed.length >= limit) break;
    if (from === lo) break;
    to = from - 1n;
  }
  return {
    created: newestFirst(acc.created).slice(0, limit),
    claimed: newestFirst(acc.claimed).slice(0, limit),
    refunded: newestFirst(acc.refunded).slice(0, limit),
    fromBlock: Number(from),
    toBlock: Number(latest),
  };
}

const createdMemo = new Memo<CreatedEvent>(2000);

const MAX_DURATION = 7n * 86_400n; // Hongbao.MAX_DURATION (v2)
const MIN_DURATION = 600n; // Hongbao.MIN_DURATION
const DEFAULT_TTL = 86_400n; // the web app's default expiry
const MAX_WINDOWS = 72n; // ~30 days of 3.8-4.2 s Mezo blocks

/**
 * The PacketCreated event for one packet (message, funding, tx). Immutable, so
 * memoised per isolate.
 *
 * The packet's expiry bounds when it was created (expiry - 7 d .. expiry - 10 min).
 * Blocks are located from the chain's measured block time, and the 10k-block
 * windows are read 4 at a time, nearest first to "created 24 h before expiry"
 * (the web app's default), so the usual lookup is a single round of requests.
 */
export async function findCreated(
  client: PublicClient,
  chainId: number,
  address: Address,
  id: bigint,
  expiry: bigint,
  floor: bigint | null,
): Promise<CreatedEvent | null> {
  const memoKey = `${chainId}:${address}:${id}`;
  const hit = createdMemo.get(memoKey);
  if (hit) return hit;

  const topics = encodeEventTopics({ abi: hongbaoAbi, eventName: "PacketCreated", args: { id } } as never) as (Hex | Hex[] | null)[];
  const head = await client.getBlock({ blockTag: "latest" });
  const span = head.number > 20_000n ? 20_000n : head.number;
  const ref = span > 0n ? await client.getBlock({ blockNumber: head.number - span }) : head;
  const msPerBlock = span > 0n && head.timestamp > ref.timestamp ? ((head.timestamp - ref.timestamp) * 1000n) / span : 4000n;
  const blockAt = (t: bigint): bigint => {
    if (t >= head.timestamp) return head.number;
    const back = ((head.timestamp - t) * 1000n) / (msPerBlock > 0n ? msPerBlock : 1n);
    return back >= head.number ? 0n : head.number - back;
  };
  const margin = LOG_WINDOW + 1n;
  let hi = blockAt(expiry - MIN_DURATION) + margin;
  if (hi > head.number) hi = head.number;
  let lo = blockAt(expiry - MAX_DURATION);
  lo = lo > margin ? lo - margin : 0n;
  if (floor !== null && floor > lo) lo = floor;
  if (hi < lo) return null;
  const guess = blockAt(expiry - DEFAULT_TTL);

  const windows: [bigint, bigint][] = [];
  for (let to = hi; to >= lo && BigInt(windows.length) < MAX_WINDOWS * 2n; ) {
    const from = to > lo + LOG_WINDOW ? to - LOG_WINDOW : lo;
    windows.push([from, to]);
    if (from === lo) break;
    to = from - 1n;
  }
  const dist = ([f, t]: [bigint, bigint]) => {
    const mid = (f + t) / 2n;
    return mid > guess ? mid - guess : guess - mid;
  };
  windows.sort((a, b) => (dist(a) < dist(b) ? -1 : dist(a) > dist(b) ? 1 : 0));
  windows.length = Math.min(windows.length, Number(MAX_WINDOWS));

  for (let i = 0; i < windows.length; i += 4) {
    const batch = windows.slice(i, i + 4);
    const results = await Promise.all(batch.map(([f, t]) => rawLogs(client, address, f, t, topics)));
    for (const logs of results) {
      const found = decode(logs).created.find((c) => c.id === id.toString());
      if (found) {
        createdMemo.set(memoKey, found);
        return found;
      }
    }
  }
  return null;
}
