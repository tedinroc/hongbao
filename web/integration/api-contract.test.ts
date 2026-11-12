/**
 * Front end <-> Pages Functions agreement that needs no chain: runs in `npm test`.
 * (claim-relay.test.ts checks the same seams end to end on an anvil fork.)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { deviceId, postClaim } from '../src/lib/api';
import * as fe712 from '../src/lib/eip712';
import { normalizeCode } from '../src/lib/errors';
import * as fn712 from '../functions/_lib/eip712';
import {
  parseAddress,
  parseChainId,
  parseDevice,
  parsePacketId,
  parsePayout,
  parseSignature,
} from '../functions/_lib/validate';
import hongbaoAbiJson from '../../shared/Hongbao.abi.json';

const FUNCTIONS_DIR = fileURLToPath(new URL('../functions', import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Every `error` code the functions can put in a response body. */
function serverErrorCodes(): string[] {
  const codes = new Set<string>();
  for (const f of tsFiles(FUNCTIONS_DIR)) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/new ApiError\(\s*"([A-Za-z]+)"/g)) codes.add(m[1]);
    for (const m of src.matchAll(/\berror:\s*"([A-Za-z]+)"/g)) codes.add(m[1]);
    // revertToApiError keeps contract error names listed in REVERT_STATUS as the code.
    const rs = /REVERT_STATUS[^{]*\{([^}]*)\}/.exec(src);
    if (rs) for (const m of rs[1].matchAll(/([A-Za-z]+)\s*:/g)) codes.add(m[1]);
  }
  return [...codes].sort();
}

describe('front end and relayer agree', () => {
  it('every error code the relayer can return maps to a code the UI explains', () => {
    const codes = serverErrorCodes();
    expect(codes.length).toBeGreaterThan(20);
    const unmapped = codes.filter((c) => normalizeCode(c) === null);
    expect(unmapped).toEqual([]);
  });

  it('every Hongbao custom error a sender or recipient can hit has a UI code', () => {
    const abi = (Array.isArray(hongbaoAbiJson) ? hongbaoAbiJson : (hongbaoAbiJson as { abi: unknown[] }).abi) as {
      type: string;
      name?: string;
    }[];
    // Guardian-only and library-internal errors are never shown to a user.
    const internal = new Set([
      'NotGuardian',
      'CapAboveHardCap',
      'AddressEmptyCode',
      'AddressInsufficientBalance',
      'FailedInnerCall',
      'SafeERC20FailedOperation',
      'InvalidShortString',
      'StringTooLong',
      'ECDSAInvalidSignature',
      'ECDSAInvalidSignatureLength',
      'ECDSAInvalidSignatureS',
      'ReentrancyGuardReentrantCall',
    ]);
    const names = abi.filter((x) => x.type === 'error' && x.name && !internal.has(x.name)).map((x) => x.name!);
    expect(names.length).toBeGreaterThan(15);
    expect(names.filter((n) => normalizeCode(n) !== n)).toEqual([]);
  });

  it('EIP-712 types and domain are identical on both sides', () => {
    expect(fe712.CLAIM_TYPES).toEqual(fn712.CLAIM_TYPES);
    expect(fe712.ATTEST_TYPES).toEqual(fn712.ATTEST_TYPES);
    const hb = getAddress('0x58b3e7ba79feff7fa7dd9d15f861ff19eda98d8c');
    for (const chainId of [31611, 31612]) {
      expect(fe712.hongbaoDomain(chainId, hb)).toEqual(fn712.hongbaoDomain(chainId, hb));
    }
  });

  it('the body postClaim sends passes every relayer validator, including ids beyond 2^53', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    const hb = getAddress('0x58b3e7ba79feff7fa7dd9d15f861ff19eda98d8c');
    const linkKey = generatePrivateKey();
    const recipient: Address = privateKeyToAccount(generatePrivateKey()).address;
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ txHash: `0x${'ab'.repeat(32)}` }), { status: 200 });
      }),
    );
    for (const id of [1n, 2n ** 60n]) {
      for (const payout of [0, 1, 2] as const) {
        const keySig: Hex = await fe712.signClaimWithLinkKey(linkKey, 31611, hb, id, recipient, payout);
        await postClaim({ chainId: 31611, packetId: id, recipient, payout, keySig, device: deviceId() });
      }
    }
    vi.unstubAllGlobals();
    expect(bodies).toHaveLength(6);
    for (const b of bodies) {
      expect(parseChainId(b.chainId)).toBe(31611);
      expect([1n, 2n ** 60n]).toContain(parsePacketId(b.packetId));
      expect(parseAddress(b.recipient, 'recipient')).toBe(recipient);
      expect([0, 1, 2]).toContain(parsePayout(b.payout));
      expect(parseSignature(b.keySig, 'keySig')).toMatch(/^0x[0-9a-f]{130}$/);
      expect(parseDevice(b.device)).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});
