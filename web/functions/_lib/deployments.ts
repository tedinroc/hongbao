import { getAddress, isAddress, type Address } from "viem";
import deploymentsJson from "../../../config/deployments.json";
import type { ChainId } from "./chains";
import type { Env } from "./env";

interface DeploymentEntry {
  name?: string;
  hongbao: string | null;
  deployBlock: number | null;
  enabled: boolean;
}

const deployments = deploymentsJson as unknown as Record<string, DeploymentEntry | undefined>;

export function chainName(id: ChainId): string {
  return deployments[String(id)]?.name ?? (id === 31611 ? "Mezo testnet" : "Mezo mainnet");
}

/** Hongbao address: env HONGBAO_<chainId> overrides config/deployments.json. */
export function hongbaoAddress(env: Env, id: ChainId): Address | null {
  const override = id === 31611 ? env.HONGBAO_31611 : env.HONGBAO_31612;
  const raw = (override && override.trim()) || deployments[String(id)]?.hongbao || null;
  if (!raw || !isAddress(raw, { strict: false })) return null;
  return getAddress(raw);
}

/** Block the contract was deployed in (lower bound for event scans), if known. */
export function deployBlock(env: Env, id: ChainId): bigint | null {
  const override = id === 31611 ? env.DEPLOY_BLOCK_31611 : env.DEPLOY_BLOCK_31612;
  const raw = override && override.trim() !== "" ? override.trim() : deployments[String(id)]?.deployBlock;
  if (raw === null || raw === undefined) return null;
  const s = String(raw);
  if (!/^\d{1,15}$/.test(s)) return null;
  return BigInt(s);
}

/** A chain is live when config enables it and a Hongbao address is known. */
export function chainEnabled(env: Env, id: ChainId): boolean {
  return Boolean(deployments[String(id)]?.enabled) && hongbaoAddress(env, id) !== null;
}
