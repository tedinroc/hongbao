/**
 * POST /api/claim
 * body { chainId, packetId, recipient, payout (0 Stake | 1 Save | 2 Cash), keySig, device, relayer? }
 *   keySig = EIP-712 Claim(packetId, recipient, payout, relayer) signed by the link key, with
 *   relayer = the address /api/config returns; `relayer` in the body, when sent, must equal it.
 * → 200 { txHash, chainId, packetId, recipient, relayer, attested, expected: { amount, payout } }
 * → 4xx/5xx { error: <code>, message } where <code> is a decoded Hongbao custom error
 *   (UnknownPacket, PacketClosed, Expired, AlreadyClaimed, BadSignature, BadRecipient, ...) or a
 *   relayer code (BadRequest, Forbidden, RateLimited, ForeignAttester, WrongRelayer, TipTooLow,
 *   RelayerOutOfGas, ...).
 *
 * The relayer only ever sends Hongbao.claim(...) to the configured Hongbao address,
 * with calldata it builds itself from validated fields and relayer = its own address.
 */
import type { Ctx, Env } from "../_lib/env";
import { ApiError } from "../_lib/errors";
import { assertSameOrigin, clientIp, errorResponse, json, methodNotAllowed, readJsonBody } from "../_lib/http";
import { relayClaim } from "../_lib/relay";
import { asObject, parseAddress, parseChainId, parseDevice, parsePacketId, parsePayout, parseSignature } from "../_lib/validate";

export async function handleClaim(ctx: Ctx): Promise<Response> {
  const { request, env } = ctx;
  try {
    if (request.method === "OPTIONS") throw new ApiError("Forbidden", 403);
    if (request.method !== "POST") return methodNotAllowed("POST");
    assertSameOrigin(request, env);
    const body = asObject(await readJsonBody(request));
    const input = {
      chainId: parseChainId(body.chainId),
      packetId: parsePacketId(body.packetId),
      recipient: parseAddress(body.recipient, "recipient"),
      payout: parsePayout(body.payout),
      keySig: parseSignature(body.keySig, "keySig"),
      relayer: body.relayer === undefined || body.relayer === null ? null : parseAddress(body.relayer, "relayer"),
      device: parseDevice(body.device),
      ip: clientIp(request),
    };
    const result = await relayClaim(env, input);
    return json(result, 200);
  } catch (e) {
    return errorResponse(e);
  }
}

export const onRequest: PagesFunction<Env> = (context) => handleClaim(context as unknown as Ctx);
