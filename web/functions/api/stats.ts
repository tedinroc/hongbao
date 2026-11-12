/**
 * GET /api/stats?chainId=31611
 * → { chainId, hongbao, stats: { packets, claims, volume, recipients, senders, open },
 *     recent: { created[], claimed[], refunded[], fromBlock, toBlock }, block }
 * Amounts are wei strings. Recent events: newest first, up to 20 each, from the
 * last ~6 log windows (60k blocks ≈ 3 days on Mezo) or since the deploy block.
 * Cached 30 s (browser + Cloudflare edge).
 */
import type { Address } from "viem";
import { hongbaoAbi } from "../_lib/abi";
import { SUPPORTED_CHAINS, publicClient, type ChainId } from "../_lib/chains";
import { chainEnabled, deployBlock, hongbaoAddress } from "../_lib/deployments";
import type { Ctx, Env } from "../_lib/env";
import { ApiError, logSafe } from "../_lib/errors";
import { errorResponse, json, methodNotAllowed, withEdgeCache } from "../_lib/http";
import { recentEvents } from "../_lib/logs";
import type { ApiStats } from "../_lib/types";
import { parseChainId } from "../_lib/validate";

export async function handleStats(ctx: Ctx): Promise<Response> {
  const { request, env } = ctx;
  try {
    if (request.method === "OPTIONS") throw new ApiError("Forbidden", 403);
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    const raw = new URL(request.url).searchParams.get("chainId");
    const chainId: ChainId = raw
      ? parseChainId(raw)
      : (SUPPORTED_CHAINS.find((c) => chainEnabled(env, c)) ?? 31611);
    if (!chainEnabled(env, chainId)) throw new ApiError("ChainDisabled", 503);
    const hongbao = hongbaoAddress(env, chainId) as Address;

    return await withEdgeCache(ctx, 30, async () => {
      try {
        const client = publicClient(env, chainId);
        const [s, block, recent] = await Promise.all([
          client.readContract({ address: hongbao, abi: hongbaoAbi, functionName: "stats" }),
          client.getBlock({ blockTag: "latest" }),
          recentEvents(client, hongbao, deployBlock(env, chainId)),
        ]);
        const [packets, claims, volume, recipients, senders, open] = s as readonly bigint[];
        const body: ApiStats = {
          chainId,
          hongbao,
          stats: {
            packets: packets.toString(),
            claims: claims.toString(),
            volume: volume.toString(),
            recipients: recipients.toString(),
            senders: senders.toString(),
            open: open.toString(),
          },
          recent,
          block: { number: Number(block.number), timestamp: Number(block.timestamp) },
        };
        return json(body, 200);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        console.error("[hongbao] stats failed:", logSafe(e));
        return errorResponse(new ApiError("RpcError", 502));
      }
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export const onRequest: PagesFunction<Env> = (context) => handleStats(context as unknown as Ctx);
