import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { parseEventLogs, type Address, type Hex } from 'viem';
import { useI18n, type MessageKey } from '../i18n';
import { hongbaoAbi } from '../abi/hongbao';
import { Envelope } from '../components/Envelope';
import { IconPhone, IconWallet } from '../components/Icons';
import { MezoCounter, WalletActions, useBalances } from '../components/WalletActions';
import { WalletPicker } from '../components/WalletPanel';
import { AddressLink, ErrorNotice, Loading, Notice, Steps, TxLink } from '../components/ui';
import { refundPacket } from '../lib/actions';
import { deviceId, getConfig, postClaim, type PacketView } from '../lib/api';
import { chainInfo, parseChainId, publicClient, type ChainId } from '../lib/chains';
import { findPacketCreated, isClaimed, packetClaims, readPacket, type ClaimedEvent, type CreatedEvent } from '../lib/chainData';
import { Payout, checkLink, parseLinkFragment, signClaimWithLinkKey, type LinkFragment, type PayoutValue } from '../lib/eip712';
import { HongbaoError } from '../lib/errors';
import { cleanMessage, fmtBtc, fmtMusd, formatDuration, shortAddress } from '../lib/format';
import { useAsync, useInterval, useNow } from '../lib/hooks';
import { useWallet } from '../lib/walletContext';

interface ClaimResult {
  amount: bigint;
  payout: number;
  requested: PayoutValue;
  txHash: Hex;
  recipient: Address;
}

const PAYOUTS: { value: PayoutValue; title: MessageKey; body: MessageKey }[] = [
  { value: Payout.Stake, title: 'payout.stake', body: 'payout.stake.body' },
  { value: Payout.Save, title: 'payout.save', body: 'payout.save.body' },
  { value: Payout.Cash, title: 'payout.cash', body: 'payout.cash.body' },
];

export function Claim() {
  const { t } = useI18n();
  const params = useParams();
  const { hash } = useLocation();
  const chainId = parseChainId(params.chainId ?? null);
  const id = params.id && /^\d+$/.test(params.id) ? BigInt(params.id) : null;
  const info = chainId ? chainInfo(chainId) : null;

  if (!chainId || id === null || !info?.hongbao) {
    return (
      <div className="stack-lg">
        <Envelope state="closed" message={t('claim.title')} label={t('claim.title')} />
        <div className="center stack">
          <h1 className="page-title">{t('claim.unknown.title')}</h1>
          <p className="muted">{t('claim.unknown.body')}</p>
          <Link className="btn btn-ghost" to="/">
            {t('nav.home')}
          </Link>
        </div>
      </div>
    );
  }
  // The key lives only in the URL fragment, which browsers never send to a server.
  const frag = parseLinkFragment(hash);
  // A link made for another Hongbao contract never shows this site's packet with the same id.
  if (checkLink(frag, info.hongbao) === 'otherDeployment') {
    return <LinkProblem chainId={chainId} id={id} frag={frag} kind="otherDeployment" />;
  }
  return <ClaimInner chainId={chainId} id={id} frag={frag} />;
}

/** A link this site can't open: another deployment's, or a key for a different packet. */
function LinkProblem({
  chainId,
  id,
  frag,
  kind,
}: {
  chainId: ChainId;
  id: bigint;
  frag: LinkFragment;
  kind: 'otherDeployment' | 'keyMismatch';
}) {
  const { t } = useI18n();
  const info = chainInfo(chainId);
  const title: MessageKey = kind === 'otherDeployment' ? 'claim.otherDeployment.title' : 'claim.badKey.title';
  const body =
    kind === 'otherDeployment'
      ? t('claim.otherDeployment.body', {
          theirs: frag.contract ? shortAddress(frag.contract) : '?',
          ours: shortAddress(info.hongbao ?? ''),
          chain: t(info.nameKey),
        })
      : t('claim.badKey.body', { id: id.toString() });
  return (
    <div className="stack-lg">
      <Envelope state="closed" label={t('claim.title')} />
      <div className="card stack">
        <h1 className="section-title">{t(title)}</h1>
        <p className="muted">{body}</p>
      </div>
      <Link className="btn btn-ghost btn-block" to="/">
        {t('nav.home')}
      </Link>
    </div>
  );
}

function ClaimInner({ chainId, id, frag }: { chainId: ChainId; id: bigint; frag: LinkFragment }) {
  const { t } = useI18n();
  const info = chainInfo(chainId);
  const hongbao = info.hongbao!;
  const { active, selectBurner } = useWallet();
  const now = useNow(15_000);
  const linkKey = frag.key;

  const packet = useAsync(() => readPacket(chainId, id), [chainId, id]);
  const created = useAsync<CreatedEvent | null>(() => findPacketCreated(chainId, id).catch(() => null), [chainId, id]);
  useInterval(() => packet.reload(), 15_000);

  const recipientAddr = active?.address ?? null;
  const already = useAsync(
    () => isClaimed(chainId, id, recipientAddr!),
    [chainId, id, recipientAddr],
    Boolean(recipientAddr),
  );

  const [payout, setPayout] = useState<PayoutValue>(Payout.Stake);
  const [phase, setPhase] = useState<'idle' | 'sign' | 'relay' | 'confirm'>('idle');
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<ClaimResult | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const p: PacketView | null | undefined = packet.data;
  // Sender messages are untrusted: shown as plain text, bidi controls stripped, 200 bytes at most.
  const rawMessage = created.data?.message ?? p?.message ?? null;
  const message = useMemo(() => (rawMessage ? cleanMessage(rawMessage) || null : null), [rawMessage]);
  const expired = p ? BigInt(now) >= p.expiry : false;
  const closed = p ? p.refunded || p.sharesLeft === 0 || expired : false;
  // With a key, check it opens this packet before showing the packet. A link without a key
  // (from the ledger or "My wallet") still shows the public packet, with a note on how to claim.
  const linkState = p ? checkLink(frag, hongbao, p.claimKey) : 'ok';

  // While an unopened packet waits, hide the app's bottom tabs on phones so the one button owns the screen.
  const focus = Boolean(p && linkKey && !closed && !result && !(already.data && recipientAddr) && linkState === 'ok');
  useEffect(() => {
    if (!focus) return;
    document.documentElement.classList.add('claim-focus');
    return () => document.documentElement.classList.remove('claim-focus');
  }, [focus]);

  const onOpen = async () => {
    if (!linkKey || !p) return;
    setError(null);
    try {
      setPhase('sign');
      const wallet = active ?? selectBurner();
      const recipient = wallet.address;
      const [claimedAlready, cfg] = await Promise.all([isClaimed(chainId, id, recipient), getConfig()]);
      if (claimedAlready) throw new HongbaoError('AlreadyClaimed');
      // Bind the signature to our relayer so a copied transaction cannot take the relay tip.
      const relayer = cfg.chains[String(chainId)]?.relayer;
      if (!relayer) throw new HongbaoError('RelayerUnavailable');
      const keySig = await signClaimWithLinkKey(linkKey, chainId, hongbao, id, recipient, payout, relayer);
      setPhase('relay');
      const { txHash } = await postClaim({ chainId, packetId: id, recipient, payout, keySig, relayer, device: deviceId() });
      setPhase('confirm');
      const receipt = await publicClient(chainId).waitForTransactionReceipt({
        hash: txHash,
        timeout: 180_000,
        pollingInterval: 1_500,
      });
      if (receipt.status !== 'success') throw new HongbaoError('Unknown', `Transaction ${txHash} reverted.`);
      const ev = parseEventLogs({ abi: hongbaoAbi, logs: receipt.logs, eventName: 'Claimed' }).find(
        (l) => l.address.toLowerCase() === hongbao.toLowerCase() && l.args.id === id,
      );
      if (!ev) throw new HongbaoError('Unknown', 'No Claimed event in the receipt.');
      setResult({ amount: ev.args.amount, payout: Number(ev.args.payout), requested: payout, txHash, recipient });
      window.scrollTo(0, 0);
      packet.reload();
    } catch (e) {
      setError(e);
    } finally {
      setPhase('idle');
    }
  };

  /* ---------------------------------------------------------------- render */

  if (packet.loading && !p) {
    return (
      <div className="stack-lg">
        <Envelope state="closed" label={t('claim.title')} />
        <div className="center">
          <Loading />
        </div>
      </div>
    );
  }

  if (packet.error && !p) {
    return (
      <div className="stack-lg">
        <Envelope state="closed" label={t('claim.title')} />
        <ErrorNotice error={packet.error} />
        <button type="button" className="btn btn-ghost" onClick={packet.reload}>
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (!p) {
    return (
      <div className="stack-lg">
        <Envelope state="closed" label={t('claim.title')} />
        <div className="center stack">
          <h1 className="page-title">{t('claim.unknown.title')}</h1>
          <p className="muted">{t('claim.unknown.body')}</p>
        </div>
      </div>
    );
  }

  if (linkState === 'keyMismatch' || linkState === 'otherDeployment') {
    return <LinkProblem chainId={chainId} id={id} frag={frag} kind={linkState} />;
  }

  if (result) {
    return <ClaimSuccess chainId={chainId} result={result} packet={p} message={message} />;
  }

  if (already.data && recipientAddr) {
    return <AlreadyClaimed chainId={chainId} id={id} who={recipientAddr} created={created.data ?? null} packet={p} message={message} />;
  }

  const timeLeft = Number(p.expiry) - now;
  const envelope = (
    <Envelope
      state="closed"
      label={t('claim.title')}
      message={message ?? t('claim.title')}
      sub={t('claim.from', { addr: shortAddress(p.sender) })}
      pill={closed ? undefined : t('claim.left', { left: p.sharesLeft, total: p.sharesTotal })}
    />
  );

  if (closed) {
    return (
      <div className="stack-lg">
        {envelope}
        <FinalTally chainId={chainId} id={id} packet={p} created={created.data ?? null} expired={expired} />
      </div>
    );
  }

  const busy = phase !== 'idle';
  const steps = [
    { key: 'sign', label: t('claim.step.sign') },
    { key: 'relay', label: t('claim.step.relay') },
    { key: 'confirm', label: t('claim.step.confirm') },
  ];

  return (
    <div className="stack-lg claim-page">
      <div className="stack">
        {envelope}
        <div className="claim-meta">
          <span className="chip chip-red">{t('claim.each', { amount: fmtMusd(p.nextShare) })}</span>
          <span className="chip">{t('claim.expiresIn', { time: formatDuration(timeLeft, t) })}</span>
          {info.testnet ? <span className="chip">{t('chain.testnet')}</span> : null}
        </div>
      </div>

      {!linkKey ? (
        <div className="card stack">
          <h2 className="section-title">{t('claim.noKey.title')}</h2>
          <p className="muted">{t('claim.noKey.body')}</p>
        </div>
      ) : (
        <>
          <section className="stack-sm">
            <h2 className="section-title">{t('claim.choose')}</h2>
            <div className="stack-sm" role="radiogroup" aria-label={t('claim.choose')}>
              {PAYOUTS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={payout === o.value}
                  className="option"
                  onClick={() => setPayout(o.value)}
                  disabled={busy}
                >
                  <span className="option-dot" />
                  <span>
                    <span className="option-title">
                      {t(o.title)}
                      {o.value === Payout.Stake ? <span className="chip chip-gold">{t('payout.recommended')}</span> : null}
                    </span>
                    <span className="option-body">
                      {t(o.body)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="claim-to">
            <div className="wallet-avatar">{active?.kind === 'injected' ? <IconWallet /> : <IconPhone />}</div>
            <div className="wallet-meta">
              <div className="label">{t('claim.to')}</div>
              <div className="wallet-name">
                {active ? (active.kind === 'burner' ? t('wallet.thisPhone') : active.name) : t('wallet.newOnPhone')}
                {active ? <span className="wallet-addr"> · {shortAddress(active.address)}</span> : null}
              </div>
            </div>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setPickerOpen(true)} disabled={busy}>
              {t('wallet.change')}
            </button>
          </section>

          {/* Stays pinned to the bottom of the screen on phones, so the one big button is always in reach. */}
          <section className="claim-cta">
            {busy ? <Steps steps={steps} current={phase} done={false} /> : null}
            <ErrorNotice error={error} />
            <button type="button" className="btn btn-gold btn-xl btn-block" onClick={onOpen} disabled={busy}>
              {busy ? <span className="spinner" /> : null}
              {busy ? t('claim.opening') : t('claim.open')}
            </button>
            {busy ? null : <p className="hint center">{t('claim.free')}</p>}
          </section>
        </>
      )}

      <WalletPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </div>
  );
}

/** The line that says how a share was paid, from the payout Hongbao actually used. */
function payoutAs(paid: number): MessageKey {
  return paid === Payout.Cash ? 'claim.done.as.2' : paid === Payout.Save ? 'claim.done.as.1' : 'claim.done.as.0';
}

function payoutName(paid: number): MessageKey {
  return paid === Payout.Cash ? 'payout.cash' : paid === Payout.Save ? 'payout.save' : 'payout.stake';
}

function ClaimSuccess({
  chainId,
  result,
  packet,
  message,
}: {
  chainId: ChainId;
  result: ClaimResult;
  packet: PacketView;
  message: string | null;
}) {
  const { t } = useI18n();
  const bal = useBalances(chainId, result.recipient);
  // Hongbao pays Stake or Cash as Save when Mezo's gauge or vault refuses (Claimed.payout says which).
  const fellBack = result.payout !== result.requested && result.requested !== Payout.Save;
  return (
    <div className="stack-lg">
      <Envelope
        state="open"
        label={`${t('claim.done.title')} · ${fmtMusd(result.amount)} MUSD`}
        message={message ?? t('claim.title')}
        letter={
          <>
            <div className="env-letter-label">{t(payoutName(result.payout))}</div>
            <div className="env-letter-amount">{fmtMusd(result.amount)}</div>
            <div className="env-letter-unit">MUSD</div>
          </>
        }
      />
      <div className="center stack-sm reveal reveal-delay">
        <h1 className="page-title">{t('claim.done.title')}</h1>
        <p className="muted">{t(payoutAs(result.payout))}</p>
        {packet.dripPerShare > 0n ? <p className="hint">{t('claim.drip', { btc: fmtBtc(packet.dripPerShare) })}</p> : null}
        <div className="row" style={{ justifyContent: 'center' }}>
          <TxLink chainId={chainId} hash={result.txHash} />
        </div>
      </div>
      {fellBack ? (
        <Notice kind="gold">{t(result.requested === Payout.Cash ? 'claim.fellBack.2' : 'claim.fellBack.0')}</Notice>
      ) : null}
      {result.payout === Payout.Stake ? (
        <div className="card center stack-sm reveal reveal-delay">
          <span className="label">{t('claim.earned')}</span>
          <MezoCounter balances={bal.data} />
        </div>
      ) : null}
      <section className="stack reveal reveal-delay">
        <h2 className="section-title">{t('claim.next')}</h2>
        <WalletActions chainId={chainId} balances={bal.data} reload={bal.reload} passOnAmount={result.amount} />
      </section>
    </div>
  );
}

function AlreadyClaimed({
  chainId,
  id,
  who,
  created,
  packet,
  message,
}: {
  chainId: ChainId;
  id: bigint;
  who: Address;
  created: CreatedEvent | null;
  packet: PacketView;
  message: string | null;
}) {
  const { t } = useI18n();
  const bal = useBalances(chainId, who);
  const mine = useAsync<ClaimedEvent | null>(
    async () => {
      if (!created) return null;
      const list = await packetClaims(chainId, id, created.blockNumber);
      return list.find((c) => c.recipient.toLowerCase() === who.toLowerCase()) ?? null;
    },
    [chainId, id, who, created?.blockNumber],
  );
  return (
    <div className="stack-lg">
      <Envelope
        state="peek"
        label={t('claim.already')}
        message={message ?? t('claim.title')}
        letter={
          <>
            <div className="env-letter-label">{mine.data ? t(payoutName(mine.data.payout)) : t('claim.title')}</div>
            <div className="env-letter-amount">{mine.data ? fmtMusd(mine.data.amount) : '·'}</div>
            <div className="env-letter-unit">MUSD</div>
          </>
        }
      />
      <div className="center stack-sm">
        <h1 className="page-title">{t('claim.already')}</h1>
        {mine.data ? <p className="muted">{t(payoutAs(mine.data.payout))}</p> : null}
        <p className="muted">{t('claim.left', { left: packet.sharesLeft, total: packet.sharesTotal })}</p>
        {mine.data ? (
          <div className="row" style={{ justifyContent: 'center' }}>
            <TxLink chainId={chainId} hash={mine.data.txHash} />
          </div>
        ) : null}
      </div>
      {bal.data && bal.data.staked > 0n ? (
        <div className="card center stack-sm">
          <span className="label">{t('claim.earned')}</span>
          <MezoCounter balances={bal.data} />
        </div>
      ) : null}
      <section className="stack">
        <h2 className="section-title">{t('claim.next')}</h2>
        <WalletActions chainId={chainId} balances={bal.data} reload={bal.reload} passOnAmount={mine.data?.amount} />
      </section>
    </div>
  );
}

function FinalTally({
  chainId,
  id,
  packet,
  created,
  expired,
}: {
  chainId: ChainId;
  id: bigint;
  packet: PacketView;
  created: CreatedEvent | null;
  expired: boolean;
}) {
  const { t } = useI18n();
  const { active } = useWallet();
  const claims = useAsync(
    () => (created ? packetClaims(chainId, id, created.blockNumber) : Promise.resolve([] as ClaimedEvent[])),
    [chainId, id, created?.blockNumber],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [refunded, setRefunded] = useState<bigint | null>(null);
  const opened = claims.data?.length ?? packet.sharesTotal - packet.sharesLeft;
  const total = claims.data?.reduce((s, c) => s + c.amount, 0n) ?? 0n;
  const isSender = active && active.address.toLowerCase() === packet.sender.toLowerCase();
  const canRefund = !packet.refunded && packet.remaining > 0n && (expired || isSender) && refunded === null;

  useEffect(() => setRefunded(null), [id]);

  const title: MessageKey = packet.refunded
    ? 'claim.closed.refunded'
    : packet.sharesLeft === 0
      ? 'claim.closed.empty'
      : 'claim.closed.expired';

  return (
    <div className="stack">
      <div className="center stack-sm">
        <h1 className="page-title">{t(title)}</h1>
        <p className="muted mono">
          {claims.data
            ? t('claim.tally', { opened, total: packet.sharesTotal, amount: fmtMusd(total) })
            : t('me.opened', { opened, total: packet.sharesTotal })}
        </p>
      </div>
      {!packet.refunded && packet.remaining > 0n && refunded === null ? (
        <Notice>{t(expired ? 'claim.restWaiting' : 'claim.restOpen', { amount: fmtMusd(packet.remaining) })}</Notice>
      ) : null}
      {claims.loading ? <Loading /> : null}
      {claims.data && claims.data.length ? (
        <div className="card">
          <h2 className="label" style={{ marginBottom: 6 }}>
            {t('claim.who')}
          </h2>
          <ul className="who-list">
            {claims.data.map((c) => (
              <li key={c.txHash}>
                <AddressLink
                  chainId={chainId}
                  address={c.recipient}
                  you={Boolean(active && active.address.toLowerCase() === c.recipient.toLowerCase())}
                />
                <span className="mono">{fmtMusd(c.amount)} MUSD</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {canRefund && active ? (
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await refundPacket(active, chainId, id);
              setRefunded(packet.remaining);
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <span className="spinner" /> : null}
          {isSender ? t('claim.refundMine') : t('claim.refund')}
        </button>
      ) : null}
      {refunded !== null ? <Notice kind="ok">{t('claim.refunded', { amount: fmtMusd(refunded) })}</Notice> : null}
      <ErrorNotice error={error} />
      <Link to="/send" className="btn btn-ghost btn-block">
        {t('landing.ctaSend')}
      </Link>
    </div>
  );
}
