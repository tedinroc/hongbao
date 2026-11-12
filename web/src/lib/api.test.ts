import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult } from 'viem';
import { hongbaoWithErrorsAbi } from '../abi/extra';
import {
  apiErrorFrom,
  getConfig,
  getStatsApi,
  normalizePacket,
  normalizeStatsPayload,
  postClaim,
  toAmount,
} from './api';
import { errorCode, HongbaoError, normalizeCode } from './errors';
import { dictionaries, type MessageKey } from '../i18n';
import { KNOWN_CODES } from './errors';

afterEach(() => vi.unstubAllGlobals());

describe('error codes', () => {
  it('normalizes the relayer’s spellings to contract error names', () => {
    expect(normalizeCode('AlreadyClaimed')).toBe('AlreadyClaimed');
    expect(normalizeCode('already_claimed')).toBe('AlreadyClaimed');
    expect(normalizeCode('ALREADY_CLAIMED')).toBe('AlreadyClaimed');
    expect(normalizeCode('rate_limited')).toBe('RateLimited');
    expect(normalizeCode('too_many_requests')).toBe('RateLimited');
    expect(normalizeCode('nope')).toBeNull();
  });

  it('reads codes from the shapes an API error can take', () => {
    expect(apiErrorFrom(409, { error: 'AlreadyClaimed' }).code).toBe('AlreadyClaimed');
    expect(apiErrorFrom(400, { error: { code: 'Expired', message: 'too late' } }).code).toBe('Expired');
    expect(apiErrorFrom(400, { ok: false, code: 'packet_closed' }).code).toBe('PacketClosed');
    expect(apiErrorFrom(500, { error: 'simulation failed: BadSignature()' }).code).toBe('BadSignature');
    expect(apiErrorFrom(429, { error: 'slow down' }).code).toBe('RateLimited');
    expect(apiErrorFrom(502, '<html>').code).toBe('RelayerUnavailable');
  });

  it('maps every relayer code from functions/_lib/errors.ts', () => {
    const cases: Record<string, string> = {
      RateLimited: 'RateLimited',
      ForeignAttester: 'ForeignAttester',
      ChainDisabled: 'ChainDisabled',
      UnsupportedChain: 'ChainDisabled',
      RelayerNotConfigured: 'RelayerUnavailable',
      AttesterNotConfigured: 'RelayerUnavailable',
      RelayerOutOfGas: 'RelayerUnavailable',
      GasPriceTooHigh: 'NetworkBusy',
      GasLimitTooHigh: 'NetworkBusy',
      SendFailed: 'RelayerUnavailable',
      RpcError: 'RelayerUnavailable',
      InternalError: 'RelayerUnavailable',
      DeviceRequired: 'BadRequest',
      Forbidden: 'BadRequest',
      BadRequest: 'BadRequest',
      SimulationReverted: 'Unknown',
      UnknownPacket: 'UnknownPacket',
      TipTooLow: 'TipTooLow',
      WrongRelayer: 'WrongRelayer',
      BadRecipient: 'BadRecipient',
    };
    for (const [code, want] of Object.entries(cases)) {
      expect(apiErrorFrom(400, { error: code, message: 'x' }).code, code).toBe(want);
    }
    // functions/_lib/errors.ts revertToApiError: the inner revert name wins when we know it.
    expect(apiErrorFrom(422, { error: 'SimulationReverted', revert: 'ERC20InsufficientBalance', message: 'x' }).code).toBe(
      'ERC20InsufficientBalance',
    );
    expect(apiErrorFrom(422, { error: 'SimulationReverted', revert: 'Error', reason: 'boom', message: 'x' }).code).toBe('Unknown');
  });

  it('decodes a contract custom error thrown through viem', () => {
    const data = encodeErrorResult({ abi: hongbaoWithErrorsAbi, errorName: 'AttestationExpired' });
    const err = new BaseError('reverted', {
      cause: new ContractFunctionRevertedError({ abi: hongbaoWithErrorsAbi, data, functionName: 'claim' }),
    });
    expect(errorCode(err)).toBe('AttestationExpired');
  });

  it('decodes MUSD’s allowance error bubbling up through Hongbao', () => {
    const data = encodeErrorResult({
      abi: hongbaoWithErrorsAbi,
      errorName: 'ERC20InsufficientAllowance',
      args: ['0x0000000000000000000000000000000000000001', 0n, 5n],
    });
    const err = new BaseError('reverted', {
      cause: new ContractFunctionRevertedError({ abi: hongbaoWithErrorsAbi, data, functionName: 'createWithPermit' }),
    });
    expect(errorCode(err)).toBe('ERC20InsufficientAllowance');
  });

  it('maps wallet rejection and fetch failures', () => {
    expect(errorCode({ code: 4001, message: 'User rejected the request.' })).toBe('UserRejected');
    expect(errorCode(new TypeError('Failed to fetch'))).toBe('Network');
    expect(errorCode(new HongbaoError('Paused'))).toBe('Paused');
  });

  it('every code has a message in both languages', () => {
    for (const lang of ['en', 'zh-Hant'] as const) {
      for (const c of KNOWN_CODES) {
        const msg = dictionaries[lang][`err.${c}` as MessageKey];
        expect(msg, `${lang} err.${c}`).toBeTruthy();
      }
    }
  });
});

describe('response normalizers', () => {
  it('stats: object with stats + recent', () => {
    const p = normalizeStatsPayload({
      stats: { packets: '3', claims: 7, volume: '29700000000000000000', recipients: '6', senders: '2', open: '9900000000000000000' },
      recent: [
        { event: 'Claimed', id: '2', recipient: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', amount: '3300000000000000000', txHash: `0x${'ab'.repeat(32)}`, blockNumber: '100' },
        { type: 'PacketCreated', args: { id: 3n, sender: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', net: '9.9' } },
        { event: 'Something' },
      ],
      updatedAt: 1_800_000_000,
    });
    expect(p.stats.packets).toBe(3n);
    expect(p.stats.claims).toBe(7n);
    expect(p.stats.volume).toBe(29_700_000_000_000_000_000n);
    expect(p.stats.open).toBe(9_900_000_000_000_000_000n);
    expect(p.recent).toHaveLength(2);
    expect(p.recent[0].kind).toBe('claimed');
    expect(p.recent[0].address).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(p.recent[1].kind).toBe('created');
    expect(p.recent[1].amount).toBe(9_900_000_000_000_000_000n);
    expect(p.updatedAt).toBe(1_800_000_000_000);
  });

  it('stats: the exact /api/stats shape from functions/_lib/types.ts', () => {
    const p = normalizeStatsPayload({
      chainId: 31611,
      hongbao: '0x1234567890AbcdEF1234567890aBcdef12345678',
      stats: { packets: '2', claims: '1', volume: '19800000000000000000', recipients: '1', senders: '1', open: '16500000000000000000' },
      recent: {
        created: [
          { id: '1', sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', net: '9900000000000000000', fee: '100000000000000000', shares: 3, expiry: 1800086400, funding: 'MUSD', claimKey: '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7', attester: '0x0000000000000000000000000000000000000000', message: 'hi', blockNumber: 10, txHash: `0x${'01'.repeat(32)}`, timestamp: 1800000000 },
          { id: '2', sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', net: '9900000000000000000', fee: '100000000000000000', shares: 3, expiry: 1800086400, funding: 'BTC', claimKey: '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7', attester: '0x0000000000000000000000000000000000000000', message: 'yo', blockNumber: 30, txHash: `0x${'02'.repeat(32)}`, timestamp: null },
        ],
        claimed: [
          { id: '1', recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', relayer: '0x7B5903E4c4F660cd916f0531BF5eD9De03252c54', amount: '3300000000000000000', payout: 'Stake', blockNumber: 20, txHash: `0x${'03'.repeat(32)}`, timestamp: 1800000100 },
        ],
        refunded: [],
        fromBlock: 0,
        toBlock: 40,
      },
      block: { number: 40, timestamp: 1800000200 },
    });
    expect(p.stats.packets).toBe(2n);
    expect(p.recent.map((e) => `${e.kind}:${e.id}`)).toEqual(['created:2', 'claimed:1', 'created:1']);
    expect(p.recent[1].payout).toBe(0);
    expect(p.recent[1].amount).toBe(3_300_000_000_000_000_000n);
    expect(p.recent[2].timestamp).toBe(1800000000);
    expect(p.updatedAt).toBe(1_800_000_200_000);
  });

  it('packet: the exact /api/packet shape (message comes from `created`)', () => {
    const p = normalizePacket({
      chainId: 31611,
      id: '1',
      status: 'open',
      packet: {
        sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        expiry: 1800086400,
        sharesTotal: 3,
        claimKey: '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7',
        sharesLeft: 2,
        refunded: false,
        attester: '0x0000000000000000000000000000000000000000',
        dripPerShare: '3000000000000',
        remaining: '6600000000000000000',
        tipPerShare: '1000000000000',
      },
      nextShare: '3300000000000000000',
      attesterMode: 'none',
      created: { id: '1', message: '新年快樂' },
      block: { number: 40, timestamp: 1800000200 },
    });
    expect(p?.sharesLeft).toBe(2);
    expect(p?.expiry).toBe(1800086400n);
    expect(p?.nextShare).toBe(3_300_000_000_000_000_000n);
    expect(p?.message).toBe('新年快樂');
  });

  it('stats: a bare tuple from stats()', () => {
    const p = normalizeStatsPayload({ stats: ['1', '0', '990000000000000000', '0', '1', '990000000000000000'] });
    expect(p.stats.packets).toBe(1n);
    expect(p.stats.volume).toBe(990_000_000_000_000_000n);
  });

  it('stats: the snapshot file’s zeroed entry', () => {
    const p = normalizeStatsPayload({ stats: { packets: '0', claims: '0', volume: '0', recipients: '0', senders: '0', open: '0' }, recent: [] });
    expect(p.stats).toEqual({ packets: 0n, claims: 0n, volume: 0n, recipients: 0n, senders: 0n, open: 0n });
  });

  it('amounts: wei strings pass through, human units scale', () => {
    expect(toAmount('1000000000000000000')).toBe(10n ** 18n);
    expect(toAmount('12.5')).toBe(12_500_000_000_000_000_000n);
    expect(toAmount(3)).toBe(3n * 10n ** 18n);
    expect(toAmount('0')).toBe(0n);
    expect(toAmount('0x0de0b6b3a7640000')).toBe(10n ** 18n);
  });

  it('packet: nested or flat', () => {
    const flat = normalizePacket({
      sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      expiry: '1800086400',
      sharesTotal: 8,
      claimKey: '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7',
      sharesLeft: '5',
      refunded: false,
      attester: '0x0000000000000000000000000000000000000000',
      dripPerShare: '3000000000000',
      remaining: '5000000000000000000',
      tipPerShare: '1000000000000',
      nextShare: '1000000000000000000',
      message: '恭喜發財',
    });
    expect(flat?.sharesLeft).toBe(5);
    expect(flat?.nextShare).toBe(10n ** 18n);
    expect(flat?.message).toBe('恭喜發財');
    const nested = normalizePacket({ packet: { sender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', sharesTotal: '2', sharesLeft: '2' }, nextShare: '7' });
    expect(nested?.sharesTotal).toBe(2);
    expect(nested?.nextShare).toBe(7n);
    expect(normalizePacket({ sender: null })).toBeNull();
  });
});

describe('fetch wrappers', () => {
  it('postClaim sends only the signature, never a key, and returns the hash', async () => {
    const hash = `0x${'cd'.repeat(32)}`;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ txHash: hash }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await postClaim({
      chainId: 31611,
      packetId: 5n,
      recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      payout: 0,
      keySig: '0x1234',
      relayer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      device: 'abcd',
    });
    expect(res.txHash).toBe(hash);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/claim');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      chainId: 31611,
      packetId: 5,
      recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      payout: 0,
      keySig: '0x1234',
      relayer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      device: 'abcd',
    });
    expect(Object.keys(body)).not.toContain('key');
  });

  it('postClaim turns an error body into a coded error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'AlreadyClaimed', message: 'claimed' }), { status: 409 })));
    await expect(
      postClaim({
        chainId: 31611,
        packetId: 1n,
        recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        payout: 0,
        keySig: '0x',
        relayer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        device: 'x',
      }),
    ).rejects.toMatchObject({ code: 'AlreadyClaimed' });
  });

  it('postClaim → WrongRelayer drops the cached /api/config so a retry signs for the new relayer', async () => {
    const oldRelayer = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
    const newRelayer = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
    let relayer = oldRelayer;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/config') {
        return new Response(JSON.stringify({ chains: { '31611': { hongbao: null, relayer, attester: null, enabled: true } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'WrongRelayer', message: 'x', relayer: newRelayer }), { status: 409 });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect((await getConfig()).chains['31611']?.relayer).toBe(oldRelayer);
    relayer = newRelayer;
    expect((await getConfig()).chains['31611']?.relayer).toBe(oldRelayer); // cached
    await expect(
      postClaim({
        chainId: 31611,
        packetId: 1n,
        recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        payout: 0,
        keySig: '0x',
        relayer: oldRelayer,
        device: 'x',
      }),
    ).rejects.toMatchObject({ code: 'WrongRelayer' });
    expect((await getConfig()).chains['31611']?.relayer).toBe(newRelayer);
  });

  it('getStatsApi treats an HTML answer (no API deployed) as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200 })));
    await expect(getStatsApi(31611)).rejects.toMatchObject({ code: 'RelayerUnavailable' });
  });

  it('getStatsApi maps a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(getStatsApi(31611)).rejects.toMatchObject({ code: 'Network' });
  });
});
