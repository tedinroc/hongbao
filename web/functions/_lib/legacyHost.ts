/**
 * The app moved from hongbao-mezo.pages.dev to hongbao.trytry.net on 2026-11-13, because MetaMask flags
 * every *.pages.dev site as a wallet drainer when a wallet connects. Old links keep working: a page load on
 * the old host is sent to the same path on the new host. The claim key sits in the #fragment, which the
 * browser never sends to a server and carries across the redirect by itself.
 *
 * Only top-level page loads move. /api calls, scripts and data that a tab already open on the old host
 * fetches are served as before (a cross-origin hop would break them: module scripts need CORS, and the
 * relayer only accepts its own origin).
 */
export const LEGACY_HOST = "hongbao-mezo.pages.dev";
export const PRIMARY_ORIGIN = "https://hongbao.trytry.net";

/** Where to send this request, or null to serve it here. */
export function legacyRedirect(request: Request): string | null {
  const url = new URL(request.url);
  // Exact host only: preview deployments (<hash>.hongbao-mezo.pages.dev) stay put.
  if (url.hostname !== LEGACY_HOST) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return null;
  // A phone wallet lives in the storage of the origin that made it. Keep "My wallet" on the old host so people
  // who claimed there can still reach theirs, back up the key and import it on the new domain.
  if (url.pathname === "/me") return null;
  const mode = request.headers.get("sec-fetch-mode");
  const isPageLoad = mode
    ? mode === "navigate"
    : (request.headers.get("accept") ?? "").toLowerCase().includes("text/html");
  if (!isPageLoad) return null;
  return `${PRIMARY_ORIGIN}${url.pathname}${url.search}`;
}
