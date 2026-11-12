// Staged for web/functions/c/[chain]/[id].ts — link previews for Telegram, WhatsApp and LINE.
// Serves the SPA's index.html for /c/:chain/:id with Open Graph tags filled from the packet.
// The #k= fragment never reaches the server, so this only ever sees the public packet id.
import { createPublicClient, http, formatUnits, type Address } from "viem";

type Env = { ASSETS: { fetch: (r: Request | string) => Promise<Response> }; RPC_31611?: string; RPC_31612?: string; HONGBAO_31611?: string; HONGBAO_31612?: string };

const RPC: Record<string, string> = {
  "31611": "https://rpc.test.mezo.org",
  "31612": "https://mainnet.mezo.public.validationcloud.io",
};

const ABI = [
  {
    type: "function", name: "getPacket", stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "sender", type: "address" }, { name: "expiry", type: "uint64" }, { name: "sharesTotal", type: "uint32" },
      { name: "claimKey", type: "address" }, { name: "sharesLeft", type: "uint32" }, { name: "refunded", type: "bool" },
      { name: "attester", type: "address" }, { name: "dripPerShare", type: "uint96" }, { name: "remaining", type: "uint128" },
      { name: "tipPerShare", type: "uint96" },
    ] }],
  },
  { type: "function", name: "nextShare", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

export const onRequestGet = async (ctx: { request: Request; env: Env; params: { chain: string; id: string } }) => {
  const { request, env, params } = ctx;
  const page = await env.ASSETS.fetch(new URL("/index.html", request.url).toString());
  const chain = String(params.chain);
  const hongbao = (chain === "31612" ? env.HONGBAO_31612 : env.HONGBAO_31611) as Address | undefined;
  if (!/^\d+$/.test(String(params.id)) || !RPC[chain] || !hongbao) return page;

  let title = "紅包 Hongbao · a red packet for you";
  let desc = "Tap to open. Your share lands in Mezo savings, gas included. No wallet needed.";
  try {
    const client = createPublicClient({ transport: http((chain === "31612" ? env.RPC_31612 : env.RPC_31611) || RPC[chain]) });
    const id = BigInt(params.id);
    const [p, share] = await Promise.all([
      client.readContract({ address: hongbao, abi: ABI, functionName: "getPacket", args: [id] }),
      client.readContract({ address: hongbao, abi: ABI, functionName: "nextShare", args: [id] }),
    ]);
    if (p.sender !== "0x0000000000000000000000000000000000000000") {
      const each = Number(formatUnits(share, 18)).toFixed(2);
      title = p.sharesLeft > 0 && !p.refunded ? `紅包 · ${p.sharesLeft} of ${p.sharesTotal} left · ${each} MUSD each` : "紅包 · all opened";
      desc = "Tap to open your share. It lands staked in Mezo savings, earning MEZO, with gas included.";
    }
  } catch {
    /* fall back to the generic card */
  }

  const og = `<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">` +
    `<meta property="og:image" content="${new URL("/og.png", request.url)}"><meta property="og:type" content="website">` +
    `<meta name="twitter:card" content="summary_large_image">`;
  const html = (await page.text()).replace("</head>", `${og}</head>`);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=15" } });
};
