import { describe, expect, it } from 'vitest';
import { capProblem, type SendContext } from './chainData';

const E18 = 10n ** 18n;

// Mezo testnet caps from contracts/script/Deploy.s.sol: 1,000 per packet, 2,000 per sender, 20,000 in all.
const ctx = (over: Partial<SendContext> = {}): SendContext => ({
  feeBps: 100n,
  maxPerPacket: 1_000n * E18,
  maxPerSender: 2_000n * E18,
  maxOutstanding: 20_000n * E18,
  outstanding: 0n,
  senderOutstanding: 0n,
  paused: false,
  ...over,
});

describe('capProblem (Hongbao.sol v2 caps, checked before sending)', () => {
  it('passes a packet that fits every cap, including exactly at a cap', () => {
    expect(capProblem(ctx(), 10n * E18)).toBeNull();
    expect(capProblem(ctx(), 1_000n * E18)).toBeNull();
    expect(capProblem(ctx({ senderOutstanding: 1_000n * E18 }), 1_000n * E18)).toBeNull();
  });

  it('per packet: OverPacketCap', () => {
    expect(capProblem(ctx(), 1_000n * E18 + 1n)).toEqual({ kind: 'packet', cap: 1_000n * E18 });
  });

  it('per sender: OverSenderCap, with the room left', () => {
    expect(capProblem(ctx({ senderOutstanding: 1_500n * E18 }), 600n * E18)).toEqual({
      kind: 'sender',
      cap: 2_000n * E18,
      room: 500n * E18,
    });
    // A guardian may lower the cap below what is already open: no room, never negative.
    expect(capProblem(ctx({ maxPerSender: 100n * E18, senderOutstanding: 150n * E18 }), E18)).toEqual({
      kind: 'sender',
      cap: 100n * E18,
      room: 0n,
    });
  });

  it('global: OverOutstandingCap, checked before the sender cap like the contract', () => {
    expect(capProblem(ctx({ outstanding: 19_800n * E18, senderOutstanding: 1_900n * E18 }), 300n * E18)).toEqual({
      kind: 'total',
      room: 200n * E18,
    });
  });
});
