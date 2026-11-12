import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from "viem";
import { hongbaoAbi } from "./abi";

/** A failure the API reports as `{ error: code, message }` with an HTTP status. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message?: string,
    public readonly extra?: Record<string, unknown>,
    public readonly headers?: Record<string, string>,
  ) {
    super(message ?? MESSAGES[code] ?? code);
  }
}

/** Plain-English fallback messages; the web app localises by `error` code. */
const MESSAGES: Record<string, string> = {
  // Contract errors (decoded from reverts)
  UnknownPacket: "This red packet does not exist on this network.",
  PacketClosed: "This red packet is empty or was refunded.",
  Expired: "This red packet has expired.",
  AlreadyClaimed: "This wallet already opened this red packet.",
  BadSignature: "The link signature does not match this packet. Check that the whole link was copied.",
  AttestationExpired: "The approval for this claim timed out. Please try again.",
  ZeroAddress: "The receiving address is empty.",
  BadRecipient: "A red packet cannot be paid to a Hongbao or Mezo token contract. Use a wallet address.",
  WrongRelayer: "This claim was signed for a different claim service. Reload the page and try again.",
  OverSenderCap: "This sender already has the most MUSD allowed in open red packets.",
  OracleUnavailable: "The BTC price feed is unavailable right now. Pay with MUSD or try again shortly.",
  NotPendingGuardian: "Only the proposed guardian can accept the role.",
  Paused: "New red packets are paused.",
  ReentrancyGuardReentrantCall: "The contract refused a re-entrant call.",
  // Relayer errors
  BadRequest: "The request is not valid.",
  Forbidden: "Requests from other sites are not accepted.",
  MethodNotAllowed: "Method not allowed.",
  UnsupportedMediaType: "Send JSON with Content-Type: application/json.",
  PayloadTooLarge: "The request body is too large.",
  UnsupportedChain: "This network is not supported.",
  ChainDisabled: "Red packets are not enabled on this network yet.",
  RelayerNotConfigured: "Free claiming is not available on this network right now.",
  AttesterNotConfigured: "One-per-person approval is not available right now.",
  ForeignAttester: "This red packet needs approval from a service other than this site.",
  DeviceRequired: "The device id is missing. Each phone can open a red packet once; reload the page and try again.",
  RateLimited: "Too many claims from this device or network. Please try again later.",
  RelayerOutOfGas: "The free-claim service is out of BTC for gas right now. Please try again later.",
  GasPriceTooHigh: "Network fees are unusually high right now. Please try again later.",
  GasLimitTooHigh: "This claim needs more gas than the relayer allows.",
  TipTooLow: "This red packet's relay tip does not cover the network fee, so the free-claim service cannot send it.",
  SimulationReverted: "The claim would fail on chain.",
  SendFailed: "The network did not accept the claim transaction. Please try again.",
  RpcError: "The Mezo network did not respond. Please try again.",
  NotFound: "Not found.",
  InternalError: "Something went wrong.",
};

const REVERT_STATUS: Record<string, number> = {
  UnknownPacket: 404,
  PacketClosed: 410,
  Expired: 410,
  AlreadyClaimed: 409,
  BadSignature: 400,
  AttestationExpired: 409,
  ZeroAddress: 400,
  BadRecipient: 400,
  WrongRelayer: 409,
};

export interface DecodedRevert {
  name: string;
  args?: readonly unknown[];
  selector?: Hex;
}

function findRevertData(err: unknown, depth = 0): Hex | undefined {
  if (!err || typeof err !== "object" || depth > 8) return undefined;
  const e = err as { data?: unknown; cause?: unknown };
  if (typeof e.data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(e.data)) return e.data as Hex;
  if (e.data && typeof e.data === "object") {
    const inner = (e.data as { data?: unknown }).data;
    if (typeof inner === "string" && /^0x[0-9a-fA-F]{8,}$/.test(inner)) return inner as Hex;
  }
  return findRevertData(e.cause, depth + 1);
}

/** Decode a revert from any viem error (simulate, estimateGas, call) into its custom-error name. */
export function decodeRevert(err: unknown): DecodedRevert | null {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      if (reverted.data?.errorName) {
        if (reverted.data.errorName === "Error" && reverted.reason) return { name: "Error", args: [reverted.reason] };
        return { name: reverted.data.errorName, args: reverted.data.args };
      }
      if (reverted.reason) return { name: "Error", args: [reverted.reason] };
      if (reverted.signature) return { name: "UnknownError", selector: reverted.signature };
    }
  }
  const data = findRevertData(err);
  if (data) {
    try {
      const d = decodeErrorResult({ abi: hongbaoAbi, data });
      return { name: d.errorName, args: d.args };
    } catch {
      return { name: "UnknownError", selector: data.slice(0, 10) as Hex };
    }
  }
  return null;
}

/** Turn a decoded revert into an ApiError (keeps the contract's error name as the code). */
export function revertToApiError(d: DecodedRevert): ApiError {
  const status = REVERT_STATUS[d.name];
  if (status) return new ApiError(d.name, status);
  const extra: Record<string, unknown> = { revert: d.name };
  if (d.selector) extra.selector = d.selector;
  if (d.name === "Error" && typeof d.args?.[0] === "string") extra.reason = d.args[0].slice(0, 200);
  return new ApiError("SimulationReverted", 422, `${MESSAGES.SimulationReverted} (${d.name})`, extra);
}

/** Short, secret-free description of an unexpected error for server logs. */
export function logSafe(err: unknown): string {
  if (err instanceof BaseError) return `${err.name}: ${err.shortMessage}`.slice(0, 300);
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300);
  return "unknown error";
}
