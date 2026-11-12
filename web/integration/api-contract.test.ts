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
import { MEZO } from '../functions/_lib/chains';
import type { Env } from '../functions/_lib/env';
import { limitsFor } from '../functions/_lib/limits';
import { protocolAddresses } from '../functions/_lib/relay';
import { handleClaim } from '../functions/api/claim';
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
    // v2 relayer policy and contract errors must reach the UI under their own names.
    for (const c of ['TipTooLow', 'WrongRelayer', 'BadRecipient', 'DeviceRequired', 'RateLimited']) expect(codes).toContain(c);
    const unmapped = codes.filter((c) => normalizeCode(c) === null);
    expect(unmapped).toEqual([]);
    for (const c of ['TipTooLow', 'WrongRelayer', 'BadRecipient']) expect(normalizeCode(c)).toBe(c);
  });

  it('every Hongbao custom error a sender or recipient can hit has a UI code', () => {
    const abi = (Array.isArray(hongbaoAbiJson) ? hongbaoAbiJson : (hongbaoAbiJson as { abi: unknown[] }).abi) as {
      type: string;
      name?: string;
    }[];
    // Guardian-only and library-internal errors are never shown to a user.
    // (v2 reverts malformed signatures as BadSignature, so no ECDSA* errors remain in the ABI.)
    const internal = new Set([
      'NotGuardian',
      'CapAboveHardCap',
      'AddressEmptyCode',
      'AddressInsufficientBalance',
      'FailedInnerCall',
      'SafeERC20FailedOperation',
      'InvalidShortString',
      'StringTooLong',
      'ReentrancyGuardReentrantCall',
    ]);
    const all = abi.filter((x) => x.type === 'error' && x.name).map((x) => x.name!);
    expect(all.filter((n) => n.startsWith('ECDSA'))).toEqual([]);
    for (const n of ['BadRecipient', 'WrongRelayer', 'OverSenderCap', 'OracleUnavailable', 'NotPendingGuardian']) expect(all).toContain(n);
    const names = all.filter((n) => !internal.has(n));
    expect(names.length).toBeGreaterThan(15);
    expect(names.filter((n) => normalizeCode(n) !== n)).toEqual([]);
  });

  it('EIP-712 types and domain are identical on both sides and match the v2 type hashes', () => {
    expect(fe712.CLAIM_TYPES).toEqual(fn712.CLAIM_TYPES);
    expect(fe712.ATTEST_TYPES).toEqual(fn712.ATTEST_TYPES);
    const typeString = (name: string, fields: readonly { name: string; type: string }[]) =>
      `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
    expect(typeString('Claim', fn712.CLAIM_TYPES.Claim)).toBe('Claim(uint256 packetId,address recipient,uint8 payout,address relayer)');
    expect(typeString('Attest', fn712.ATTEST_TYPES.Attest)).toBe('Attest(uint256 packetId,address recipient,uint8 payout,uint256 deadline)');
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
    const relayer: Address = privateKeyToAccount(generatePrivateKey()).address;
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
        const keySig: Hex = await fe712.signClaimWithLinkKey(linkKey, 31611, hb, id, recipient, payout, relayer);
        await postClaim({ chainId: 31611, packetId: id, recipient, payout, keySig, relayer, device: deviceId() });
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
      expect(parseAddress(b.relayer, 'relayer')).toBe(relayer);
      expect(parseDevice(b.device)).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe('relayer policy checks that run before any chain read', () => {
  // A relayer key and a Hongbao address are configured, but the RPC points nowhere:
  // every case below must be refused before the handler touches the network.
  const relayerKey = generatePrivateKey();
  const RELAYER = privateKeyToAccount(relayerKey).address;
  const HB = getAddress('0x58b3e7ba79feff7fa7dd9d15f861ff19eda98d8c');
  const env: Env = { RELAYER_PRIVATE_KEY: relayerKey, HONGBAO_31611: HB, RPC_31611: 'http://127.0.0.1:9' };
  const ORIGIN = 'https://hongbao.test';

  async function post(body: Record<string, unknown>) {
    const request = new Request(`${ORIGIN}/api/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '198.51.100.7' },
      body: JSON.stringify(body),
    });
    const res = await handleClaim({ request, env });
    return { status: res.status, body: (await res.json()) as { error: string; relayer?: string; field?: string } };
  }

  const base = {
    chainId: 31611,
    packetId: 1,
    recipient: privateKeyToAccount(generatePrivateKey()).address,
    payout: 0,
    keySig: `0x${'11'.repeat(65)}`,
    device: 'device-0123456789',
  };

  it('refuses every protocol address as recipient with BadRecipient (mirrors Hongbao.claim)', async () => {
    const m = MEZO[31611];
    expect(protocolAddresses(31611, HB)).toEqual([HB, m.smusd, m.gauge, m.musd, m.btc]);
    for (const recipient of protocolAddresses(31611, HB)) {
      for (const spelling of [recipient, recipient.toLowerCase()]) {
        const r = await post({ ...base, recipient: spelling });
        expect(r.status, spelling).toBe(400);
        expect(r.body.error, spelling).toBe('BadRecipient');
      }
    }
  });

  it('refuses a claim signed for another relayer (or for anyone) with WrongRelayer and names ours', async () => {
    for (const relayer of [privateKeyToAccount(generatePrivateKey()).address, fe712.ANY_RELAYER]) {
      const r = await post({ ...base, relayer });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('WrongRelayer');
      expect(r.body.relayer).toBe(RELAYER);
    }
    const bad = await post({ ...base, relayer: '0x1234' });
    expect(bad.body.error).toBe('BadRequest');
  });

  it('requires a device id on every packet', async () => {
    const { device: _omit, ...noDevice } = base;
    void _omit;
    const r = await post({ ...noDevice, relayer: RELAYER });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('DeviceRequired');
  });

  it('defaults to 1 claim per device and 5 per IP per packet, 20 per IP per hour', () => {
    expect(limitsFor({})).toEqual({ devicePerPacket: 1, ipPerPacket: 5, ipPerHour: 20 });
    expect(limitsFor({ LIMIT_IP_PER_PACKET: '2' }).ipPerPacket).toBe(2);
  });
});
