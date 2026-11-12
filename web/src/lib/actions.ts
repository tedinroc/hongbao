import { parseEventLogs, parseSignature, type Address, type Hex, type TransactionReceipt } from 'viem';
import { hongbaoAbi } from '../abi/hongbao';
import { hongbaoWithErrorsAbi, musdAbi } from '../abi/extra';
import { gaugeAbi, smusdAbi } from '../abi/mezo';
import { chainInfo, publicClient, type ChainId } from './chains';
import { permitTypedData } from './eip712';
import { HongbaoError, errorCode } from './errors';
import { sendContract, type WalletHandle } from './wallet';
import type { Balances } from './chainData';

/* ------------------------------------------------------------------ post-claim actions */

/** gauge.getReward(self): only the account itself may call it. */
export function claimMezo(w: WalletHandle, chainId: ChainId): Promise<TransactionReceipt> {
  return sendContract(w, chainId, {
    address: chainInfo(chainId).addresses.gauge,
    abi: gaugeAbi,
    functionName: 'getReward',
    args: [w.address],
  });
}

/** gauge.withdraw(amount): the caller's own stake back to sMUSD. */
export function unstake(w: WalletHandle, chainId: ChainId, amount: bigint): Promise<TransactionReceipt> {
  return sendContract(w, chainId, {
    address: chainInfo(chainId).addresses.gauge,
    abi: gaugeAbi,
    functionName: 'withdraw',
    args: [amount],
  });
}

/** sMUSD.withdraw(amount): burn sMUSD, receive MUSD plus any savings yield. */
export function withdrawSavings(w: WalletHandle, chainId: ChainId, amount: bigint): Promise<TransactionReceipt> {
  return sendContract(w, chainId, {
    address: chainInfo(chainId).addresses.smusd,
    abi: smusdAbi,
    functionName: 'withdraw',
    args: [amount],
  });
}

export type StepReporter = (step: string) => void;

/** Cash out: unstake everything staked, then turn all sMUSD into MUSD. */
export async function cashOut(w: WalletHandle, chainId: ChainId, b: Balances, onStep?: StepReporter): Promise<void> {
  if (b.staked > 0n) {
    onStep?.('unstake');
    await unstake(w, chainId, b.staked);
  }
  const total = b.smusd + b.staked;
  if (total > 0n) {
    onStep?.('withdraw');
    await withdrawSavings(w, chainId, total);
  }
}

/**
 * Make sure the wallet holds at least `need` MUSD, moving funds out of the gauge
 * and the savings vault as required. Returns how many transactions it sent.
 */
export async function prepareMusd(
  w: WalletHandle,
  chainId: ChainId,
  need: bigint,
  b: Balances,
  onStep?: StepReporter,
): Promise<number> {
  let missing = need - b.musd;
  if (missing <= 0n) return 0;
  let sent = 0;
  const fromSmusd = missing < b.smusd ? missing : b.smusd;
  const fromStake = missing - fromSmusd;
  if (fromStake > 0n) {
    if (fromStake > b.staked) throw new HongbaoError('ERC20InsufficientBalance');
    onStep?.('prepare');
    await unstake(w, chainId, fromStake);
    sent++;
  }
  missing = fromSmusd + fromStake;
  onStep?.('prepare');
  await withdrawSavings(w, chainId, missing);
  return sent + 1;
}

/** How many extra transactions prepareMusd would send. */
export function prepareTxCount(need: bigint, b: Balances): number {
  const missing = need - b.musd;
  if (missing <= 0n) return 0;
  return missing > b.smusd ? 2 : 1;
}

export function refundPacket(w: WalletHandle, chainId: ChainId, id: bigint): Promise<TransactionReceipt> {
  const hb = chainInfo(chainId).hongbao;
  if (!hb) throw new HongbaoError('NotDeployed');
  return sendContract(w, chainId, { address: hb, abi: hongbaoWithErrorsAbi, functionName: 'refund', args: [id] });
}

/* ------------------------------------------------------------------ create */

export interface CreateParams {
  shares: number;
  expiry: bigint;
  claimKey: Address;
  attester: Address;
  dripPerShare: bigint;
  tipPerShare: bigint;
  message: string;
}

export type CreateFunding =
  | { kind: 'musd'; amount: bigint }
  | { kind: 'btc'; btcIn: bigint; minMusdOut: bigint; maxSlippageBps: number };

export interface CreatedPacket {
  id: bigint;
  txHash: Hex;
  net: bigint;
}

function kitsValue(p: CreateParams): bigint {
  return BigInt(p.shares) * (p.dripPerShare + p.tipPerShare);
}

function parseCreated(chainId: ChainId, receipt: TransactionReceipt): CreatedPacket {
  const hb = chainInfo(chainId).hongbao!;
  const logs = parseEventLogs({ abi: hongbaoAbi, logs: receipt.logs, eventName: 'PacketCreated' }).filter(
    (l) => l.address.toLowerCase() === hb.toLowerCase(),
  );
  if (!logs.length) throw new HongbaoError('Unknown', 'No PacketCreated event in the receipt.');
  return { id: logs[0].args.id, txHash: receipt.transactionHash, net: logs[0].args.net };
}

async function musdDomain(chainId: ChainId): Promise<{ name: string; version: string }> {
  try {
    const d = await publicClient(chainId).readContract({
      address: chainInfo(chainId).addresses.musd,
      abi: musdAbi,
      functionName: 'eip712Domain',
    });
    return { name: d[1], version: d[2] };
  } catch {
    return { name: 'Mezo USD', version: '1' };
  }
}

/**
 * Create a packet. MUSD path: reuse an existing allowance, else an EIP-2612 permit
 * (one signature + one transaction), else approve + create. BTC path: createWithBTC.
 */
export async function createPacket(
  w: WalletHandle,
  chainId: ChainId,
  funding: CreateFunding,
  p: CreateParams,
  onStep?: StepReporter,
): Promise<CreatedPacket> {
  const info = chainInfo(chainId);
  const hb = info.hongbao;
  if (!hb) throw new HongbaoError('NotDeployed');
  const pc = publicClient(chainId);
  const params = {
    shares: p.shares,
    expiry: p.expiry,
    claimKey: p.claimKey,
    attester: p.attester,
    dripPerShare: p.dripPerShare,
    tipPerShare: p.tipPerShare,
    message: p.message,
  };
  const kits = kitsValue(p);

  if (funding.kind === 'btc') {
    onStep?.('create');
    const receipt = await sendContract(w, chainId, {
      address: hb,
      abi: hongbaoWithErrorsAbi,
      functionName: 'createWithBTC',
      args: [funding.btcIn, funding.minMusdOut, BigInt(funding.maxSlippageBps), params],
      value: funding.btcIn + kits,
    });
    return parseCreated(chainId, receipt);
  }

  const amount = funding.amount;
  const musd = info.addresses.musd;
  const allowance = await pc.readContract({ address: musd, abi: musdAbi, functionName: 'allowance', args: [w.address, hb] });

  const createDirect = async () => {
    onStep?.('create');
    const receipt = await sendContract(w, chainId, {
      address: hb,
      abi: hongbaoWithErrorsAbi,
      functionName: 'create',
      args: [amount, params],
      value: kits,
    });
    return parseCreated(chainId, receipt);
  };

  if (allowance >= amount) return createDirect();

  const approveThenCreate = async () => {
    onStep?.('approve');
    await sendContract(w, chainId, { address: musd, abi: musdAbi, functionName: 'approve', args: [hb, amount] });
    return createDirect();
  };

  // Permit: one signature, no fee.
  let sig: Hex;
  let deadline: bigint;
  try {
    onStep?.('permit');
    const [nonce, domain] = await Promise.all([
      pc.readContract({ address: musd, abi: musdAbi, functionName: 'nonces', args: [w.address] }),
      musdDomain(chainId),
    ]);
    deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
    sig = await w.signTypedData(
      chainId,
      permitTypedData({
        chainId,
        token: musd,
        owner: w.address,
        spender: hb,
        value: amount,
        nonce,
        deadline,
        name: domain.name,
        version: domain.version,
      }),
    );
  } catch (e) {
    if (errorCode(e) === 'UserRejected') throw e;
    // Wallet cannot sign typed data: fall back to approve + create.
    return approveThenCreate();
  }
  const { r, s, v, yParity } = parseSignature(sig);
  const vNum = v !== undefined ? Number(v) : yParity + 27;
  try {
    onStep?.('create');
    const receipt = await sendContract(w, chainId, {
      address: hb,
      abi: hongbaoWithErrorsAbi,
      functionName: 'createWithPermit',
      args: [amount, params, deadline, vNum, r, s],
      value: kits,
    });
    return parseCreated(chainId, receipt);
  } catch (e) {
    // The permit was not accepted (allowance still missing): approve + create instead.
    if (errorCode(e) === 'ERC20InsufficientAllowance') return approveThenCreate();
    throw e;
  }
}
