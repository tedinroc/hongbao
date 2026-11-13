/**
 * Pure planning for the Send page: how much BTC each share's gas kit can carry, and
 * whether a BTC-funded packet's swap would pass Hongbao.createWithBTC's price checks.
 */

const E18 = 10n ** 18n;

/** UI default drip per share: 0.000003 BTC (SPEC.md). */
export const DRIP = 3_000_000_000_000n;
/** UI default relay tip per share: 0.000001 BTC (SPEC.md). */
export const TIP = 1_000_000_000_000n;
/** Hongbao.MAX_TIP (v2): 0.000005 BTC. */
export const MAX_TIP = 5_000_000_000_000n;
/** Drips are rounded down to whole 0.00000001 BTC so the page shows them exactly. */
const DRIP_STEP = 10_000_000_000n;

/** Gas each transaction of a send is budgeted for (measured on a Mezo testnet fork, plus headroom). */
export const GAS = {
  /** gauge withdraw or sMUSD withdraw, when MUSD has to come out of savings first */
  prepare: 180_000n,
  /** MUSD approve, if the wallet cannot sign a permit */
  approve: 60_000n,
  /** create / createWithPermit */
  create: 450_000n,
  /** createWithBTC (swap included). A fork skips the BTC and oracle precompiles' gas; the real
   * Mezo mainnet node estimates 712k–732k (2026-11-13), so budget above that. */
  createBtc: 800_000n,
  /** BorrowerOperations.withdrawMUSD (about 390k on the fork) */
  borrow: 450_000n,
  /** one relayed claim, what the relay tip has to pay for (a first-time stake used 327,536 on the fork) */
  claim: 350_000n,
} as const;

/**
 * BTC a wallet must hold to send `gasUnits` at `gasPrice` (eth_gasPrice). Wallets ask for
 * about 1.2 × the base fee plus the priority fee up front, so budget 1.25 ×.
 */
export function feeBudget(gasUnits: bigint, gasPrice: bigint): bigint {
  return (gasUnits * gasPrice * 5n + 3n) / 4n;
}

/**
 * Smallest relay tip that clears the relayer's TipTooLow check (tip >= claim gas × gas
 * price × 1.2) with room to spare: × 1.3.
 */
export function minTip(gasPrice: bigint): bigint {
  return (GAS.claim * gasPrice * 13n + 9n) / 10n;
}

/** The tip a share gets when BTC is plentiful: the UI default, raised if gas got expensive. */
export function wantedTip(gasPrice: bigint): bigint {
  const m = minTip(gasPrice);
  if (m <= TIP) return TIP;
  return m > MAX_TIP ? MAX_TIP : m;
}

export type KitMode = 'full' | 'reduced' | 'tipOnly' | 'none';

export interface KitPlan {
  dripPerShare: bigint;
  tipPerShare: bigint;
  /** shares × (drip + tip): the BTC the create sends along */
  kits: bigint;
  /** BTC kept back for this send's own transactions */
  gasCost: bigint;
  mode: KitMode;
}

/**
 * Size the gas kits to what the wallet's BTC can pay after its own transactions' fees
 * (and `btcIn` for a BTC-funded packet). The relay tip comes first, because without it
 * nobody can open the packet for free; the drip gets what is left, up to the default.
 * `none` means even the smallest workable tip does not fit.
 */
export function sizeKits(a: {
  shares: number;
  btcBalance: bigint | null;
  btcIn: bigint;
  gasPrice: bigint;
  gasUnits: bigint;
}): KitPlan {
  const shares = BigInt(Math.max(1, Math.floor(a.shares)));
  const tip = wantedTip(a.gasPrice);
  const gasCost = feeBudget(a.gasUnits, a.gasPrice);
  const plan = (drip: bigint, t: bigint, mode: KitMode): KitPlan => ({
    dripPerShare: drip,
    tipPerShare: t,
    kits: shares * (drip + t),
    gasCost,
    mode,
  });
  if (a.btcBalance === null) return plan(DRIP, tip, 'full');
  const spare = a.btcBalance - a.btcIn - gasCost;
  const perShare = spare > 0n ? spare / shares : 0n;
  if (perShare >= DRIP + tip) return plan(DRIP, tip, 'full');
  if (perShare >= tip) {
    const drip = ((perShare - tip) / DRIP_STEP) * DRIP_STEP;
    return drip > 0n ? plan(drip, tip, 'reduced') : plan(0n, tip, 'tipOnly');
  }
  const floor = minTip(a.gasPrice);
  if (floor <= MAX_TIP && perShare >= floor) return plan(0n, perShare, 'tipOnly');
  return plan(0n, 0n, 'none');
}

/* ------------------------------------------------------------------ BTC funding preflight */

/** maxSlippageBps passed to createWithBTC: how far below the PriceFeed price the swap may land. */
export const ORACLE_SLIPPAGE_BPS = 150n;
/** minMusdOut = pool quote × 99.5% (SPEC.md, UI rules from the review). */
export const MIN_OUT_BPS = 9_950n;

export type BtcProblem = 'noPrice' | 'noQuote' | 'poolLow';

export interface BtcPreflight {
  /** Hongbao's oracle floor: (btcIn × price / 1e18) × (1 − 1.5%). */
  oracleMin: bigint;
  /** What the page passes as minMusdOut. */
  minMusdOut: bigint;
  problem: BtcProblem | null;
}

/**
 * Mirror createWithBTC: the swap must return at least max(oracleMin, minMusdOut). With
 * minMusdOut below the quote, a quote under the oracle floor is the case that reverts.
 */
export function btcPreflight(btcIn: bigint, quote: bigint | null, price: bigint | null): BtcPreflight {
  const oracleMin = price !== null ? (((btcIn * price) / E18) * (10_000n - ORACLE_SLIPPAGE_BPS)) / 10_000n : 0n;
  const minMusdOut = quote !== null ? (quote * MIN_OUT_BPS) / 10_000n : 0n;
  let problem: BtcProblem | null = null;
  if (price === null) problem = 'noPrice';
  else if (quote === null || quote === 0n) problem = 'noQuote';
  else if (quote < oracleMin) problem = 'poolLow';
  return { oracleMin, minMusdOut, problem };
}
