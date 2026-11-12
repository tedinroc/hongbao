import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n, type MessageKey } from '../i18n';
import { MezoCounter, WalletActions, useBalances } from '../components/WalletActions';
import { WalletPicker, WalletSummary } from '../components/WalletPanel';
import { IconPhone, IconRefresh } from '../components/Icons';
import { ChainPicker, ErrorNotice, Loading, Notice, Sheet, TxLink } from '../components/ui';
import { refundPacket } from '../lib/actions';
import { chainInfo, defaultChainId, publicClient, type ChainId } from '../lib/chains';
import { packetsBySender, type CreatedEvent } from '../lib/chainData';
import { hongbaoAbi } from '../abi/hongbao';
import { isPrivateKey } from '../lib/eip712';
import { cleanMessage, fmtBtc, fmtMusd, formatDuration } from '../lib/format';
import { useAsync, useNow } from '../lib/hooks';
import { useWallet } from '../lib/walletContext';
import type { WalletHandle } from '../lib/wallet';

export function Me() {
  const { t } = useI18n();
  const { active, burner, selectBurner, importKey } = useWallet();
  const [chainId, setChainId] = useState<ChainId>(defaultChainId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const bal = useBalances(chainId, active?.address);
  const info = chainInfo(chainId);

  return (
    <div className="stack-lg">
      <header>
        <h1 className="page-title">{t('me.title')}</h1>
      </header>

      <ChainPicker value={chainId} onChange={setChainId} need="all" />

      <section className="card stack">
        {active ? (
          <WalletSummary onPick={() => setPickerOpen(true)} />
        ) : (
          <div className="stack">
            <p className="muted">{t('me.none')}</p>
            <button type="button" className="btn btn-primary btn-block" onClick={() => selectBurner()}>
              <IconPhone />
              {t('wallet.create')}
            </button>
            <button type="button" className="btn btn-ghost btn-block" onClick={() => setPickerOpen(true)}>
              {t('wallet.connect')}
            </button>
          </div>
        )}
      </section>

      {active ? (
        <>
          <section className="balance-grid" aria-label="Balances">
            <div className="balance balance-hero">
              <div className="balance-label">{t('bal.earned')}</div>
              <MezoCounter balances={bal.data} />
            </div>
            <Bal label={t('bal.staked')} value={bal.data ? `${fmtMusd(bal.data.staked)}` : null} unit="sMUSD" />
            <Bal label={t('bal.smusd')} value={bal.data ? `${fmtMusd(bal.data.smusd)}` : null} unit="sMUSD" />
            <Bal label={t('bal.musd')} value={bal.data ? fmtMusd(bal.data.musd) : null} unit="MUSD" />
            <Bal label={t('bal.btc')} value={bal.data ? fmtBtc(bal.data.btc) : null} unit="BTC" />
          </section>
          <ErrorNotice error={bal.error} />

          <section className="stack">
            <h2 className="section-title">{t('me.actions')}</h2>
            <WalletActions chainId={chainId} balances={bal.data} reload={bal.reload} />
          </section>

          {info.hongbao ? <MyPackets chainId={chainId} wallet={active} /> : null}
        </>
      ) : null}

      {burner || !active ? (
        <div className="center">
          <button type="button" className="btn btn-quiet" onClick={() => setRestoreOpen(true)}>
            {t('restore.title')}
          </button>
        </div>
      ) : null}

      <WalletPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
      <RestoreSheet
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        hasBurner={Boolean(burner)}
        onRestore={(k) => importKey(k)}
      />
    </div>
  );
}

function Bal({ label, value, unit }: { label: string; value: string | null; unit: string }) {
  return (
    <div className="balance">
      <div className="balance-label">{label}</div>
      <div className={`balance-value ${value && value.length > 8 ? 'balance-value-long' : ''}`}>
        {value === null ? <span className="skeleton" /> : value} <span className="balance-unit">{unit}</span>
      </div>
    </div>
  );
}

interface MyPacket {
  ev: CreatedEvent;
  sharesLeft: number;
  remaining: bigint;
  refunded: boolean;
}

function MyPackets({ chainId, wallet }: { chainId: ChainId; wallet: WalletHandle }) {
  const { t } = useI18n();
  const now = useNow(30_000);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const list = useAsync<MyPacket[]>(async () => {
    const evs = await packetsBySender(chainId, wallet.address, (d, n) => setProgress([d, n]));
    const hb = chainInfo(chainId).hongbao!;
    const pc = publicClient(chainId);
    const states = await Promise.all(
      evs.map((e) => pc.readContract({ address: hb, abi: hongbaoAbi, functionName: 'getPacket', args: [e.id] })),
    );
    return evs
      .map((ev, i) => ({
        ev,
        sharesLeft: Number(states[i].sharesLeft),
        remaining: BigInt(states[i].remaining),
        refunded: states[i].refunded,
      }))
      .reverse();
  }, [chainId, wallet.address]);
  const [busy, setBusy] = useState<bigint | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  return (
    <section className="stack">
      <div className="row-between">
        <h2 className="section-title">{t('me.sent')}</h2>
        <button type="button" className="btn btn-quiet btn-sm" onClick={list.reload} aria-label={t('ledger.refresh')}>
          <IconRefresh />
        </button>
      </div>
      <p className="hint">{t('me.linkNote')}</p>
      {list.loading ? (
        <Loading label={progress ? t('me.scan', { done: progress[0], total: progress[1] }) : undefined} />
      ) : null}
      <ErrorNotice error={list.error ?? error} />
      {lastTx ? (
        <Notice kind="ok">
          {t('action.done')} <TxLink chainId={chainId} hash={lastTx} />
        </Notice>
      ) : null}
      {list.data && !list.data.length ? <div className="empty">{t('me.sentNone')}</div> : null}
      {list.data?.length ? (
        <ul className="list">
          {list.data.map((p) => {
            const expired = BigInt(now) >= p.ev.expiry;
            const status: MessageKey = p.refunded
              ? 'me.status.refunded'
              : p.sharesLeft === 0
                ? 'me.status.empty'
                : expired
                  ? 'me.status.expired'
                  : 'me.status.open';
            const canRefund = !p.refunded && p.remaining > 0n;
            return (
              <li key={p.ev.id.toString()} className="list-item">
                <div className="row-between">
                  <span className="row" style={{ gap: 8 }}>
                    <Link className="list-title" to={`/c/${chainId}/${p.ev.id.toString()}`}>
                      {t('me.packet', { id: p.ev.id.toString() })}
                    </Link>
                    <span className={`chip ${status === 'me.status.open' ? 'chip-ok' : ''}`}>{t(status)}</span>
                  </span>
                  <span className="mono">{fmtMusd(p.ev.net)} MUSD</span>
                </div>
                <div className="small muted">{t('common.quote', { text: cleanMessage(p.ev.message) })}</div>
                <div className="small muted">
                  {t('me.opened', { opened: p.ev.shares - p.sharesLeft, total: p.ev.shares })}
                  {!expired && !p.refunded && p.sharesLeft > 0 ? (
                    <> · {t('claim.expiresIn', { time: formatDuration(Number(p.ev.expiry) - now, t) })}</>
                  ) : null}
                </div>
                {canRefund ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(p.ev.id);
                      setError(null);
                      setLastTx(null);
                      try {
                        const r = await refundPacket(wallet, chainId, p.ev.id);
                        setLastTx(r.transactionHash);
                        list.reload();
                      } catch (e) {
                        setError(e);
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === p.ev.id ? <span className="spinner" /> : null}
                    {t('me.refund', { amount: fmtMusd(p.remaining) })}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function RestoreSheet({
  open,
  onClose,
  hasBurner,
  onRestore,
}: {
  open: boolean;
  onClose: () => void;
  hasBurner: boolean;
  onRestore: (key: string) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [bad, setBad] = useState(false);
  const close = () => {
    setValue('');
    setBad(false);
    onClose();
  };
  return (
    <Sheet open={open} onClose={close} title={t('restore.title')}>
      <input
        className="input mono"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={t('restore.placeholder')}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setBad(false);
        }}
      />
      {bad ? <Notice kind="error">{t('restore.invalid')}</Notice> : null}
      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={!value.trim()}
        onClick={() => {
          const k = value.trim();
          const norm = (k.startsWith('0x') ? k : `0x${k}`).toLowerCase();
          if (!isPrivateKey(norm)) {
            setBad(true);
            return;
          }
          if (hasBurner && !window.confirm(t('restore.confirm'))) return;
          onRestore(norm);
          close();
        }}
      >
        {t('restore.button')}
      </button>
    </Sheet>
  );
}
