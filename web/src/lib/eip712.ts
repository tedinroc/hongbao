import { hashTypedData, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** Payout enum in Hongbao.sol: 0 Stake, 1 Save, 2 Cash. */
export const Payout = { Stake: 0, Save: 1, Cash: 2 } as const;
export type PayoutValue = (typeof Payout)[keyof typeof Payout];

export function isPayout(n: unknown): n is PayoutValue {
  return n === 0 || n === 1 || n === 2;
}

export const CLAIM_TYPES = {
  Claim: [
    { name: 'packetId', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'payout', type: 'uint8' },
  ],
} as const;

export const ATTEST_TYPES = {
  Attest: [
    { name: 'packetId', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export function hongbaoDomain(chainId: number, hongbao: Address) {
  return { name: 'Hongbao', version: '1', chainId, verifyingContract: hongbao } as const;
}

/** EIP-712 typed data for `Claim(uint256 packetId,address recipient,uint8 payout)`. */
export function claimTypedData(
  chainId: number,
  hongbao: Address,
  packetId: bigint | number | string,
  recipient: Address,
  payout: PayoutValue,
) {
  return {
    domain: hongbaoDomain(chainId, hongbao),
    types: CLAIM_TYPES,
    primaryType: 'Claim' as const,
    message: { packetId: BigInt(packetId), recipient, payout },
  };
}

/** EIP-712 typed data for `Attest(uint256 packetId,address recipient,uint256 deadline)`. */
export function attestTypedData(
  chainId: number,
  hongbao: Address,
  packetId: bigint | number | string,
  recipient: Address,
  deadline: bigint | number,
) {
  return {
    domain: hongbaoDomain(chainId, hongbao),
    types: ATTEST_TYPES,
    primaryType: 'Attest' as const,
    message: { packetId: BigInt(packetId), recipient, deadline: BigInt(deadline) },
  };
}

/** The digest Hongbao.claimDigest(id, recipient, payout) returns on chain. */
export function claimDigest(
  chainId: number,
  hongbao: Address,
  packetId: bigint | number | string,
  recipient: Address,
  payout: PayoutValue,
): Hex {
  return hashTypedData(claimTypedData(chainId, hongbao, packetId, recipient, payout));
}

/**
 * Sign a claim with the link key. The key stays in this function's caller; it is
 * never logged or sent anywhere. Only the signature leaves the browser.
 */
export function signClaimWithLinkKey(
  linkKey: Hex,
  chainId: number,
  hongbao: Address,
  packetId: bigint | number | string,
  recipient: Address,
  payout: PayoutValue,
): Promise<Hex> {
  return privateKeyToAccount(linkKey).signTypedData(claimTypedData(chainId, hongbao, packetId, recipient, payout));
}

/** Address the link key controls (what the packet stores as `claimKey`). */
export function linkKeyAddress(linkKey: Hex): Address {
  return privateKeyToAccount(linkKey).address;
}

export interface PermitArgs {
  chainId: number;
  token: Address;
  owner: Address;
  spender: Address;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
  /** Token EIP-712 name; MUSD uses "Mezo USD". */
  name?: string;
  version?: string;
}

/** EIP-2612 permit typed data on the MUSD domain {name:"Mezo USD", version:"1"}. */
export function permitTypedData(a: PermitArgs) {
  return {
    domain: {
      name: a.name ?? 'Mezo USD',
      version: a.version ?? '1',
      chainId: a.chainId,
      verifyingContract: a.token,
    },
    types: PERMIT_TYPES,
    primaryType: 'Permit' as const,
    message: { owner: a.owner, spender: a.spender, value: a.value, nonce: a.nonce, deadline: a.deadline },
  };
}

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export function isPrivateKey(v: unknown): v is Hex {
  if (typeof v !== 'string' || !KEY_RE.test(v)) return false;
  // secp256k1: 0 < k < n
  const k = BigInt(v);
  return k > 0n && k < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
}

/** Read the link key from a URL fragment such as "#k=0x…". Returns null when absent or malformed. */
export function linkKeyFromHash(hash: string): Hex | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(h);
  const k = params.get('k');
  if (!k) return null;
  const key = (k.startsWith('0x') || k.startsWith('0X') ? `0x${k.slice(2)}` : `0x${k}`).toLowerCase();
  return isPrivateKey(key) ? (key as Hex) : null;
}

/** https://<site>/c/<chainId>/<packetId>#k=<key> */
export function packetLink(origin: string, chainId: number, packetId: bigint | number | string, linkKey: Hex): string {
  return `${origin.replace(/\/+$/, '')}/c/${chainId}/${BigInt(packetId).toString()}#k=${linkKey}`;
}
