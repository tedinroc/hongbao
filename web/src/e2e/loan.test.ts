/**
 * "Fund from my Mezo loan" against Mezo's real trove contracts on an anvil fork of Mezo
 * testnet. Skipped unless VITE_FORK_RPC and VITE_FORK_HONGBAO are set (scripts/e2e-fork.sh
 * sets both and runs src/e2e).
 *
 * Mezo's BTC oracle (0x7b7c…0015) reads a chain precompile that anvil does not run, so
 * PriceFeed.fetchPrice() reverts on a fork. This file puts a stand-in oracle there with a
 * fixed price and always-fresh rounds, takes an anvil snapshot first, and reverts to it at
 * the end, so the other suites see the fork as before.
 *
 * It opens a trove with a fresh key (0.05 BTC, 1,800 MUSD: Mezo's minimum net debt; the
 * 200 MUSD gas deposit comes on top), then checks lib/trove.ts: readLoan against
 * TroveManager's own numbers, borrowHints + withdrawMUSD, the plan's ratio and principal
 * against the trove afterwards, the two-transaction flow (borrow, then createWithPermit),
 * and the blocks (ratio floor, Recovery Mode, Mezo's own MCR refusal).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const FORK = import.meta.env.VITE_FORK_RPC as string | undefined;
const HB = import.meta.env.VITE_FORK_HONGBAO as Address | undefined;

vi.mock('../lib/chains', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/chains')>();
  const fork = import.meta.env.VITE_FORK_RPC as string | undefined;
  if (!fork) return real;
  const { createPublicClient, http: h } = await import('viem');
  // A cold fork fetches each touched slot from the testnet RPC; getApproxHint walks many troves.
  const client = createPublicClient({ chain: real.mezoTestnet, transport: h(fork, { timeout: 180_000 }) });
  const info = {
    ...real.CHAINS[31611],
    hongbao: import.meta.env.VITE_FORK_HONGBAO as Address,
    rpcUrls: [fork],
    deployBlock: BigInt((import.meta.env.VITE_FORK_FROM_BLOCK as string | undefined) ?? '0'),
    enabled: true,
  };
  return { ...real, CHAINS: { ...real.CHAINS, 31611: info }, publicClient: () => client, chainInfo: () => info };
});

// wallet.ts keeps the phone wallet in localStorage.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size;
  },
} as Storage;

const E18 = 10n ** 18n;
const ORACLE: Address = '0x7b7c000000000000000000000000000000000015';
/**
 * Runtime code of this contract (solc 0.8.24, optimizer 200, london, no metadata):
 *
 *   contract FreshOracle {
 *       int256 internal answer;                       // slot 0
 *       function decimals() external pure returns (uint8) { return 18; }
 *       function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
 *           return (1, answer, block.timestamp, block.timestamp, 1);
 *       }
 *   }
 */
const FRESH_ORACLE: Hex =
  '0x6080604052348015600f57600080fd5b506004361060325760003560e01c8063313ce567146037578063feaf968c14604b575b600080fd5b604051601281526020015b60405180910390f35b6000546040805160018082526020820193909352429181018290526060810191909152608081019190915260a001604256';
const PRICE = 74_000n * E18;
const COLL = 5n * 10n ** 16n; // 0.05 BTC
const NET_DEBT = 1_800n * E18; // BorrowerOperations.minNetDebt() on testnet

const slot = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}` as Hex;

describe.skipIf(!FORK || !HB)('fund from my Mezo loan, on a Mezo testnet fork', { timeout: 600_000 }, () => {
  const key = generatePrivateKey();
  const who = privateKeyToAccount(key).address;
  const anvil = () => createTestClient({ mode: 'anvil', transport: http(FORK, { timeout: 180_000 }) });
  let snapshot: Hex | null = null;
  let borrowed = 0n;

  async function asBurner() {
    const { BURNER_KEY, burnerHandle } = await import('../lib/wallet');
    localStorage.setItem(BURNER_KEY, JSON.stringify({ v: 1, privateKey: key, createdAt: Date.now() }));
    return burnerHandle(who);
  }

  async function setPrice(p: bigint) {
    await anvil().setStorageAt({ address: ORACLE, index: slot(0n), value: slot(p) });
  }

  beforeAll(async () => {
    snapshot = await anvil().snapshot();
    await anvil().setCode({ address: ORACLE, bytecode: FRESH_ORACLE });
    await setPrice(PRICE);
    // anvil asks for a 1 gwei priority fee (Mezo: ~16 wei), so give the borrower room for gas.
    await anvil().setBalance({ address: who, value: E18 });

    const { publicClient, chainInfo, mezoTestnet } = await import('../lib/chains');
    const { borrowerOperationsAbi } = await import('../abi/trove');
    const { borrowHints } = await import('../lib/trove');
    const a = chainInfo(31611).addresses;
    const pc = publicClient(31611);
    const [fee, gasComp] = await Promise.all([
      pc.readContract({ address: a.borrowerOperations, abi: borrowerOperationsAbi, functionName: 'getBorrowingFee', args: [NET_DEBT] }),
      pc.readContract({
        address: a.borrowerOperations,
        abi: [{ type: 'function', name: 'MUSD_GAS_COMPENSATION', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }] as const,
        functionName: 'MUSD_GAS_COMPENSATION',
      }),
    ]);
    const hints = await borrowHints(31611, COLL, NET_DEBT + gasComp + fee);
    const wc = createWalletClient({ account: privateKeyToAccount(key), chain: mezoTestnet, transport: http(FORK, { timeout: 180_000 }) });
    const hash = await wc.writeContract({
      address: a.borrowerOperations,
      abi: borrowerOperationsAbi,
      functionName: 'openTrove',
      args: [NET_DEBT, hints.upper, hints.lower],
      value: COLL,
    });
    const rc = await pc.waitForTransactionReceipt({ hash, timeout: 180_000 });
    expect(rc.status).toBe('success');
  }, 600_000);

  afterAll(async () => {
    if (snapshot) await anvil().revert({ id: snapshot });
  }, 120_000);

  it('detects the trove and reads it the way TroveManager does', async () => {
    const { readLoan, computeCR, fmtRatio } = await import('../lib/trove');
    const loan = await readLoan(31611, who);
    expect(loan).not.toBeNull();
    expect(loan!.coll).toBe(COLL);
    expect(loan!.price).toBe(PRICE);
    expect(loan!.recoveryMode).toBe(false);
    // Principal = net debt + 200 MUSD gas deposit + the borrowing fee.
    expect(loan!.principal > NET_DEBT + 200n * E18).toBe(true);
    // Our ratio from (coll, principal + interest) equals getCurrentICR at the same block.
    expect(computeCR(loan!.coll, loan!.debt, PRICE)).toBe(loan!.icr);
    expect(fmtRatio(loan!.icr!)).toMatch(/^18\d\.\d%$/);
    // A fresh trove can borrow up to coll × price / MCR.
    expect(loan!.maxBorrowingCapacity).toBe((COLL * PRICE) / loan!.mcr);

    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    expect(await readLoan(31611, stranger)).toBeNull();
  });

  it('borrows with hints (tx 1) and lands where the plan said', async () => {
    const { borrowForPacket, readLoan, quoteBorrow, computeNominalCR, floorFromPct } = await import('../lib/trove');
    const { readBorrowingFee } = await import('../lib/trove');
    const { troveManagerAbi } = await import('../abi/trove');
    const { publicClient, chainInfo } = await import('../lib/chains');
    const { readBalances } = await import('../lib/chainData');
    const amount = 25n * E18;
    const q = await quoteBorrow(31611, who, amount, floorFromPct(160));
    expect(q?.plan.problem).toBeNull();
    expect(q!.plan.fee).toBe(await readBorrowingFee(31611, amount));
    const musdBefore = (await readBalances(31611, who)).musd;

    const w = await asBurner();
    const { plan, receipt } = await borrowForPacket(w, 31611, amount, floorFromPct(160));
    expect(receipt.status).toBe('success');
    borrowed = amount;
    console.log(`withdrawMUSD gas used: ${receipt.gasUsed}`);

    const after = await readLoan(31611, who);
    // The principal moved by exactly amount + fee; interest accrues separately.
    expect(after!.principal).toBe(plan.principalAfter);
    // Debt and ratio differ from the plan only by the interest accrued since the quote (1% a year).
    expect(after!.debt >= plan.debtAfter).toBe(true);
    expect(after!.debt - plan.debtAfter < E18 / 10n).toBe(true);
    const icrDiff = plan.icrAfter! > after!.icr! ? plan.icrAfter! - after!.icr! : after!.icr! - plan.icrAfter!;
    expect(icrDiff < 10n ** 15n).toBe(true); // under 0.1 percentage point
    const nicr = await publicClient(31611).readContract({
      address: chainInfo(31611).addresses.troveManager,
      abi: [...troveManagerAbi, { type: 'function', name: 'getNominalICR', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }] as const,
      functionName: 'getNominalICR',
      args: [who],
    });
    expect(nicr).toBe(computeNominalCR(COLL, plan.principalAfter));
    // The MUSD is in the sender's own wallet.
    expect((await readBalances(31611, who)).musd).toBe(musdBefore + amount);
  });

  it('then creates the packet with a permit (tx 2) from the borrowed MUSD', async () => {
    const { createPacket } = await import('../lib/actions');
    const w = await asBurner();
    const steps: string[] = [];
    const created = await createPacket(
      w,
      31611,
      { kind: 'musd', amount: borrowed },
      {
        shares: 5,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
        claimKey: privateKeyToAccount(generatePrivateKey()).address,
        attester: '0x0000000000000000000000000000000000000000',
        dripPerShare: 3_000_000_000_000n,
        tipPerShare: 1_000_000_000_000n,
        message: '借來的紅包',
      },
      (s) => steps.push(s),
    );
    expect(steps).toEqual(['permit', 'create']);
    expect(created.net).toBe((borrowed * 99n) / 100n);
  });

  it('refuses before sending when the ratio would cross the floor', async () => {
    const { borrowForPacket, quoteBorrow, floorFromPct } = await import('../lib/trove');
    const { errorCode } = await import('../lib/errors');
    const { publicClient } = await import('../lib/chains');
    // About 2,027 MUSD of debt on 3,700 MUSD of BTC: 400 more is about 152%, under a 160% floor.
    const q = await quoteBorrow(31611, who, 400n * E18, floorFromPct(160));
    expect(q?.plan.problem?.kind).toBe('floor');
    expect((await quoteBorrow(31611, who, 400n * E18, floorFromPct(150)))?.plan.problem).toBeNull();
    const nonce = await publicClient(31611).getTransactionCount({ address: who });
    const err = await borrowForPacket(await asBurner(), 31611, 400n * E18, floorFromPct(160)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(errorCode(err)).toBe('LoanBlocked');
    expect(await publicClient(31611).getTransactionCount({ address: who })).toBe(nonce);
  });

  it('Mezo’s own refusal (ICR < MCR) decodes as LoanBlocked', async () => {
    const { borrowerOperationsAbi } = await import('../abi/trove');
    const { chainInfo, publicClient } = await import('../lib/chains');
    const { errorCode, errorDetail } = await import('../lib/errors');
    const err = await publicClient(31611)
      .simulateContract({
        address: chainInfo(31611).addresses.borrowerOperations,
        abi: borrowerOperationsAbi,
        functionName: 'withdrawMUSD',
        args: [1_500n * E18, who, who],
        account: who,
      })
      .then(() => null, (e: unknown) => e);
    expect(errorCode(err)).toBe('LoanBlocked');
    expect(errorDetail(err)).toMatch(/BorrowerOps/);
  });

  it('blocks in Recovery Mode, read from TroveManager.checkRecoveryMode', async () => {
    const { quoteBorrow, floorFromPct } = await import('../lib/trove');
    // Testnet's system ratio is far above 150% at 74,000; at 20,000 it is well below.
    await setPrice(20_000n * E18);
    try {
      const q = await quoteBorrow(31611, who, E18, floorFromPct(160));
      expect(q?.loan.recoveryMode).toBe(true);
      expect(q?.plan.problem).toEqual({ kind: 'recovery' });
    } finally {
      await setPrice(PRICE);
    }
  });
});
