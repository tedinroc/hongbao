import { ApiError } from "./errors";
import { intVar, type Env } from "./env";

/**
 * Claim rate limits on every packet the relayer serves (SPEC.md "v2 contract
 * changes"): per device 1 claim per packet; per IP 5 claims per packet and 20
 * claims per hour across all packets.
 *
 * Storage: the KV namespace HB_LIMITS when bound; otherwise a per-isolate Map
 * (good enough for local runs, weak in production: isolates are many and
 * short-lived). KV is eventually consistent, so two simultaneous requests can
 * both pass; the contract's own `claimed[id][recipient]` check still holds.
 * Keys are SHA-256 hashes, so raw IPs and device ids are never stored.
 */

interface Counter {
  n: number;
  exp: number; // unix seconds
}

interface Store {
  get(key: string): Promise<Counter | null>;
  put(key: string, value: Counter): Promise<void>;
}

/**
 * KV-backed counters. If KV fails (e.g. the free plan's daily write quota is
 * used up) we fall back to memory for that operation rather than blocking
 * every claim; the failure is logged.
 */
class KvStore implements Store {
  private readonly mem = new MemoryStore();
  constructor(private readonly kv: KVNamespace) {}
  async get(key: string): Promise<Counter | null> {
    try {
      const v = await this.kv.get<Counter>(key, "json");
      if (!v || typeof v.n !== "number" || typeof v.exp !== "number") return this.mem.get(key);
      return v.exp > nowSec() ? v : null;
    } catch (e) {
      console.warn("[hongbao] HB_LIMITS read failed, using memory:", (e as Error).message?.slice(0, 120));
      return this.mem.get(key);
    }
  }
  async put(key: string, value: Counter): Promise<void> {
    await this.mem.put(key, value);
    try {
      // KV needs an expiration at least 60 s in the future.
      await this.kv.put(key, JSON.stringify(value), { expiration: Math.max(value.exp, nowSec() + 61) });
    } catch (e) {
      console.warn("[hongbao] HB_LIMITS write failed, using memory:", (e as Error).message?.slice(0, 120));
    }
  }
}

const memory = new Map<string, Counter>();
let warned = false;

class MemoryStore implements Store {
  async get(key: string): Promise<Counter | null> {
    const v = memory.get(key);
    if (!v) return null;
    if (v.exp <= nowSec()) {
      memory.delete(key);
      return null;
    }
    return v;
  }
  async put(key: string, value: Counter): Promise<void> {
    if (memory.size > 20_000) {
      const t = nowSec();
      for (const [k, v] of memory) if (v.exp <= t) memory.delete(k);
      if (memory.size > 20_000) memory.clear();
    }
    memory.set(key, value);
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function hashKey(parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join("|"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `hb:v1:${parts[0]}:${hex.slice(0, 40)}`;
}

export interface LimitRule {
  /** Short name returned to the client when this rule trips. */
  name: "device-per-packet" | "ip-per-packet" | "ip-per-hour";
  parts: string[];
  limit: number;
  /** Unix seconds when the counter may be forgotten. */
  exp: number;
}

export interface Reservation {
  release(): Promise<void>;
}

export function limitsFor(env: Env) {
  return {
    devicePerPacket: intVar(env.LIMIT_DEVICE_PER_PACKET, 1, 1, 1000),
    ipPerPacket: intVar(env.LIMIT_IP_PER_PACKET, 5, 1, 1000),
    ipPerHour: intVar(env.LIMIT_IP_PER_HOUR, 20, 1, 100_000),
  };
}

function storeFor(env: Env): Store {
  if (env.HB_LIMITS) return new KvStore(env.HB_LIMITS);
  if (!warned) {
    warned = true;
    console.warn("[hongbao] HB_LIMITS KV is not bound; rate limits are per-isolate memory only.");
  }
  return new MemoryStore();
}

/** Check every rule; if none is at its limit, count this claim against all of them. */
export async function reserve(env: Env, rules: LimitRule[]): Promise<Reservation> {
  const store = storeFor(env);
  const keys = await Promise.all(rules.map((r) => hashKey([r.name, ...r.parts])));
  const current = await Promise.all(keys.map((k) => store.get(k)));
  for (let i = 0; i < rules.length; i++) {
    const c = current[i];
    if (c && c.n >= rules[i].limit) {
      const retryAfter = Math.max(1, c.exp - nowSec());
      throw new ApiError("RateLimited", 429, undefined, { limit: rules[i].name, retryAfter }, {
        "retry-after": String(Math.min(retryAfter, 86_400)),
      });
    }
  }
  await Promise.all(
    rules.map((r, i) => store.put(keys[i], { n: (current[i]?.n ?? 0) + 1, exp: current[i]?.exp ?? r.exp })),
  );
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await Promise.all(
        keys.map(async (k) => {
          const c = await store.get(k);
          if (c && c.n > 0) await store.put(k, { n: c.n - 1, exp: c.exp });
        }),
      ).catch(() => undefined);
    },
  };
}

export function hourBucket(): { bucket: string; exp: number } {
  const t = nowSec();
  const start = t - (t % 3600);
  return { bucket: String(start), exp: start + 3600 };
}
