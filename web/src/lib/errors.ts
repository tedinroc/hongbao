import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';

/**
 * Error codes the UI knows how to explain. Contract custom errors keep their
 * Solidity names; relayer and wallet problems use the lower-case names below.
 * Each code has a message under `err.<code>` in src/i18n.ts.
 */
export const KNOWN_CODES = [
  // Hongbao.sol
  'AlreadyClaimed',
  'Expired',
  'PacketClosed',
  'BadSignature',
  'AttestationExpired',
  'UnknownPacket',
  'ZeroAddress',
  'Paused',
  'BadShares',
  'BadExpiry',
  'BadKey',
  'BadGasKit',
  'MessageTooLong',
  'ShareTooSmall',
  'OverPacketCap',
  'OverOutstandingCap',
  'OverSenderCap',
  'BadRecipient',
  'WrongRelayer',
  'OracleUnavailable',
  'NotPendingGuardian',
  'BadValue',
  'NotRefundable',
  'SlippageTooHigh',
  'InsufficientOutput',
  'NothingToWithdraw',
  'BTCTransferFailed',
  // Tokens, vault, gauge, router
  'ERC20InsufficientBalance',
  'ERC20InsufficientAllowance',
  'InsufficientBalance',
  'AmountTooSmall',
  'ZeroAmount',
  'NotAuthorized',
  'InsufficientOutputAmount',
  'OracleStale',
  // Mezo loan (lib/trove.ts re-checks the loan before withdrawMUSD)
  'LoanBlocked',
  // Relayer / API (functions/_lib/errors.ts)
  'RateLimited',
  'TipTooLow',
  'ForeignAttester',
  'ChainDisabled',
  'NotDeployed',
  'BadRequest',
  'RelayerUnavailable',
  'NetworkBusy',
  // Wallet / network
  'UserRejected',
  'InsufficientFunds',
  'NoWallet',
  'WrongChain',
  'Network',
  'Unknown',
] as const;

export type ErrorCode = (typeof KNOWN_CODES)[number];

const norm = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();

const BY_NORM = new Map<string, ErrorCode>(KNOWN_CODES.map((c) => [norm(c), c]));

// Aliases the relayer (or wallets) might use for the same idea.
const ALIASES: Record<string, ErrorCode> = {
  ratelimit: 'RateLimited',
  toomanyrequests: 'RateLimited',
  toomanyclaims: 'RateLimited',
  limited: 'RateLimited',
  devicelimit: 'RateLimited',
  iplimit: 'RateLimited',
  chainnotenabled: 'ChainDisabled',
  disabled: 'ChainDisabled',
  unsupportedchain: 'ChainDisabled',
  // Codes our Pages Functions return (functions/_lib/errors.ts).
  relayernotconfigured: 'RelayerUnavailable',
  attesternotconfigured: 'RelayerUnavailable',
  relayeroutofgas: 'RelayerUnavailable',
  gaspricetoohigh: 'NetworkBusy',
  gaslimittoohigh: 'NetworkBusy',
  rpcerror: 'RelayerUnavailable',
  forbidden: 'BadRequest',
  devicerequired: 'BadRequest',
  unsupportedmediatype: 'BadRequest',
  payloadtoolarge: 'BadRequest',
  methodnotallowed: 'BadRequest',
  simulationreverted: 'Unknown',
  notconfigured: 'NotDeployed',
  nocontract: 'NotDeployed',
  notfound: 'UnknownPacket',
  unknownpacketid: 'UnknownPacket',
  packetnotfound: 'UnknownPacket',
  closed: 'PacketClosed',
  empty: 'PacketClosed',
  refunded: 'PacketClosed',
  expiredpacket: 'Expired',
  claimed: 'AlreadyClaimed',
  invalidsignature: 'BadSignature',
  badsig: 'BadSignature',
  invalidrequest: 'BadRequest',
  badinput: 'BadRequest',
  validation: 'BadRequest',
  invalidrecipient: 'BadRequest',
  relayerfailed: 'RelayerUnavailable',
  relayerbroke: 'RelayerUnavailable',
  relayeroutoffunds: 'RelayerUnavailable',
  internal: 'RelayerUnavailable',
  internalerror: 'RelayerUnavailable',
  sendfailed: 'RelayerUnavailable',
  userrejectedrequest: 'UserRejected',
  userdenied: 'UserRejected',
  insufficientfundsforgas: 'InsufficientFunds',
};

/** Map any code-ish string to a known code, or null. */
export function normalizeCode(raw: unknown): ErrorCode | null {
  if (typeof raw !== 'string' || !raw) return null;
  const n = norm(raw);
  return BY_NORM.get(n) ?? ALIASES[n] ?? null;
}

/** Error carrying a known code plus optional server/wallet detail text. */
export class HongbaoError extends Error {
  code: ErrorCode;
  detail?: string;
  status?: number;
  constructor(code: ErrorCode, detail?: string, status?: number) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'HongbaoError';
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

function searchText(text: string): ErrorCode | null {
  // Custom error names inside revert text, e.g. 'reverted with custom error AlreadyClaimed()'.
  const m = text.match(/\b([A-Z][A-Za-z0-9]+)\(\)/g);
  if (m) {
    for (const hit of m) {
      const c = normalizeCode(hit.slice(0, -2));
      if (c) return c;
    }
  }
  if (/Oracle is stale/i.test(text)) return 'OracleStale';
  // Mezo's BorrowerOperations reverts with require strings such as "BorrowerOps: An operation that would result in ICR < MCR is not permitted".
  if (/BorrowerOps:|TroveManager:/.test(text)) return 'LoanBlocked';
  if (/user (rejected|denied)|rejected the request|request rejected/i.test(text)) return 'UserRejected';
  if (/insufficient funds/i.test(text)) return 'InsufficientFunds';
  if (/failed to fetch|networkerror|network request failed|load failed|timed? ?out/i.test(text)) return 'Network';
  for (const c of KNOWN_CODES) {
    if (c.length > 6 && text.includes(c)) return c;
  }
  return null;
}

/** Best-effort error code for anything thrown by viem, a wallet, fetch or our API. */
export function errorCode(err: unknown): ErrorCode {
  if (err instanceof HongbaoError) return err.code;
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      const c = normalizeCode(name);
      if (c) return c;
      const reason = reverted.reason ?? '';
      const r = searchText(reason);
      if (r) return r;
    }
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return 'UserRejected';
    const found = searchText(`${err.shortMessage}\n${err.details ?? ''}`);
    if (found) return found;
    return 'Unknown';
  }
  if (err && typeof err === 'object') {
    const o = err as { code?: unknown; message?: unknown; name?: unknown };
    if (o.code === 4001 || o.code === 'ACTION_REJECTED') return 'UserRejected';
    if (o.code === 4902) return 'WrongChain';
    const fromName = normalizeCode(o.name);
    if (fromName) return fromName;
    if (typeof o.message === 'string') {
      const found = searchText(o.message);
      if (found) return found;
    }
  }
  if (typeof err === 'string') return searchText(err) ?? 'Unknown';
  return 'Unknown';
}

/** Short human detail for "Unknown" errors (never includes secrets: we never put them in errors). */
export function errorDetail(err: unknown): string {
  if (err instanceof HongbaoError) return err.detail ?? '';
  if (err instanceof BaseError) return err.shortMessage;
  if (err instanceof Error) return err.message.slice(0, 240);
  if (typeof err === 'string') return err.slice(0, 240);
  return '';
}
