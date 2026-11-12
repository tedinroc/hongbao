/**
 * End-to-end run of the web app's library code against real Mezo contracts on an
 * anvil fork of Mezo testnet. Skipped unless VITE_FORK_RPC is set, e.g.:
 *
 *   anvil --fork-url https://rpc.test.mezo.org --port 8645 --auto-impersonate \
 *         --base-fee 130 --gas-price 146
 *   forge create src/Hongbao.sol:Hongbao --rpc-url http://127.0.0.1:8645 --unlocked --from <addr> --broadcast \
 *         --constructor-args "(<testnet wiring>)"
 *   VITE_FORK_RPC=http://127.0.0.1:8645 VITE_FORK_HONGBAO=<address> VITE_FORK_FROM_BLOCK=<block> npx vitest run src/e2e
 *
 * It exercises: permit create (actions.createPacket), packet reads, link-key claim
 * signing, a relayed claim that stakes in the real sMUSD gauge, live balances,
 * cash out (gauge withdraw + sMUSD withdraw), pass it on, refund, the ledger's
 * event and follow-up scans, and custom-error decoding.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const FORK = import.meta.env.VITE_FORK_RPC as string | undefined;
const HB = import.meta.env.VITE_FORK_HONGBAO as Address | undefined;

vi.mock('../lib/chains', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/chains')>();
  const fork = import.meta.env.VITE_FORK_RPC as string | undefined;
  if (!fork) return real;
  const { createPublicClient, http: h } = await import('viem');
  const client = createPublicClient({ chain: real.mezoTestnet, transport: h(fork), batch: { multicall: true } });
  const info = {
    ...real.CHAINS[31611],
    hongbao: import.meta.env.VITE_FORK_HONGBAO as Address,
    rpcUrls: [fork],
    deployBlock: BigInt((import.meta.env.VITE_FORK_FROM_BLOCK as string | undefined) ?? '0'),
    enabled: true,
  };
  return {
    ...real,
    CHAINS: { ...real.CHAINS, 31611: info },
    publicClient: () => client,
    chainInfo: () => info,
  };
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
const MUSD: Address = '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503';

// A cold fork fetches every touched slot from the testnet RPC, so single steps can
// take several seconds; vitest's 5 s default made the first run after a fresh fork flaky.
describe.skipIf(!FORK || !HB)('fork E2E against Mezo testnet contracts', { timeout: 120_000 }, () => {
  const senderKey = generatePrivateKey();
  const recipientKey = generatePrivateKey();
  const relayerKey = generatePrivateKey();
  const linkKey = generatePrivateKey();
  const sender = privateKeyToAccount(senderKey).address;
  const recipient = privateKeyToAccount(recipientKey).address;
  const relayer = privateKeyToAccount(relayerKey);
  let packetId = 0n;
  let passOnId = 0n;
  let share = 0n;

  const anvil = () => createTestClient({ mode: 'anvil', transport: http(FORK) });

  async function setMusd(who: Address, amount: bigint) {
    // MUSD is OpenZeppelin ERC20: _balances is storage slot 0.
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, 0n]));
    await anvil().setStorageAt({ address: MUSD, index: slot, value: `0x${amount.toString(16).padStart(64, '0')}` as Hex });
  }

  async function asBurner(key: Hex) {
    const { BURNER_KEY, burnerHandle } = await import('../lib/wallet');
    localStorage.setItem(BURNER_KEY, JSON.stringify({ v: 1, privateKey: key, createdAt: Date.now() }));
    return burnerHandle(privateKeyToAccount(key).address);
  }

  beforeAll(async () => {
    await anvil().setBalance({ address: sender, value: E18 / 100n });
    await anvil().setBalance({ address: relayer.address, value: E18 / 100n });
    await setMusd(sender, 100n * E18);
  }, 120_000);

  it('creates a packet with an EIP-2612 permit (one signature + one tx)', async () => {
    const { createPacket } = await import('../lib/actions');
    const steps: string[] = [];
    const w = await asBurner(senderKey);
    const created = await createPacket(
      w,
      31611,
      { kind: 'musd', amount: 10n * E18 },
      {
        shares: 3,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
        claimKey: privateKeyToAccount(linkKey).address,
        attester: '0x0000000000000000000000000000000000000000',
        dripPerShare: 3_000_000_000_000n,
        tipPerShare: 1_000_000_000_000n,
        message: '恭喜發財',
      },
      (s) => steps.push(s),
    );
    expect(steps).toEqual(['permit', 'create']);
    expect(created.net).toBe((10n * E18 * 99n) / 100n);
    packetId = created.id;

    const { readPacketChain, findPacketCreated } = await import('../lib/chainData');
    const p = await readPacketChain(31611, packetId);
    expect(p?.sharesLeft).toBe(3);
    expect(p?.remaining).toBe(created.net);
    expect(p?.claimKey).toBe(privateKeyToAccount(linkKey).address);
    share = p!.nextShare;
    const ev = await findPacketCreated(31611, packetId);
    expect(ev?.message).toBe('恭喜發財');
  });

  it('claims with the link key through a relayer and stakes in the real gauge', async () => {
    const { signClaimWithLinkKey, Payout } = await import('../lib/eip712');
    const { hongbaoAbi } = await import('../abi/hongbao');
    const { publicClient, mezoTestnet } = await import('../lib/chains');
    const keySig = await signClaimWithLinkKey(linkKey, 31611, HB!, packetId, recipient, Payout.Stake);
    const wc = createWalletClient({ account: relayer, chain: mezoTestnet, transport: http(FORK) });
    const hash = await wc.writeContract({
      address: HB!,
      abi: hongbaoAbi,
      functionName: 'claim',
      args: [packetId, recipient, Payout.Stake, keySig, 0n, '0x'],
    });
    const receipt = await publicClient(31611).waitForTransactionReceipt({ hash });
    const ev = parseEventLogs({ abi: hongbaoAbi, logs: receipt.logs, eventName: 'Claimed' })[0];
    expect(ev.args.recipient).toBe(recipient);
    expect(ev.args.amount).toBe(share);
    expect(ev.args.payout).toBe(Payout.Stake);

    const { readBalances } = await import('../lib/chainData');
    const b = await readBalances(31611, recipient);
    expect(b.staked).toBe(share);
    expect(b.btc).toBe(3_000_000_000_000n); // the gas drip
  });

  it('decodes AlreadyClaimed for a second claim by the same wallet', async () => {
    const { signClaimWithLinkKey, Payout } = await import('../lib/eip712');
    const { hongbaoWithErrorsAbi } = await import('../abi/extra');
    const { publicClient } = await import('../lib/chains');
    const { errorCode } = await import('../lib/errors');
    const keySig = await signClaimWithLinkKey(linkKey, 31611, HB!, packetId, recipient, Payout.Save);
    const err = await publicClient(31611)
      .simulateContract({
        address: HB!,
        abi: hongbaoWithErrorsAbi,
        functionName: 'claim',
        args: [packetId, recipient, Payout.Save, keySig, 0n, '0x'],
        account: relayer.address,
      })
      .then(() => null, (e: unknown) => e);
    expect(errorCode(err)).toBe('AlreadyClaimed');
  });

  it('cash out: gauge withdraw then sMUSD withdraw, from the phone wallet', async () => {
    // anvil reports a 1 gwei priority fee where Mezo reports ~16 wei (testnet) / ~1.6e5 wei (mainnet),
    // so top up the drip here; on Mezo the 0.000003 BTC drip covers these calls.
    await anvil().setBalance({ address: recipient, value: E18 / 1000n });
    const { readBalances } = await import('../lib/chainData');
    const { cashOut } = await import('../lib/actions');
    const w = await asBurner(recipientKey);
    const before = await readBalances(31611, recipient);
    const steps: string[] = [];
    await cashOut(w, 31611, before, (s) => steps.push(s));
    expect(steps).toEqual(['unstake', 'withdraw']);
    const after = await readBalances(31611, recipient);
    expect(after.staked).toBe(0n);
    expect(after.smusd).toBe(0n);
    expect(after.musd >= share).toBe(true);
  });

  it('pass it on: the recipient makes a packet with no gas kits', async () => {
    const { createPacket } = await import('../lib/actions');
    const w = await asBurner(recipientKey);
    const created = await createPacket(
      w,
      31611,
      { kind: 'musd', amount: share / 2n },
      {
        shares: 1,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
        claimKey: privateKeyToAccount(generatePrivateKey()).address,
        attester: '0x0000000000000000000000000000000000000000',
        dripPerShare: 0n,
        tipPerShare: 0n,
        message: 'pass it on',
      },
    );
    // Other suites may share the fork, so the id is only known to be newer.
    expect(created.id > packetId).toBe(true);
    passOnId = created.id;
  });

  it('the sender takes back what is left', async () => {
    const { refundPacket } = await import('../lib/actions');
    const { readPacketChain } = await import('../lib/chainData');
    const w = await asBurner(senderKey);
    await refundPacket(w, 31611, packetId);
    const p = await readPacketChain(31611, packetId);
    expect(p?.refunded).toBe(true);
    expect(p?.remaining).toBe(0n);
  });

  it('the ledger sees every event and the recipient’s follow-ups, verified by tx.from', async () => {
    const { loadHongbaoEvents, loadFollowUps } = await import('../lib/chainData');
    const ev = await loadHongbaoEvents(31611);
    // The fork may hold packets from earlier runs; look at this run's ids only.
    const mine = (id: bigint) => id === packetId || id === passOnId;
    expect(ev.created.filter((e) => mine(e.id)).map((e) => e.id)).toEqual([packetId, passOnId]);
    expect(ev.claimed.filter((e) => e.id === packetId).map((e) => e.recipient)).toEqual([recipient]);
    expect(ev.refunded.filter((e) => e.id === packetId)).toHaveLength(1);
    const follow = await loadFollowUps(31611, ev, (a) => a === recipient);
    const kinds = follow.map((f) => f.kind).sort();
    expect(kinds).toEqual(['gaugeWithdraw', 'packet', 'smusdWithdraw']);
    expect(follow.every((f) => f.who === recipient)).toBe(true);
  });
});
