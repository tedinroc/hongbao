import type { Address } from "viem";

/** EIP-712 shapes matching Hongbao.sol (CLAIM_TYPEHASH / ATTEST_TYPEHASH). */
export const CLAIM_TYPES = {
  Claim: [
    { name: "packetId", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "payout", type: "uint8" },
  ],
} as const;

export const ATTEST_TYPES = {
  Attest: [
    { name: "packetId", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function hongbaoDomain(chainId: number, verifyingContract: Address) {
  return { name: "Hongbao", version: "1", chainId, verifyingContract } as const;
}

/** Seconds an attestation stays valid (SPEC.md: deadline = now + 600). */
export const ATTEST_TTL = 600;
