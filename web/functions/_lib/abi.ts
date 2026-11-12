import type { Abi, Address } from "viem";
import hongbaoAbiJson from "../../../shared/Hongbao.abi.json";

/** Hongbao ABI, generated from contracts/src/Hongbao.sol (single source of truth). */
export const hongbaoAbi = hongbaoAbiJson as Abi;

export const PAYOUTS = ["Stake", "Save", "Cash"] as const;
export type PayoutName = (typeof PAYOUTS)[number];

/** Decoded `getPacket(id)` tuple. */
export interface PacketView {
  sender: Address;
  expiry: bigint;
  sharesTotal: number;
  claimKey: Address;
  sharesLeft: number;
  refunded: boolean;
  attester: Address;
  dripPerShare: bigint;
  remaining: bigint;
  tipPerShare: bigint;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
