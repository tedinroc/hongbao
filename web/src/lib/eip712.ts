import { hashTypedData, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** Payout enum in Hongbao.sol: 0 Stake, 1 Save, 2 Cash. */
export const Payout = { Stake: 0, Save: 1, Cash: 2 } as const;
export type PayoutValue = (typeof Payout)[keyof typeof Payout];

export function isPayout(n: unknown): n is PayoutValue {
  return n === 0 || n === 1 || n === 2;
}

/** Anyone may submit a claim signed for this relayer (Hongbao.sol: relayer == address(0)). */
export const ANY_RELAYER: Address = '0x0000000000000000000000000000000000000000';

/** Claim(uint256 packetId,address recipient,uint8 payout,address relayer), Hongbao.sol v2. */
export const CLAIM_TYPES = {
  Claim: [
    { name: 'packetId', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'payout', type: 'uint8' },
    { name: 'relayer', type: 'address' },
  ],
} as const;

/** Attest(uint256 packetId,address recipient,uint8 payout,uint256 deadline), Hongbao.sol v2. */
export const ATTEST_TYPES = {
  Attest: [
    { name: 'packetId', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'payout', type: 'uint8' },
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

/**
 * EIP-712 typed data for `Claim(uint256 packetId,address recipient,uint8 payout,address relayer)`.
 * `relayer` is the only address allowed to submit the claim: our relayer's address from
 * /api/config, or ANY_RELAYER when the recipient sends the transaction themselves.
 */
export function claimTypedData(
  chainId: number,
  hongbao: Address,
  packetId: bigint | number | string,
  recipient: Address,
  payout: PayoutValue,
  relayer: Address,
) {
  return {
    domain: hongbaoDomain(chainId, hongbao),
    types: CLAIM_TYPES,
    primaryType: 'Claim' as const,
    message: { packetId: BigInt(packetId), recipient, payout, relayer },
  };
}

/** EIP-712 typed data for `Attest(uint256 packetId,address recipient,uint8 payout,uint256 deadline)`. */
export function attestTypedData(
  chainId: number,
  hongbao: Address,
  packetId: bigint | number | string,
  recipient: Address,
  payout: PayoutValue,
  deadline: bigint | number,
) {
  return {
    domain: hongbaoDomain(chainId, hongbao),
    types: ATTEST_TYPES,
    primaryType: 'Attest' as const,
    message: { packetId: BigInt(packetId), recipient, payout, deadline: BigInt(deadline) },
  };
}

/** The digest Hongbao.claimDigest(id, recipient, payout, relayer) returns on chain. */
export function claimDigest(
  chainId: number,
  hongbao: Address,
  packetId: bigint | number | string,
  recipient: Address,
  payout: PayoutValue,
  relayer: Address,
): Hex {
  return hashTypedData(claimTypedData(chainId, hongbao, packetId, recipient, payout, relayer));
}

/** The digest Hongbao.attestDigest(id, recipient, payout, deadline) returns on chain. */
export function attestDigest(
  chainId: number,
  hongbao: Address,
  packetId: bigint | number | string,
  recipient: Address,
  payout: PayoutValue,
  deadline: bigint | number,
): Hex {
  return hashTypedData(attestTypedData(chainId, hongbao, packetId, recipient, payout, deadline));
}

/**
 * Sign a claim with the link key, bound to `relayer` (see claimTypedData). The key
 * stays in this function's caller; it is never logged or sent anywhere. Only the
 * signature leaves the browser.
 */
export function signClaimWithLinkKey(
  linkKey: Hex,
  chainId: number,
  hongbao: Address,
  packetId: bigint | number | string,
  recipient: Address,
  payout: PayoutValue,
  relayer: Address,
): Promise<Hex> {
  return privateKeyToAccount(linkKey).signTypedData(claimTypedData(chainId, hongbao, packetId, recipient, payout, relayer));
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

function fragmentParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/** Read the link key from a URL fragment such as "#k=0x…&c=0x…". Returns null when absent or malformed. */
export function linkKeyFromHash(hash: string): Hex | null {
  const k = fragmentParams(hash).get('k');
  if (!k) return null;
  const key = (k.startsWith('0x') || k.startsWith('0X') ? `0x${k.slice(2)}` : `0x${k}`).toLowerCase();
  return isPrivateKey(key) ? (key as Hex) : null;
}

export interface LinkFragment {
  key: Hex | null;
  /** True when the link names a contract (`&c=`). Older links carry only `#k=`. */
  hasContract: boolean;
  /** The named Hongbao contract, or null when absent or not an address. */
  contract: Address | null;
}

export function parseLinkFragment(hash: string): LinkFragment {
  const c = fragmentParams(hash).get('c');
  const contract = c && /^0x[0-9a-fA-F]{40}$/.test(c) ? (c as Address) : null;
  return { key: linkKeyFromHash(hash), hasContract: c !== null, contract };
}

/**
 * https://<site>/c/<chainId>/<packetId>#k=<key>&c=<hongbao>. `c` names the contract the
 * packet lives in, so a link made by another deployment is recognised as such.
 */
export function packetLink(
  origin: string,
  chainId: number,
  packetId: bigint | number | string,
  linkKey: Hex,
  hongbao?: Address,
): string {
  const base = `${origin.replace(/\/+$/, '')}/c/${chainId}/${BigInt(packetId).toString()}#k=${linkKey}`;
  return hongbao ? `${base}&c=${hongbao}` : base;
}

/**
 * Whether a claim link belongs to `hongbao` and opens the packet it points to:
 * - `otherDeployment`: the link names a different contract (checked before any read);
 * - `noKey`: the fragment has no usable key;
 * - `keyMismatch`: the key's address is not the packet's claimKey (another deployment's
 *   packet with the same id, or an edited link). Pass `claimKey` once the packet is read.
 */
export function checkLink(
  frag: LinkFragment,
  hongbao: Address,
  claimKey?: Address | null,
): 'ok' | 'otherDeployment' | 'noKey' | 'keyMismatch' {
  if (frag.hasContract && (!frag.contract || frag.contract.toLowerCase() !== hongbao.toLowerCase())) return 'otherDeployment';
  if (!frag.key) return 'noKey';
  if (claimKey && linkKeyAddress(frag.key).toLowerCase() !== claimKey.toLowerCase()) return 'keyMismatch';
  return 'ok';
}
