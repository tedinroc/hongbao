import type { Address } from "viem";

/**
 * EIP-712 shapes matching Hongbao.sol v2 (CLAIM_TYPEHASH / ATTEST_TYPEHASH):
 *   Claim(uint256 packetId,address recipient,uint8 payout,address relayer)
 *   Attest(uint256 packetId,address recipient,uint8 payout,uint256 deadline)
 */
export const CLAIM_TYPES = {
  Claim: [
    { name: "packetId", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "payout", type: "uint8" },
    { name: "relayer", type: "address" },
  ],
} as const;

export const ATTEST_TYPES = {
  Attest: [
    { name: "packetId", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "payout", type: "uint8" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function hongbaoDomain(chainId: number, verifyingContract: Address) {
  return { name: "Hongbao", version: "1", chainId, verifyingContract } as const;
}

/** Seconds an attestation stays valid (SPEC.md: deadline = now + 600). */
export const ATTEST_TTL = 600;
