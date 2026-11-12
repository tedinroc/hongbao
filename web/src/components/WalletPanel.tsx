import { useState } from 'react';
import { useI18n } from '../i18n';
import { shortAddress } from '../lib/format';
import { useCopy } from '../lib/hooks';
import { revealBurnerKey } from '../lib/wallet';
import { useWallet } from '../lib/walletContext';
import { IconCopy, IconKey, IconPhone, IconWallet } from './Icons';
import { ErrorNotice, Notice, Sheet } from './ui';

/** Sheet listing injected wallets (EIP-6963) plus the phone wallet. */
export function WalletPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { providers, connect, selectBurner } = useWallet();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} title={t('wallet.pick')}>
      {providers.length ? (
        <div className="provider-list">
          {providers.map((p) => (
            <button
              key={p.info.uuid}
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await connect(p);
                  onClose();
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {p.info.icon ? <img src={p.info.icon} alt="" /> : <IconWallet width={28} height={28} />}
              {p.info.name}
            </button>
          ))}
        </div>
      ) : (
        <Notice>{t('wallet.none')}</Notice>
      )}
      <ErrorNotice error={error} />
      <button
        type="button"
        className="btn btn-ghost btn-block"
        onClick={() => {
          try {
            selectBurner();
            onClose();
          } catch (e) {
            setError(e);
          }
        }}
      >
        <IconPhone />
        {t('wallet.usePhone')}
      </button>
    </Sheet>
  );
}

/** Shows the active wallet with a way to switch. */
export function WalletSummary({ onPick }: { onPick: () => void }) {
  const { t } = useI18n();
  const { active, burner, disconnect } = useWallet();
  if (!active) {
    return (
      <div className="stack-sm">
        <button type="button" className="btn btn-ghost btn-block" onClick={onPick}>
          <IconWallet />
          {t('wallet.connect')}
        </button>
      </div>
    );
  }
  const isBurner = active.kind === 'burner';
  return (
    <div className="wallet-card">
      <div className="wallet-avatar">
        {isBurner ? <IconPhone /> : active.icon ? <img src={active.icon} alt="" /> : <IconWallet />}
      </div>
      <div className="wallet-meta">
        <div className="wallet-name">{isBurner ? t('wallet.thisPhone') : active.name}</div>
        <div className="wallet-addr row wrap" style={{ gap: '4px 8px' }} title={active.address}>
          <span className="nowrap">{shortAddress(active.address)}</span>
          {isBurner && burner && !burner.backedUp ? <span className="chip chip-gold">{t('wallet.notBackedUp')}</span> : null}
        </div>
      </div>
      {isBurner ? (
        <button type="button" className="btn btn-quiet btn-sm" onClick={onPick}>
          {t('wallet.change')}
        </button>
      ) : (
        <button type="button" className="btn btn-quiet btn-sm" onClick={disconnect}>
          {t('wallet.disconnect')}
        </button>
      )}
    </div>
  );
}

/** Reveal and copy the phone wallet's key, with a clear warning. */
export function BackupSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { markBackedUp } = useWallet();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, copy] = useCopy();
  const close = () => {
    setRevealed(null);
    onClose();
  };
  return (
    <Sheet open={open} onClose={close} title={t('backup.title')}>
      <Notice kind="warn">{t('backup.warn')}</Notice>
      {revealed ? (
        <>
          <div className="key-box">{revealed}</div>
          <button type="button" className="btn btn-ghost btn-block" onClick={() => void copy(revealed)}>
            <IconCopy />
            {copied ? t('common.copied') : t('backup.copy')}
          </button>
          <p className="hint">{t('backup.hint')}</p>
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => {
              markBackedUp();
              close();
            }}
          >
            {t('backup.confirm')}
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-primary btn-block" onClick={() => setRevealed(revealBurnerKey())}>
          <IconKey />
          {t('backup.reveal')}
        </button>
      )}
    </Sheet>
  );
}
