/**
 * GET /api/packet?chainId=31611&id=7[&recipient=0x...]
 * → { chainId, id, hongbao, status, packet: {...getPacket}, nextShare, attesterMode, claimedBy?, created, block }
 * Cached 5 s (browser + Cloudflare edge).
 */
import { isAddressEqual, type Address } from "viem";
import { ZERO_ADDRESS, hongbaoAbi, type PacketView } from "../_lib/abi";
import { publicClient } from "../_lib/chains";
import { chainEnabled, deployBlock, hongbaoAddress } from "../_lib/deployments";
import { attesterSigner, type Ctx, type Env } from "../_lib/env";
import { ApiError, decodeRevert, logSafe, revertToApiError } from "../_lib/errors";
import { errorResponse, json, methodNotAllowed, withEdgeCache } from "../_lib/http";
import { findCreated } from "../_lib/logs";
import type { ApiPacket, PacketStatus } from "../_lib/types";
import { parseAddress, parseChainId, parsePacketId } from "../_lib/validate";

export async function handlePacket(ctx: Ctx): Promise<Response> {
  const { request, env } = ctx;
  try {
    if (request.method === "OPTIONS") throw new ApiError("Forbidden", 403);
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    const q = new URL(request.url).searchParams;
    const chainId = parseChainId(q.get("chainId"));
    const id = parsePacketId(q.get("id") ?? q.get("packetId"), "id");
    const recipientRaw = q.get("recipient");
    const recipient: Address | null = recipientRaw ? parseAddress(recipientRaw, "recipient") : null;
    if (!chainEnabled(env, chainId)) throw new ApiError("ChainDisabled", 503);
    const hongbao = hongbaoAddress(env, chainId) as Address;

    return await withEdgeCache(ctx, 5, async () => {
      try {
        const client = publicClient(env, chainId);
        let p: PacketView, next: bigint, block: { number: bigint; timestamp: bigint }, claimedBy: boolean | undefined;
        try {
          const [pr, nr, br, cr] = await Promise.all([
            client.readContract({ address: hongbao, abi: hongbaoAbi, functionName: "getPacket", args: [id] }),
            client.readContract({ address: hongbao, abi: hongbaoAbi, functionName: "nextShare", args: [id] }),
            client.getBlock({ blockTag: "latest" }),
            recipient
              ? client.readContract({ address: hongbao, abi: hongbaoAbi, functionName: "claimed", args: [id, recipient] })
              : Promise.resolve(undefined),
          ]);
          p = pr as PacketView;
          next = nr as bigint;
          block = { number: br.number, timestamp: br.timestamp };
          claimedBy = cr as boolean | undefined;
        } catch (e) {
          const d = decodeRevert(e);
          if (d) throw revertToApiError(d);
          console.error("[hongbao] packet read failed:", logSafe(e));
          throw new ApiError("RpcError", 502);
        }
        if (isAddressEqual(p.sender, ZERO_ADDRESS)) throw new ApiError("UnknownPacket", 404);

        let created = null;
        try {
          created = await findCreated(client, chainId, hongbao, id, p.expiry, deployBlock(env, chainId));
        } catch (e) {
          console.warn("[hongbao] PacketCreated lookup failed:", logSafe(e));
        }

        const status: PacketStatus = p.refunded
          ? "refunded"
          : p.sharesLeft === 0
            ? "empty"
            : block.timestamp >= p.expiry
              ? "expired"
              : "open";
        const ours = attesterSigner(env)?.address;
        const attesterMode = isAddressEqual(p.attester, ZERO_ADDRESS)
          ? "none"
          : ours && isAddressEqual(p.attester, ours)
            ? "ours"
            : "foreign";

        const body: ApiPacket = {
          chainId,
          id: id.toString(),
          hongbao,
          status,
          packet: {
            sender: p.sender,
            expiry: Number(p.expiry),
            sharesTotal: p.sharesTotal,
            claimKey: p.claimKey,
            sharesLeft: p.sharesLeft,
            refunded: p.refunded,
            attester: p.attester,
            dripPerShare: p.dripPerShare.toString(),
            remaining: p.remaining.toString(),
            tipPerShare: p.tipPerShare.toString(),
          },
          nextShare: next.toString(),
          attesterMode,
          ...(claimedBy === undefined ? {} : { claimedBy }),
          created,
          block: { number: Number(block.number), timestamp: Number(block.timestamp) },
        };
        return json(body, 200);
      } catch (e) {
        return errorResponse(e);
      }
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export const onRequest: PagesFunction<Env> = (context) => handlePacket(context as unknown as Ctx);
