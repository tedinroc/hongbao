import { ApiError, logSafe } from "./errors";
import type { Ctx, Env } from "./env";

const BASE_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function replacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, replacer), {
    status,
    headers: { ...BASE_HEADERS, "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json({ error: err.code, message: err.message, ...(err.extra ?? {}) }, err.status, err.headers ?? {});
  }
  console.error("[hongbao] unexpected error:", logSafe(err));
  return json({ error: "InternalError", message: "Something went wrong." }, 500);
}

function allowedOrigins(request: Request, env: Env): Set<string> {
  const set = new Set<string>([new URL(request.url).origin]);
  for (const o of (env.ALLOWED_ORIGINS ?? "").split(",")) {
    const t = o.trim().replace(/\/$/, "");
    if (/^https?:\/\/[^\s/]+$/i.test(t)) set.add(t);
  }
  return set;
}

/**
 * Same-origin only. We never emit Access-Control-Allow-* headers, so browsers
 * cannot read our responses cross-origin; on top of that, refuse any request a
 * browser marks as coming from another site, and refuse CORS preflights.
 */
export function assertSameOrigin(request: Request, env: Env): void {
  const allowed = allowedOrigins(request, env);
  const origin = request.headers.get("origin");
  if (origin && origin !== "null" && allowed.has(origin)) return;
  if (origin) throw new ApiError("Forbidden", 403);
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new ApiError("Forbidden", 403);
}

export async function readJsonBody(request: Request, maxBytes = 4096): Promise<unknown> {
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.startsWith("application/json")) throw new ApiError("UnsupportedMediaType", 415);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new ApiError("PayloadTooLarge", 413);
  const text = await request.text();
  if (text.length > maxBytes) throw new ApiError("PayloadTooLarge", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("BadRequest", 400, "Body is not valid JSON.");
  }
}

export function methodNotAllowed(allow: string): Response {
  return json({ error: "MethodNotAllowed", message: "Method not allowed." }, 405, { allow });
}

/** Client IP as seen by Cloudflare; IPv6 is bucketed to its /64 (one household or phone). */
export function clientIp(request: Request): string {
  const raw = (request.headers.get("cf-connecting-ip") ?? "").trim().toLowerCase();
  if (!raw || raw.length > 64) return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1];
  if (!raw.includes(":")) return raw;
  let groups: string[];
  if (raw.includes("::")) {
    const [head, tail] = raw.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  } else {
    groups = raw.split(":");
  }
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

interface CacheStorageWithDefault {
  default: Cache;
}

function edgeCache(): Cache | null {
  const c = (globalThis as unknown as { caches?: CacheStorageWithDefault }).caches;
  return c && c.default ? c.default : null;
}

/**
 * Serve from the Cloudflare edge cache when present (Workers runtime only),
 * otherwise produce, store with `max-age=ttl`, and return.
 */
export async function withEdgeCache(ctx: Ctx, ttlSeconds: number, produce: () => Promise<Response>): Promise<Response> {
  const cache = edgeCache();
  const url = new URL(ctx.request.url);
  url.searchParams.sort();
  const key = new Request(url.toString(), { method: "GET" });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch {
      /* cache is best effort */
    }
  }
  const res = await produce();
  const headers = new Headers(res.headers);
  if (res.status === 200 || res.status === 404) {
    headers.set("cache-control", `public, max-age=${ttlSeconds}`);
  }
  const out = new Response(res.body, { status: res.status, headers });
  if (cache && (res.status === 200 || res.status === 404)) {
    const put = cache.put(key, out.clone()).catch(() => undefined);
    if (ctx.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  return out;
}

/** Tiny memo for immutable lookups (per isolate, bounded). */
export class Memo<V> {
  private map = new Map<string, V>();
  constructor(private readonly max = 500) {}
  get(k: string): V | undefined {
    return this.map.get(k);
  }
  set(k: string, v: V): void {
    if (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(k, v);
  }
}
