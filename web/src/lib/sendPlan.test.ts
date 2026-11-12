import { describe, expect, it } from 'vitest';
import { DRIP, GAS, MAX_TIP, TIP, btcPreflight, feeBudget, minTip, sizeKits, wantedTip } from './sendPlan';

const E18 = 10n ** 18n;
const TESTNET_GAS = 146n; // eth_gasPrice on Mezo testnet (wei)
const MAINNET_GAS = 1_500_000n; // eth_gasPrice on Mezo mainnet (wei, SPEC.md)
/** What a "Pass it on" wallet holds after a relayed claim: the 0.000003 BTC drip. */
const PASS_ON_BTC = DRIP;
const PASS_ON_GAS = 2n * GAS.prepare + GAS.approve + GAS.create;

/** The relayer's TipTooLow rule (functions/_lib/relay.ts): refuse when tip × 10 < gas × price × 12. */
const relayerAccepts = (tip: bigint, gasPrice: bigint, claimGas = 300_000n) => tip * 10n >= claimGas * gasPrice * 12n;

describe('relay tip', () => {
  it('the default 0.000001 BTC tip clears the relayer on testnet and mainnet', () => {
    expect(wantedTip(TESTNET_GAS)).toBe(TIP);
    expect(wantedTip(MAINNET_GAS)).toBe(TIP);
    expect(relayerAccepts(TIP, MAINNET_GAS, GAS.claim)).toBe(true);
  });

  it('the smallest tip the page uses still clears the relayer with room to spare', () => {
    for (const gp of [TESTNET_GAS, MAINNET_GAS, 4_000_000n]) {
      expect(relayerAccepts(minTip(gp), gp, GAS.claim)).toBe(true);
      expect(relayerAccepts(minTip(gp), (gp * 108n) / 100n, GAS.claim)).toBe(true);
    }
  });

  it('rises with expensive gas, up to Hongbao.MAX_TIP', () => {
    expect(wantedTip(4_000_000n)).toBe(minTip(4_000_000n));
    expect(wantedTip(4_000_000n) > TIP).toBe(true);
    expect(wantedTip(10n ** 12n)).toBe(MAX_TIP);
  });
});

describe('sizeKits', () => {
  it('gives full kits when BTC is plentiful or not known yet', () => {
    const k = sizeKits({ shares: 8, btcBalance: E18 / 100n, btcIn: 0n, gasPrice: MAINNET_GAS, gasUnits: GAS.create });
    expect(k).toMatchObject({ dripPerShare: DRIP, tipPerShare: TIP, kits: 8n * (DRIP + TIP), mode: 'full' });
    expect(sizeKits({ shares: 8, btcBalance: null, btcIn: 0n, gasPrice: MAINNET_GAS, gasUnits: GAS.create }).mode).toBe('full');
  });

  it('keeps BTC back for the wallet’s own transactions before any kit', () => {
    const gasCost = feeBudget(GAS.create, MAINNET_GAS);
    const k = sizeKits({ shares: 2, btcBalance: gasCost + 2n * (DRIP + TIP), btcIn: 0n, gasPrice: MAINNET_GAS, gasUnits: GAS.create });
    expect(k.mode).toBe('full');
    expect(k.gasCost).toBe(gasCost);
    const short = sizeKits({ shares: 2, btcBalance: gasCost + 2n * (DRIP + TIP) - 1n, btcIn: 0n, gasPrice: MAINNET_GAS, gasUnits: GAS.create });
    expect(short.mode).toBe('reduced');
    expect(short.kits + short.gasCost <= gasCost + 2n * (DRIP + TIP) - 1n).toBe(true);
  });

  it('counts btcIn for BTC-funded packets', () => {
    const k = sizeKits({ shares: 1, btcBalance: E18 / 1000n, btcIn: E18 / 1000n, gasPrice: TESTNET_GAS, gasUnits: GAS.createBtc });
    expect(k.mode).toBe('none');
  });

  it('pass it on, testnet: the 0.000003 BTC drip pays three tips but no new drips', () => {
    const k = sizeKits({ shares: 3, btcBalance: PASS_ON_BTC, btcIn: 0n, gasPrice: TESTNET_GAS, gasUnits: PASS_ON_GAS });
    // The fee on testnet is tiny but not zero, so 3 × 0.000001 BTC no longer fits: the tip shrinks.
    expect(k.mode).toBe('tipOnly');
    expect(k.dripPerShare).toBe(0n);
    expect(relayerAccepts(k.tipPerShare, TESTNET_GAS)).toBe(true);
    expect(k.kits + k.gasCost <= PASS_ON_BTC).toBe(true);
    const one = sizeKits({ shares: 1, btcBalance: PASS_ON_BTC, btcIn: 0n, gasPrice: TESTNET_GAS, gasUnits: PASS_ON_GAS });
    expect(one).toMatchObject({ tipPerShare: TIP, mode: 'reduced' });
    // What is left after the fee and the tip, rounded down to whole 0.00000001 BTC.
    expect(one.dripPerShare).toBe(DRIP - TIP - 10_000_000_000n);
  });

  it('pass it on, mainnet: smaller kits for fewer shares, none when even the tips do not fit', () => {
    const at = (shares: number) => sizeKits({ shares, btcBalance: PASS_ON_BTC, btcIn: 0n, gasPrice: MAINNET_GAS, gasUnits: PASS_ON_GAS });
    expect(at(1).mode).toBe('reduced');
    expect(at(1).tipPerShare).toBe(TIP);
    expect(at(2).mode).toBe('tipOnly');
    expect(relayerAccepts(at(2).tipPerShare, MAINNET_GAS)).toBe(true);
    expect(at(3)).toMatchObject({ dripPerShare: 0n, tipPerShare: 0n, kits: 0n, mode: 'none' });
    for (const n of [1, 2]) expect(at(n).kits + at(n).gasCost <= PASS_ON_BTC).toBe(true);
  });

  it('every kit stays within Hongbao’s MAX_DRIP and MAX_TIP', () => {
    for (const bal of [0n, DRIP, E18]) {
      for (const gp of [TESTNET_GAS, MAINNET_GAS, 10n ** 9n]) {
        const k = sizeKits({ shares: 5, btcBalance: bal, btcIn: 0n, gasPrice: gp, gasUnits: GAS.create });
        expect(k.dripPerShare <= 20_000_000_000_000n).toBe(true);
        expect(k.tipPerShare <= MAX_TIP).toBe(true);
        expect(k.kits).toBe(5n * (k.dripPerShare + k.tipPerShare));
      }
    }
  });
});

describe('btcPreflight mirrors createWithBTC', () => {
  const price = 74_000n * E18;
  const btcIn = E18 / 1000n; // 0.001 BTC = 74 MUSD at the oracle

  it('passes minMusdOut = pool quote × 99.5% and the oracle floor = value × 98.5%', () => {
    const p = btcPreflight(btcIn, 73n * E18, price);
    expect(p.problem).toBeNull();
    expect(p.minMusdOut).toBe((73n * E18 * 995n) / 1000n);
    expect(p.oracleMin).toBe((74n * E18 * 9850n) / 10_000n);
  });

  it('flags a pool more than 1.5% below the oracle: the swap would revert', () => {
    const floor = (74n * E18 * 9850n) / 10_000n;
    expect(btcPreflight(btcIn, floor, price).problem).toBeNull();
    expect(btcPreflight(btcIn, floor - 1n, price).problem).toBe('poolLow');
  });

  it('flags a missing price or quote', () => {
    expect(btcPreflight(btcIn, 73n * E18, null).problem).toBe('noPrice');
    expect(btcPreflight(btcIn, null, price).problem).toBe('noQuote');
    expect(btcPreflight(btcIn, 0n, price).problem).toBe('noQuote');
  });
});
