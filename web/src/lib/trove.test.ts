import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

// readLoan / quoteBorrow read through publicClient(); answer from a fake Mezo trove instead.
const calls: { functionName: string; args?: readonly unknown[] }[] = [];
let trove: Record<string, unknown> = {};
vi.mock('./chains', async (importOriginal) => {
  const real = await importOriginal<typeof import('./chains')>();
  const fake = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      calls.push({ functionName, args });
      const v = trove[functionName];
      if (v instanceof Error) throw v;
      if (typeof v === 'function') return (v as (a?: readonly unknown[]) => unknown)(args);
      if (v === undefined) throw new Error(`unexpected read ${functionName}`);
      return v;
    },
  };
  return { ...real, publicClient: () => fake };
});

import {
  FLOOR_DEFAULT_PCT,
  computeCR,
  computeNominalCR,
  floorFromPct,
  fmtRatio,
  liquidationPrice,
  planBorrow,
  quoteBorrow,
  readLoan,
  type Loan,
} from './trove';

const E18 = 10n ** 18n;
const PRICE = 74_000n * E18;
const WHO: Address = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';

/**
 * Vectors read from a Mezo testnet fork (2026-11-11): a trove opened with 0.05 BTC and
 * 1,800 MUSD (2,001.8 MUSD principal with the 200 MUSD gas deposit and the 0.1% fee), then
 * withdrawMUSD(20 MUSD), at a 74,000 MUSD BTC price. TroveManager returned these values.
 */
const FORK = {
  coll: 5n * 10n ** 16n,
  principalOpen: 2_001_800_000_000_000_000_000n,
  icrOpen: 1_848_336_497_152_562_693n,
  principalAfter: 2_021_820_000_000_000_000_000n,
  interestAfter: 69_143_623_249_799n,
  icrAfter: 1_830_034_262_923_900_441n,
  nicrAfter: 2_473_019_358_795_540n,
  maxBorrowingCapacity: 3_363_636_363_636_363_636_363n,
};

function loanOf(over: Partial<Loan> = {}): Loan {
  const principal = over.principal ?? FORK.principalOpen;
  const interest = over.interest ?? 0n;
  return {
    coll: FORK.coll,
    principal,
    interest,
    debt: principal + interest,
    price: PRICE,
    icr: FORK.icrOpen,
    maxBorrowingCapacity: FORK.maxBorrowingCapacity,
    recoveryMode: false,
    mcr: 11n * 10n ** 17n,
    ccr: 15n * 10n ** 17n,
    systemColl: 10_000n * E18,
    systemDebt: 100_000_000n * E18,
    interestRateBps: 100,
    ...over,
  };
}

describe('loan math matches Mezo', () => {
  it('ICR = coll × price / (principal + interest), as TroveManager.getCurrentICR returned', () => {
    expect(computeCR(FORK.coll, FORK.principalOpen, PRICE)).toBe(FORK.icrOpen);
    expect(computeCR(FORK.coll, FORK.principalAfter + FORK.interestAfter, PRICE)).toBe(FORK.icrAfter);
  });

  it('NICR = coll × 1e20 / principal, as TroveManager.getNominalICR returned', () => {
    expect(computeNominalCR(FORK.coll, FORK.principalAfter)).toBe(FORK.nicrAfter);
  });

  it('no debt means an unbounded ratio', () => {
    expect(computeCR(E18, 0n, PRICE)).toBe(2n ** 256n - 1n);
    expect(fmtRatio(computeCR(E18, 0n, PRICE))).toBe('∞');
  });

  it('liquidation price is where the ratio meets MCR (110%)', () => {
    const debt = 2_000n * E18;
    const liq = liquidationPrice(FORK.coll, debt, 11n * 10n ** 17n);
    expect(liq).toBe(44_000n * E18); // 2,000 × 1.1 / 0.05
    expect(computeCR(FORK.coll, debt, liq)).toBe(11n * 10n ** 17n);
    // Rounded up: one wei lower and the loan is already below MCR.
    const odd = liquidationPrice(3n, 10n * E18, 11n * 10n ** 17n);
    expect(computeCR(3n, 10n * E18, odd) >= 11n * 10n ** 17n).toBe(true);
    expect(computeCR(3n, 10n * E18, odd - 1n) < 11n * 10n ** 17n).toBe(true);
  });

  it('formats ratios as percents', () => {
    expect(fmtRatio(FORK.icrOpen)).toBe('184.8%');
    expect(fmtRatio(16n * 10n ** 17n)).toBe('160%');
    expect(fmtRatio(11n * 10n ** 17n)).toBe('110%');
    expect(fmtRatio(377_878_331_816_475_102_010n)).toBe('37,787.8%');
  });

  it('the ratio floor starts at 160% and never goes below 150%', () => {
    expect(FLOOR_DEFAULT_PCT).toBe(160);
    expect(floorFromPct(160)).toBe(16n * 10n ** 17n);
    expect(floorFromPct(200)).toBe(2n * E18);
    expect(floorFromPct(120)).toBe(15n * 10n ** 17n);
    expect(floorFromPct(Number.NaN)).toBe(16n * 10n ** 17n);
  });
});

describe('planBorrow', () => {
  it('reproduces the fork trove after borrowing 20 MUSD with a 0.02 MUSD fee', () => {
    const plan = planBorrow(loanOf(), 20n * E18, 2n * 10n ** 16n, floorFromPct(160));
    expect(plan.problem).toBeNull();
    expect(plan.debtAfter).toBe(FORK.principalAfter);
    expect(plan.principalAfter).toBe(FORK.principalAfter);
    expect(plan.icrBefore).toBe(FORK.icrOpen);
    expect(plan.icrAfter).toBe(computeCR(FORK.coll, FORK.principalAfter, PRICE));
    expect(plan.liquidationPriceAfter).toBe(liquidationPrice(FORK.coll, FORK.principalAfter, 11n * 10n ** 17n));
    expect(plan.roomAfter).toBe(FORK.maxBorrowingCapacity - FORK.principalAfter);
  });

  it('adds interest to the debt the ratio and capacity use, and the fee to both debt and principal', () => {
    const loan = loanOf({ interest: 5n * E18 });
    const plan = planBorrow(loan, 100n * E18, E18 / 10n, floorFromPct(150));
    expect(plan.debtBefore).toBe(FORK.principalOpen + 5n * E18);
    expect(plan.debtAfter).toBe(FORK.principalOpen + 5n * E18 + 100n * E18 + E18 / 10n);
    expect(plan.principalAfter).toBe(FORK.principalOpen + 100n * E18 + E18 / 10n);
    expect(plan.icrAfter).toBe(computeCR(FORK.coll, plan.debtAfter, PRICE));
  });

  it('blocks below the floor (160% by default) and lets a higher floor block sooner', () => {
    // 0.05 BTC at 74,000 = 3,700 MUSD of collateral: 160% allows 2,312.5 MUSD of debt.
    const ok = planBorrow(loanOf(), 300n * E18, 0n, floorFromPct(160));
    expect(ok.problem).toBeNull();
    const low = planBorrow(loanOf(), 320n * E18, 0n, floorFromPct(160));
    expect(low.problem).toEqual({ kind: 'floor', icr: low.icrAfter, floor: 16n * 10n ** 17n });
    const strict = planBorrow(loanOf(), 300n * E18, 0n, floorFromPct(180));
    expect(strict.problem?.kind).toBe('floor');
  });

  it('never accepts a floor below 150%', () => {
    // 2,001.8 + 450 = 2,451.8 MUSD of debt: 150.9%, fine at 150% but a 140% "floor" is raised to 150%.
    expect(planBorrow(loanOf(), 450n * E18, 0n, 14n * 10n ** 17n).problem).toBeNull();
    const plan = planBorrow(loanOf(), 500n * E18, 0n, 14n * 10n ** 17n);
    expect(plan.floor).toBe(15n * 10n ** 17n);
    expect(plan.problem?.kind).toBe('floor');
  });

  it('blocks in Recovery Mode first', () => {
    const plan = planBorrow(loanOf({ recoveryMode: true }), E18, 0n, floorFromPct(160));
    expect(plan.problem).toEqual({ kind: 'recovery' });
  });

  it('blocks when debt + amount + fee would pass maxBorrowingCapacity', () => {
    const loan = loanOf({ maxBorrowingCapacity: FORK.principalOpen + 10n * E18 });
    expect(planBorrow(loan, 9n * E18, E18, floorFromPct(150)).problem).toBeNull();
    const over = planBorrow(loan, 9n * E18, E18 + 1n, floorFromPct(150));
    expect(over.problem).toEqual({ kind: 'capacity', cap: FORK.principalOpen + 10n * E18 });
    expect(over.roomAfter).toBe(0n);
  });

  it('blocks when Mezo’s overall ratio would fall below CCR', () => {
    const loan = loanOf({ systemColl: 2n * E18, systemDebt: 98_600n * E18 }); // TCR 150.1%
    expect(planBorrow(loan, 50n * E18, 0n, floorFromPct(150)).problem).toBeNull(); // 150.03%
    const plan = planBorrow(loan, 100n * E18, 0n, floorFromPct(150)); // 149.95%
    expect(plan.problem).toEqual({ kind: 'system', ccr: 15n * 10n ** 17n });
  });

  it('blocks without a price', () => {
    const plan = planBorrow(loanOf({ price: null, icr: null, recoveryMode: null }), E18, 0n, floorFromPct(160));
    expect(plan.problem).toEqual({ kind: 'price' });
    expect(plan.icrAfter).toBeNull();
  });
});

describe('readLoan / quoteBorrow', () => {
  const base = () => ({
    getTroveStatus: 1,
    // (coll, principal, interest, pendingCollateral, pendingPrincipal, pendingInterest):
    // the pending parts are already inside the first three.
    getEntireDebtAndColl: [FORK.coll, FORK.principalOpen, 3n * E18, E18, 7n * E18, 2n * E18],
    getTroveMaxBorrowingCapacity: FORK.maxBorrowingCapacity,
    MCR: 11n * 10n ** 17n,
    CCR: 15n * 10n ** 17n,
    getEntireSystemColl: 10_000n * E18,
    getEntireSystemDebt: 100_000_000n * E18,
    getTroveInterestRate: 100,
    fetchPrice: PRICE,
    getCurrentICR: FORK.icrOpen,
    checkRecoveryMode: false,
    // Mezo's rate is 0.1% on testnet; the page must use whatever the contract says.
    getBorrowingFee: (args?: readonly unknown[]) => ((args![0] as bigint) * 7n) / 1000n,
  });

  it('returns null for a wallet without an active trove', async () => {
    trove = { ...base(), getTroveStatus: 2 };
    expect(await readLoan(31611, WHO)).toBeNull();
    trove = { ...base(), getTroveStatus: 0, getBorrowingFee: 0n };
    expect(await quoteBorrow(31611, WHO, E18, floorFromPct(160))).toBeNull();
  });

  it('does not count pending redistribution twice', async () => {
    trove = base();
    const loan = await readLoan(31611, WHO);
    expect(loan?.coll).toBe(FORK.coll);
    expect(loan?.debt).toBe(FORK.principalOpen + 3n * E18);
    expect(loan?.icr).toBe(FORK.icrOpen);
    expect(loan?.recoveryMode).toBe(false);
    expect(loan?.interestRateBps).toBe(100);
  });

  it('adds the fee getBorrowingFee returns, not a rate of its own', async () => {
    trove = base();
    calls.length = 0;
    const q = await quoteBorrow(31611, WHO, 50n * E18, floorFromPct(160));
    expect(calls.find((c) => c.functionName === 'getBorrowingFee')?.args).toEqual([50n * E18]);
    expect(q?.plan.fee).toBe((50n * E18 * 7n) / 1000n);
    expect(q?.plan.debtAfter).toBe(FORK.principalOpen + 3n * E18 + 50n * E18 + (50n * E18 * 7n) / 1000n);
    // getCurrentICR and checkRecoveryMode are read at the PriceFeed price.
    expect(calls.find((c) => c.functionName === 'getCurrentICR')?.args).toEqual([WHO, PRICE]);
    expect(calls.find((c) => c.functionName === 'checkRecoveryMode')?.args).toEqual([PRICE]);
  });

  it('a stale PriceFeed leaves the ratio unknown and blocks the loan', async () => {
    trove = { ...base(), fetchPrice: new Error('Oracle is stale') };
    const q = await quoteBorrow(31611, WHO, E18, floorFromPct(160));
    expect(q?.loan.price).toBeNull();
    expect(q?.loan.icr).toBeNull();
    expect(q?.plan.problem).toEqual({ kind: 'price' });
  });
});
