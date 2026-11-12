import {
  BaseError,
  Eip1559FeesNotSupportedError,
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerializable,
} from "viem";
import { signTransaction, signTypedData } from "viem/accounts";
import { PAYOUTS, ZERO_ADDRESS, hongbaoAbi, type PacketView } from "./abi";
import { MEZO, publicClient, type ChainId } from "./chains";
import { chainEnabled, hongbaoAddress } from "./deployments";
import { ATTEST_TTL, ATTEST_TYPES, hongbaoDomain } from "./eip712";
import { attesterSigner, intVar, relayerSigner, type Env, type Signer } from "./env";
import { ApiError, decodeRevert, logSafe, revertToApiError } from "./errors";
import { hourBucket, limitsFor, reserve, type LimitRule } from "./limits";
import type { ApiClaimResponse } from "./types";

export interface ClaimInput {
  chainId: ChainId;
  packetId: bigint;
  recipient: Address;
  payout: 0 | 1 | 2;
  keySig: Hex;
  /** The relayer the link key signed for (the browser reads it from /api/config); null when the client left it out. */
  relayer: Address | null;
  device: string | null;
  ip: string;
}

/** A claim is ~300k gas; anything far above that is not a normal claim. */
const MAX_CLAIM_GAS = 1_500_000n;

/**
 * The packet's tip must cover the claim's gas at the current gas price with
 * 20% to spare (SPEC.md relayer policy), so relaying never runs at a loss.
 */
const TIP_MARGIN_NUM = 12n;
const TIP_MARGIN_DEN = 10n;

/**
 * Addresses Hongbao.claim refuses as a recipient (mirrors the contract's
 * BadRecipient check): the Hongbao itself and Mezo's sMUSD vault, sMUSD gauge,
 * MUSD and BTC token contracts. Checked before simulating.
 */
export function protocolAddresses(chainId: ChainId, hongbao: Address): Address[] {
  const m = MEZO[chainId];
  return [hongbao, m.smusd, m.gauge, m.musd, m.btc];
}
const NONCE_RETRIES = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rpcError(err: unknown): ApiError {
  console.error("[hongbao] rpc error:", logSafe(err));
  return new ApiError("RpcError", 502);
}

/** Simulation / estimation failure → decoded contract error, else RPC error. */
function callError(err: unknown): ApiError {
  const d = decodeRevert(err);
  if (d) return revertToApiError(d);
  return rpcError(err);
}

function errText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 6 && e; i++) {
    if (e instanceof BaseError) parts.push(e.shortMessage, e.details ?? "");
    else if (e instanceof Error) parts.push(e.message);
    e = (e as { cause?: unknown }).cause;
  }
  return parts.join(" | ").toLowerCase();
}

// One send at a time per relayer key within an isolate, so nonces do not collide
// locally; collisions across isolates are retried below.
const sendQueues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sendQueues.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  sendQueues.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

async function feeFields(client: PublicClient): Promise<{ fields: Partial<TransactionSerializable>; perGas: bigint }> {
  try {
    const f = await client.estimateFeesPerGas();
    if (f.maxFeePerGas !== undefined && f.maxPriorityFeePerGas !== undefined) {
      return {
        fields: { type: "eip1559", maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas },
        perGas: f.maxFeePerGas,
      };
    }
  } catch (e) {
    const notSupported = e instanceof BaseError && e.walk((x) => x instanceof Eip1559FeesNotSupportedError);
    if (!notSupported) throw e;
  }
  const gasPrice = await client.getGasPrice();
  return { fields: { type: "legacy", gasPrice }, perGas: gasPrice };
}

/**
 * Sign and broadcast `claim` calldata to the Hongbao address. The destination
 * and calldata are built here from typed arguments only; nothing from the
 * request is forwarded as raw calldata.
 */
async function sendClaimTx(
  env: Env,
  client: PublicClient,
  chainId: ChainId,
  relayer: Signer,
  hongbao: Address,
  data: Hex,
  gas: bigint,
): Promise<Hex> {
  const maxFee = BigInt(intVar(env.MAX_FEE_PER_GAS_WEI, 1_000_000_000, 1, 1_000_000_000_000));
  return serialized(`${chainId}:${relayer.address}`, async () => {
    for (let attempt = 0; ; attempt++) {
      let nonce: number;
      let fees: Awaited<ReturnType<typeof feeFields>>;
      let balance: bigint;
      try {
        [nonce, fees, balance] = await Promise.all([
          client.getTransactionCount({ address: relayer.address, blockTag: "pending" }),
          feeFields(client),
          client.getBalance({ address: relayer.address }),
        ]);
      } catch (e) {
        throw rpcError(e);
      }
      if (fees.perGas > maxFee) throw new ApiError("GasPriceTooHigh", 503);
      if (balance < gas * fees.perGas) {
        console.error("[hongbao] relayer balance too low on chain", chainId);
        throw new ApiError("RelayerOutOfGas", 503);
      }
      const tx = { ...fees.fields, chainId, nonce, to: hongbao, data, gas, value: 0n } as TransactionSerializable;
      const raw = await signTransaction({ privateKey: relayer.privateKey, transaction: tx });
      const hash = keccak256(raw);
      try {
        await client.sendRawTransaction({ serializedTransaction: raw });
        return hash;
      } catch (e) {
        const t = errText(e);
        if (/already known|known transaction|already imported|tx already in mempool/.test(t)) return hash;
        if (/insufficient funds/.test(t)) throw new ApiError("RelayerOutOfGas", 503);
        if (/nonce|sequence|replacement transaction underpriced/.test(t) && attempt + 1 < NONCE_RETRIES) {
          await sleep(200 * (attempt + 1) + Math.floor(Math.random() * 200));
          continue;
        }
        console.error("[hongbao] send failed:", logSafe(e));
        throw new ApiError("SendFailed", 502);
      }
    }
  });
}

export async function relayClaim(env: Env, input: ClaimInput): Promise<ApiClaimResponse> {
  const { chainId, packetId, recipient, payout, keySig, device, ip } = input;

  if (!chainEnabled(env, chainId)) throw new ApiError("ChainDisabled", 503);
  const hongbao = hongbaoAddress(env, chainId) as Address;
  const relayer = relayerSigner(env, chainId);
  if (!relayer) throw new ApiError("RelayerNotConfigured", 503);
  // We submit claim(..., relayer = our address, ...); a link signature bound to another
  // relayer (or to "anyone", address 0) would only fail on chain as BadSignature.
  if (input.relayer && !isAddressEqual(input.relayer, relayer.address)) {
    throw new ApiError("WrongRelayer", 409, undefined, { relayer: relayer.address });
  }
  if (isAddressEqual(recipient, ZERO_ADDRESS)) throw new ApiError("ZeroAddress", 400);
  if (protocolAddresses(chainId, hongbao).some((a) => isAddressEqual(a, recipient))) {
    throw new ApiError("BadRecipient", 400, undefined, { field: "recipient" });
  }
  if (!device) throw new ApiError("DeviceRequired", 400, undefined, { field: "device" });

  const client = publicClient(env, chainId);

  // 1. Read the packet.
  let packet: PacketView;
  let already: boolean;
  let blockTs: bigint;
  try {
    const [p, c, b] = await Promise.all([
      client.readContract({ address: hongbao, abi: hongbaoAbi, functionName: "getPacket", args: [packetId] }),
      client.readContract({ address: hongbao, abi: hongbaoAbi, functionName: "claimed", args: [packetId, recipient] }),
      client.getBlock({ blockTag: "latest" }),
    ]);
    packet = p as PacketView;
    already = c as boolean;
    blockTs = b.timestamp;
  } catch (e) {
    throw callError(e);
  }
  if (isAddressEqual(packet.sender, ZERO_ADDRESS)) throw new ApiError("UnknownPacket", 404);
  if (packet.refunded || packet.sharesLeft === 0) throw new ApiError("PacketClosed", 410);
  if (blockTs >= packet.expiry) throw new ApiError("Expired", 410);
  if (already) throw new ApiError("AlreadyClaimed", 409);
  // A packet without a tip can never pay for its own relay (full check after estimating gas).
  if (packet.tipPerShare === 0n) throw new ApiError("TipTooLow", 422);

  // 2. Attester (one-per-person packets that name ours) and rate limits on every packet.
  let attester: Signer | null = null;
  if (!isAddressEqual(packet.attester, ZERO_ADDRESS)) {
    attester = attesterSigner(env);
    if (!attester) throw new ApiError("AttesterNotConfigured", 503);
    if (!isAddressEqual(packet.attester, attester.address)) throw new ApiError("ForeignAttester", 409);
  }
  const limits = limitsFor(env);
  const hour = hourBucket();
  const scope = [String(chainId), hongbao.toLowerCase(), packetId.toString()];
  const exp = Math.min(Number(packet.expiry) + 3600, Math.floor(Date.now() / 1000) + 31 * 86_400);
  const rules: LimitRule[] = [
    { name: "device-per-packet", parts: [...scope, device], limit: limits.devicePerPacket, exp },
    { name: "ip-per-packet", parts: [...scope, ip], limit: limits.ipPerPacket, exp },
    { name: "ip-per-hour", parts: [ip, hour.bucket], limit: limits.ipPerHour, exp: hour.exp },
  ];
  const reservation = await reserve(env, rules);

  try {
    let attestDeadline = 0n;
    let attestSig: Hex = "0x";
    if (attester) {
      const now = BigInt(Math.floor(Date.now() / 1000));
      attestDeadline = (now > blockTs ? now : blockTs) + BigInt(ATTEST_TTL);
      attestSig = await signTypedData({
        privateKey: attester.privateKey,
        domain: hongbaoDomain(chainId, hongbao),
        types: ATTEST_TYPES,
        primaryType: "Attest",
        message: { packetId, recipient, payout, deadline: attestDeadline },
      });
    }
    const args = [packetId, recipient, payout, relayer.address, keySig, attestDeadline, attestSig] as const;

    // 3. Simulate from the relayer address; a revert comes back as its custom-error name.
    let amount: bigint;
    let paid: number;
    try {
      const sim = await client.simulateContract({
        address: hongbao,
        abi: hongbaoAbi,
        functionName: "claim",
        args,
        account: relayer.address,
      });
      [amount, paid] = sim.result as unknown as [bigint, number];
    } catch (e) {
      throw callError(e);
    }

    // 4. Gas limit = estimate × 1.3; the tip must cover estimate × gas price × 1.2.
    let estimate: bigint;
    let gasPrice: bigint;
    try {
      [estimate, gasPrice] = await Promise.all([
        client.estimateContractGas({
          address: hongbao,
          abi: hongbaoAbi,
          functionName: "claim",
          args,
          account: relayer.address,
        }),
        client.getGasPrice(),
      ]);
    } catch (e) {
      throw callError(e);
    }
    const gas = (estimate * 13n) / 10n;
    if (gas > MAX_CLAIM_GAS) throw new ApiError("GasLimitTooHigh", 422);
    const cost = estimate * gasPrice;
    if (packet.tipPerShare * TIP_MARGIN_DEN < cost * TIP_MARGIN_NUM) {
      throw new ApiError("TipTooLow", 422, undefined, {
        tipPerShare: packet.tipPerShare.toString(),
        needed: ((cost * TIP_MARGIN_NUM + TIP_MARGIN_DEN - 1n) / TIP_MARGIN_DEN).toString(),
      });
    }

    // 5. Send; the client waits for the receipt.
    const data = encodeFunctionData({ abi: hongbaoAbi, functionName: "claim", args });
    const txHash = await sendClaimTx(env, client, chainId, relayer, hongbao, data, gas);

    return {
      txHash,
      chainId,
      packetId: packetId.toString(),
      recipient,
      relayer: relayer.address,
      attested: attester !== null,
      expected: { amount: amount.toString(), payout: PAYOUTS[paid] ?? "Save" },
    };
  } catch (e) {
    await reservation.release();
    throw e;
  }
}
