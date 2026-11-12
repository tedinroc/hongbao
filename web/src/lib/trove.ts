/**
 * "Fund from my Mezo loan" (SPEC.md, Phase 2): read the sender's MUSD loan (trove),
 * check what borrowing more would do to it, and draw MUSD with sorted-list hints.
 *
 * Amounts are 18-decimal integers. Ratios use Mezo's scale: 1e18 = 100%.
 */
import type { Address, TransactionReceipt } from 'viem';
import { priceFeedAbi } from '../abi/extra';
import { borrowerOperationsAbi, hintHelpersAbi, sortedTrovesAbi, troveManagerAbi } from '../abi/trove';
import { chainInfo, publicClient, type ChainId } from './chains';
import { HongbaoError } from './errors';
import { sendContract, type WalletHandle } from './wallet';

const E18 = 10n ** 18n;
/** Liquity / Mezo nominal ratio precision: NICR = coll * 1e20 / principal. */
const NICR_PRECISION = 10n ** 20n;
const MAX_UINT256 = 2n ** 256n - 1n;

/** TroveManager.Status.active */
export const TROVE_ACTIVE = 1;
/** Lowest ratio floor the page lets a sender pick (150%). */
export const FLOOR_MIN_PCT = 150;
/** Floor the page starts with (160%). */
export const FLOOR_DEFAULT_PCT = 160;
/** HintHelpers.getApproxHint trials (SPEC.md). */
export const HINT_TRIALS = 15n;

/** A whole percent as a Mezo ratio: 160 -> 1.6e18. Never below FLOOR_MIN_PCT. */
export function floorFromPct(pct: number): bigint {
  const p = Number.isFinite(pct) ? Math.max(FLOOR_MIN_PCT, Math.floor(pct)) : FLOOR_DEFAULT_PCT;
  return BigInt(p) * 10n ** 16n;
}

/* ------------------------------------------------------------------ math (mirrors LiquityMath) */

/** coll * price / debt, as Mezo's computeCR does (max uint when there is no debt). */
export function computeCR(coll: bigint, debt: bigint, price: bigint): bigint {
  return debt > 0n ? (coll * price) / debt : MAX_UINT256;
}

/** coll * 1e20 / debt, as HintHelpers.computeNominalCR does. */
export function computeNominalCR(coll: bigint, debt: bigint): bigint {
  return debt > 0n ? (coll * NICR_PRECISION) / debt : MAX_UINT256;
}

/** The BTC price (MUSD per BTC, 1e18) at which the loan's ratio falls to `mcr`, rounded up. */
export function liquidationPrice(coll: bigint, debt: bigint, mcr: bigint): bigint {
  if (coll === 0n) return MAX_UINT256;
  return (debt * mcr + coll - 1n) / coll;
}

/* ------------------------------------------------------------------ reads */

export interface Loan {
  /** BTC collateral, pending redistribution already included. */
  coll: bigint;
  /** Principal (includes Mezo's 200 MUSD gas deposit and pending redistribution). */
  principal: bigint;
  /** Interest owed, pending included. */
  interest: bigint;
  /** principal + interest: what getCurrentICR divides by. */
  debt: bigint;
  /** PriceFeed.fetchPrice(), or null when the oracle is stale. */
  price: bigint | null;
  /** TroveManager.getCurrentICR(borrower, price). */
  icr: bigint | null;
  maxBorrowingCapacity: bigint;
  recoveryMode: boolean | null;
  mcr: bigint;
  ccr: bigint;
  systemColl: bigint;
  systemDebt: bigint;
  /** Fixed yearly interest in basis points (100 = 1%). */
  interestRateBps: number;
}

/** The wallet's active Mezo loan, or null when it has none. */
export async function readLoan(chainId: ChainId, who: Address): Promise<Loan | null> {
  const pc = publicClient(chainId);
  const a = chainInfo(chainId).addresses;
  const tm = { address: a.troveManager, abi: troveManagerAbi } as const;
  const status = await pc.readContract({ ...tm, functionName: 'getTroveStatus', args: [who] });
  if (Number(status) !== TROVE_ACTIVE) return null;
  const [amounts, maxBorrowingCapacity, mcr, ccr, systemColl, systemDebt, rate, price] = await Promise.all([
    pc.readContract({ ...tm, functionName: 'getEntireDebtAndColl', args: [who] }),
    pc.readContract({ ...tm, functionName: 'getTroveMaxBorrowingCapacity', args: [who] }),
    pc.readContract({ ...tm, functionName: 'MCR' }),
    pc.readContract({ ...tm, functionName: 'CCR' }),
    pc.readContract({ ...tm, functionName: 'getEntireSystemColl' }),
    pc.readContract({ ...tm, functionName: 'getEntireSystemDebt' }),
    pc.readContract({ ...tm, functionName: 'getTroveInterestRate', args: [who] }),
    pc
      .readContract({ address: a.priceFeed, abi: priceFeedAbi, functionName: 'fetchPrice' })
      .catch(() => null),
  ]);
  // getEntireDebtAndColl returns (coll, principal, interest, pendingCollateral, pendingPrincipal,
  // pendingInterest) with the pending parts already added to the first three: use those only.
  const [coll, principal, interest] = amounts;
  let icr: bigint | null = null;
  let recoveryMode: boolean | null = null;
  if (price !== null) {
    [icr, recoveryMode] = await Promise.all([
      pc.readContract({ ...tm, functionName: 'getCurrentICR', args: [who, price] }),
      pc.readContract({ ...tm, functionName: 'checkRecoveryMode', args: [price] }),
    ]);
  }
  return {
    coll,
    principal,
    interest,
    debt: principal + interest,
    price,
    icr,
    maxBorrowingCapacity,
    recoveryMode,
    mcr,
    ccr,
    systemColl,
    systemDebt,
    interestRateBps: Number(rate),
  };
}

/** BorrowerOperations.getBorrowingFee(amount): the one-time fee Mezo adds to the debt. */
export function readBorrowingFee(chainId: ChainId, amount: bigint): Promise<bigint> {
  return publicClient(chainId).readContract({
    address: chainInfo(chainId).addresses.borrowerOperations,
    abi: borrowerOperationsAbi,
    functionName: 'getBorrowingFee',
    args: [amount],
  });
}

/* ------------------------------------------------------------------ plan */

export type LoanProblem =
  | { kind: 'price' }
  | { kind: 'recovery' }
  | { kind: 'capacity'; cap: bigint }
  | { kind: 'floor'; icr: bigint; floor: bigint }
  | { kind: 'system'; ccr: bigint };

export interface BorrowPlan {
  amount: bigint;
  fee: bigint;
  debtBefore: bigint;
  /** debt + amount + fee */
  debtAfter: bigint;
  /** principal + amount + fee: what Mezo sorts troves by. */
  principalAfter: bigint;
  icrBefore: bigint | null;
  icrAfter: bigint | null;
  liquidationPriceAfter: bigint;
  /** maxBorrowingCapacity - debtAfter, or 0. */
  roomAfter: bigint;
  floor: bigint;
  problem: LoanProblem | null;
}

/**
 * What borrowing `amount` (with Mezo's `fee` from getBorrowingFee) does to the loan, and
 * the first reason to refuse it: Recovery Mode, the loan's borrowing capacity, the
 * sender's ratio floor (never below 150%), or Mezo's system-wide minimum (CCR), which
 * withdrawMUSD itself enforces.
 */
export function planBorrow(loan: Loan, amount: bigint, fee: bigint, floor: bigint): BorrowPlan {
  const minFloor = floorFromPct(FLOOR_MIN_PCT);
  const f = floor < minFloor ? minFloor : floor;
  const added = amount + fee;
  const debtAfter = loan.debt + added;
  const base = {
    amount,
    fee,
    debtBefore: loan.debt,
    debtAfter,
    principalAfter: loan.principal + added,
    liquidationPriceAfter: liquidationPrice(loan.coll, debtAfter, loan.mcr),
    roomAfter: loan.maxBorrowingCapacity > debtAfter ? loan.maxBorrowingCapacity - debtAfter : 0n,
    floor: f,
  };
  if (loan.price === null) return { ...base, icrBefore: loan.icr, icrAfter: null, problem: { kind: 'price' } };
  const icrBefore = loan.icr ?? computeCR(loan.coll, loan.debt, loan.price);
  const icrAfter = computeCR(loan.coll, debtAfter, loan.price);
  let problem: LoanProblem | null = null;
  if (loan.recoveryMode) problem = { kind: 'recovery' };
  else if (debtAfter > loan.maxBorrowingCapacity) problem = { kind: 'capacity', cap: loan.maxBorrowingCapacity };
  else if (icrAfter < f) problem = { kind: 'floor', icr: icrAfter, floor: f };
  else if (computeCR(loan.systemColl, loan.systemDebt + added, loan.price) < loan.ccr) problem = { kind: 'system', ccr: loan.ccr };
  return { ...base, icrBefore, icrAfter, problem };
}

/** Read the loan and the fee, then plan. Null when the wallet has no active loan. */
export async function quoteBorrow(
  chainId: ChainId,
  who: Address,
  amount: bigint,
  floor: bigint,
): Promise<{ loan: Loan; plan: BorrowPlan } | null> {
  const [loan, fee] = await Promise.all([readLoan(chainId, who), readBorrowingFee(chainId, amount)]);
  if (!loan) return null;
  return { loan, plan: planBorrow(loan, amount, fee, floor) };
}

/* ------------------------------------------------------------------ hints + transaction */

function randomSeed(): bigint {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return BigInt(`0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`);
}

export interface InsertHints {
  nicr: bigint;
  upper: Address;
  lower: Address;
}

/**
 * Where the loan lands in SortedTroves after the change. Mezo sorts by coll / principal
 * (TroveManager.getNominalICR leaves interest out; checked on testnet), so the nominal
 * ratio uses the new principal.
 */
export async function borrowHints(chainId: ChainId, coll: bigint, principalAfter: bigint, seed = randomSeed()): Promise<InsertHints> {
  const pc = publicClient(chainId);
  const a = chainInfo(chainId).addresses;
  const nicr = await pc.readContract({
    address: a.hintHelpers,
    abi: hintHelpersAbi,
    functionName: 'computeNominalCR',
    args: [coll, principalAfter],
  });
  const [approx] = await pc.readContract({
    address: a.hintHelpers,
    abi: hintHelpersAbi,
    functionName: 'getApproxHint',
    args: [nicr, HINT_TRIALS, seed],
  });
  const [upper, lower] = await pc.readContract({
    address: a.sortedTroves,
    abi: sortedTrovesAbi,
    functionName: 'findInsertPosition',
    args: [nicr, approx, approx],
  });
  return { nicr, upper, lower };
}

/**
 * Re-check the loan right before borrowing, then BorrowerOperations.withdrawMUSD(amount,
 * upper, lower). The MUSD lands in the sender's own wallet, so a failed packet step after
 * this loses nothing.
 */
export async function borrowForPacket(
  w: WalletHandle,
  chainId: ChainId,
  amount: bigint,
  floor: bigint,
): Promise<{ plan: BorrowPlan; receipt: TransactionReceipt }> {
  const q = await quoteBorrow(chainId, w.address, amount, floor);
  // The page already showed why a loan would not fit; this catches changes since then.
  if (!q || q.plan.problem) throw new HongbaoError('LoanBlocked');
  const hints = await borrowHints(chainId, q.loan.coll, q.plan.principalAfter);
  const receipt = await sendContract(w, chainId, {
    address: chainInfo(chainId).addresses.borrowerOperations,
    abi: borrowerOperationsAbi,
    functionName: 'withdrawMUSD',
    args: [amount, hints.upper, hints.lower],
  });
  return { plan: q.plan, receipt };
}

/** A Mezo ratio as a percent with at most one decimal: 1.8483e18 -> "184.8%", 1.6e18 -> "160%". */
export function fmtRatio(r: bigint): string {
  if (r >= MAX_UINT256 / 2n) return '∞';
  const tenths = (r * 1000n + E18 / 2n) / E18; // percent × 10, rounded
  const whole = (tenths / 10n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const dec = tenths % 10n;
  return dec === 0n ? `${whole}%` : `${whole}.${dec}%`;
}
