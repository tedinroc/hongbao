/**
 * Runs before every function and every page in public/_routes.json's include list:
 * page loads on the old pages.dev host move to the new domain (_lib/legacyHost.ts), and
 * HTML is marked no-transform so the edge cannot inject scripts next to the claim key (_lib/noInject.ts).
 */
import type { Env } from "./_lib/env";
import { legacyRedirect } from "./_lib/legacyHost";
import { withNoTransform } from "./_lib/noInject";

export const onRequest: PagesFunction<Env> = async (context) => {
  const to = legacyRedirect(context.request);
  if (to) {
    // 302, not 301: browsers cache a 301 forever, and the old host must stay usable if we ever move back.
    return new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });
  }
  return withNoTransform(await context.next());
};
