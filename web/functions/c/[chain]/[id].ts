/**
 * GET /c/:chain/:id: the claim page, with link-preview tags for Telegram, WhatsApp and LINE.
 *
 * Those apps read Open Graph tags from the HTML and run no JavaScript, so this serves the
 * SPA's index.html with og:title / og:description filled from the packet, for example
 * "紅包 · 7 of 10 left · 1.00 MUSD each". The link key travels in the #k= fragment, which
 * browsers never send, so this only ever sees the public chain id and packet id.
 *
 * Every failure (bad path, chain not live, unknown packet, slow or failing RPC) still serves
 * the app, with a generic card. The page comes from env.ASSETS at "/" (the static index.html),
 * so this function never calls itself, and the `_redirects` rule `/c/* / 200` remains the
 * fallback for anything this route does not match (HEAD, extra path segments).
 */
import { isAddressEqual, type Address } from "viem";
import { ZERO_ADDRESS, hongbaoAbi, type PacketView } from "../../_lib/abi";
import { isSupportedChain, publicClient, type ChainId } from "../../_lib/chains";
import { chainEnabled, hongbaoAddress } from "../../_lib/deployments";
import type { Env } from "../../_lib/env";
import { Memo } from "../../_lib/http";

export interface Card {
  title: string;
  description: string;
}

export const GENERIC_CARD: Card = {
  title: "紅包 Hongbao · a red packet for you",
  description:
    "Open the link to claim one share. Earn MEZO, save it as sMUSD, or take MUSD. You need no wallet and no gas. " +
    "打開連結領一份紅包：賺 MEZO、存成 sMUSD 或直接領 MUSD，不用先準備錢包或 gas。",
};

const OPEN_DESCRIPTION = GENERIC_CARD.description;

/** How long the page waits for the packet read before it falls back to the generic card. */
const RPC_BUDGET_MS = 2_000;
/** Packet cards are reused for this long per isolate (one RPC round trip per packet per window). */
const CARD_TTL_MS = 15_000;

/** MUSD amount (18 decimals), rounded down to cents so a preview never overstates a share. */
export function musdCents(wei: bigint): string {
  const cents = wei / 10n ** 16n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

/** The card for a packet read from getPacket + nextShare; null for an unknown id. */
export function packetCard(p: PacketView, nextShare: bigint): Card | null {
  if (isAddressEqual(p.sender, ZERO_ADDRESS)) return null;
  if (p.refunded) {
    return {
      title: "紅包 · closed",
      description: "This red packet is closed. What was left went back to the sender. 這個紅包已結束，剩下的錢已退回給發紅包的人。",
    };
  }
  if (p.sharesLeft === 0) {
    return {
      title: `紅包 · all ${p.sharesTotal} opened`,
      description: "Everyone already claimed a share of this red packet. 這個紅包已經被領完了。",
    };
  }
  // nextShare is 0 exactly when the packet is past its expiry (it is open and has shares left).
  if (nextShare === 0n) {
    return {
      title: "紅包 · expired",
      description: "This red packet expired. What is left goes back to the sender. 這個紅包已經過期，剩下的錢會退回給發紅包的人。",
    };
  }
  return {
    title: `紅包 · ${p.sharesLeft} of ${p.sharesTotal} left · ${musdCents(nextShare)} MUSD each`,
    description: OPEN_DESCRIPTION,
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

// index.html carries generic description / og:* / twitter:* tags. Crawlers take the first
// og:title they see, so remove those before adding the packet's own.
const SHARE_META = /<meta\b[^>]*\b(?:property|name)\s*=\s*["'](?:og:[^"']*|twitter:[^"']*|description)["'][^>]*>[ \t]*\r?\n?[ \t]*/gi;

/** index.html with the card's tags in <head> (and its title as <title>). */
export function withCard(html: string, card: Card, pageUrl: string, imageUrl: string): string {
  if (!/<\/head>/i.test(html)) return html;
  const tags = [
    `<meta name="description" content="${esc(card.description)}" />`,
    `<meta property="og:title" content="${esc(card.title)}" />`,
    `<meta property="og:description" content="${esc(card.description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="紅包 Hongbao" />`,
    `<meta property="og:url" content="${esc(pageUrl)}" />`,
    `<meta property="og:image" content="${esc(imageUrl)}" />`,
    `<meta property="og:image:type" content="image/jpeg" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="A red envelope with a gold seal. 紅包 Hongbao, MUSD red packets on Mezo." />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ].join("\n    ");
  return html
    .replace(SHARE_META, "")
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(card.title)}</title>`)
    .replace(/<\/head>/i, `  ${tags}\n  </head>`);
}

const cardCache = new Memo<{ card: Card | null; until: number }>(500);

async function readCard(env: Env, chainId: ChainId, hongbao: Address, id: bigint): Promise<Card | null> {
  const key = `${chainId}:${hongbao}:${id}`;
  const hit = cardCache.get(key);
  if (hit && hit.until > Date.now()) return hit.card;
  const client = publicClient(env, chainId);
  // Both reads go out as one JSON-RPC batch.
  const [p, next] = await Promise.all([
    client.readContract({ address: hongbao, abi: hongbaoAbi, functionName: "getPacket", args: [id] }),
    client.readContract({ address: hongbao, abi: hongbaoAbi, functionName: "nextShare", args: [id] }),
  ]);
  const card = packetCard(p as PacketView, next as bigint);
  cardCache.set(key, { card, until: Date.now() + CARD_TTL_MS });
  return card;
}

function withinBudget<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work.catch(() => null), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

type OgEnv = Env & { ASSETS: { fetch: typeof fetch } };

export async function handleOg(request: Request, env: OgEnv, params: { chain?: unknown; id?: unknown }): Promise<Response> {
  const url = new URL(request.url);
  const page = await env.ASSETS.fetch(new Request(new URL("/", url).toString(), { method: "GET" }));
  const type = page.headers.get("content-type") ?? "";
  if (!page.ok || !type.toLowerCase().startsWith("text/html")) return page;

  let card = GENERIC_CARD;
  let pagePath = url.pathname;
  const chainRaw = typeof params.chain === "string" ? params.chain : "";
  const idRaw = typeof params.id === "string" ? params.id : "";
  const chainId = /^\d{1,10}$/.test(chainRaw) ? Number(chainRaw) : NaN;
  if (isSupportedChain(chainId) && /^\d{1,78}$/.test(idRaw)) {
    const id = BigInt(idRaw);
    pagePath = `/c/${chainId}/${id}`;
    const hongbao = hongbaoAddress(env, chainId);
    if (id >= 1n && hongbao && chainEnabled(env, chainId)) {
      card = (await withinBudget(readCard(env, chainId, hongbao, id), RPC_BUDGET_MS)) ?? GENERIC_CARD;
    }
  }

  const html = withCard(await page.text(), card, `${url.origin}${pagePath}`, new URL("/og.jpg", url).toString());
  const headers = new Headers(page.headers);
  for (const h of ["content-length", "content-encoding", "etag", "last-modified"]) headers.delete(h);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", page.headers.get("cache-control") ?? "public, max-age=0, must-revalidate");
  headers.set("x-content-type-options", "nosniff");
  return new Response(html, { status: 200, headers });
}

export const onRequestGet: PagesFunction<Env, "chain" | "id"> = (ctx) => handleOg(ctx.request, ctx.env, ctx.params);
