/**
 * GET /api/config
 * → { chains: { "31611": { chainId, name, hongbao, relayer, attester, enabled, deployBlock }, "31612": {...} } }
 * Addresses only; keys never leave the function.
 */
import { SUPPORTED_CHAINS } from "../_lib/chains";
import { chainEnabled, chainName, deployBlock, hongbaoAddress } from "../_lib/deployments";
import { attesterSigner, relayerSigner, type Ctx, type Env } from "../_lib/env";
import { ApiError } from "../_lib/errors";
import { errorResponse, json, methodNotAllowed } from "../_lib/http";
import type { ApiChainConfig, ApiConfig } from "../_lib/types";

export async function handleConfig(ctx: Ctx): Promise<Response> {
  const { request, env } = ctx;
  try {
    if (request.method === "OPTIONS") throw new ApiError("Forbidden", 403);
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    const attester = attesterSigner(env)?.address ?? null;
    const chains = {} as Record<string, ApiChainConfig>;
    for (const id of SUPPORTED_CHAINS) {
      const relayer = relayerSigner(env, id)?.address ?? null;
      const db = deployBlock(env, id);
      chains[String(id)] = {
        chainId: id,
        name: chainName(id),
        hongbao: hongbaoAddress(env, id),
        relayer,
        attester,
        enabled: chainEnabled(env, id),
        deployBlock: db === null ? null : Number(db),
      };
    }
    const body: ApiConfig = { chains: chains as ApiConfig["chains"] };
    return json(body, 200, { "cache-control": "public, max-age=30" });
  } catch (e) {
    return errorResponse(e);
  }
}

export const onRequest: PagesFunction<Env> = (context) => handleConfig(context as unknown as Ctx);
