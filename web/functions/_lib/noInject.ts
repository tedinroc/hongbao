/**
 * Keep the edge from rewriting our pages. On a proxied zone (hongbao.trytry.net) Cloudflare turns on Web
 * Analytics by default and injects a third-party beacon into every HTML page; that script runs next to the
 * claim key in location.hash. `Cache-Control: no-transform` stops any such injection
 * (developers.cloudflare.com/web-analytics/get-started: "the Beacon script will not be automatically injected").
 */
export function withNoTransform(res: Response): Response {
  const type = res.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("text/html")) return res;
  const cc = res.headers.get("cache-control");
  if (cc && /(^|,)\s*no-transform\s*(,|$)/i.test(cc)) return res;
  const out = new Response(res.body, res);
  out.headers.set("cache-control", cc ? `${cc}, no-transform` : "no-transform");
  return out;
}
