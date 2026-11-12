import snapshotJson from '../../public/snapshot.json';
import teamJson from '../../../config/team-wallets.json';
import { getAddress, isAddress, type Address } from 'viem';
import { normalizeStatsPayload, type StatsPayload } from './api';
import type { ChainId } from './chains';

/**
 * public/snapshot.json is bundled at build time, so the landing page shows real
 * numbers even when every network request fails. The page then refreshes live.
 */
interface SnapshotFile {
  version?: number;
  generatedAt?: string | number | null;
  chains?: Record<string, unknown>;
}

const snap = snapshotJson as unknown as SnapshotFile;

export function snapshotFor(chainId: ChainId): StatsPayload {
  const entry = snap.chains?.[String(chainId)];
  const payload = normalizeStatsPayload(entry ?? {});
  if (payload.updatedAt === null && snap.generatedAt) {
    const g = snap.generatedAt;
    payload.updatedAt = typeof g === 'number' ? (g > 1e12 ? g : g * 1000) : Date.parse(g) || null;
  }
  return payload;
}

/* ------------------------------------------------------------------ team wallets */

interface TeamFile {
  wallets?: { address?: string; label?: string }[];
}

const team = new Map<string, string>();
for (const w of (teamJson as unknown as TeamFile).wallets ?? []) {
  if (w.address && isAddress(w.address, { strict: false })) team.set(getAddress(w.address), w.label ?? 'team');
}

/** Add runtime team addresses (our relayer and attester from /api/config). */
export function addTeamAddress(a: string | null | undefined, label: string): void {
  if (a && isAddress(a, { strict: false })) {
    const k = getAddress(a);
    if (!team.has(k)) team.set(k, label);
  }
}

export function isTeam(a: Address | string): boolean {
  try {
    return team.has(getAddress(a));
  } catch {
    return false;
  }
}

export function teamLabel(a: Address | string): string | null {
  try {
    return team.get(getAddress(a)) ?? null;
  } catch {
    return null;
  }
}
