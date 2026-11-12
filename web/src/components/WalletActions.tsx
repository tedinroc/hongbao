import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { cashOut, claimMezo } from '../lib/actions';
import type { ChainId } from '../lib/chains';
import { readBalances, type Balances } from '../lib/chainData';
import { fmtMezo } from '../lib/format';
import { useInterval, useReducedMotion } from '../lib/hooks';
import { useWallet } from '../lib/walletContext';
import { IconEnvelope, IconKey, IconReturn, IconSpark } from './Icons';
import { BackupSheet } from './WalletPanel';
import { ErrorNotice, Notice } from './ui';

/**
 * Live "MEZO earned": gauge.earned() polled every 5 s, and between polls it
 * advances by this account's share of the gauge reward rate.
 */
export function MezoCounter({ balances }: { balances: Balances | undefined }) {
  const reduced = useReducedMotion();
  const base = useRef<{ earned: bigint; rate: bigint; at: number } | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    if (balances) base.current = { earned: balances.earned, rate: balances.ratePerSec, at: Date.now() };
    force((n) => n + 1);
  }, [balances]);
  useInterval(() => force((n) => n + 1), reduced ? null : 250);
  const b = base.current;
  if (!b) return <span className="counter">0.000000</span>;
  const elapsedMs = BigInt(Math.max(0, Date.now() - b.at));
  const value = reduced ? b.earned : b.earned + (b.rate * elapsedMs) / 1000n;
  return (
    <span className="counter" aria-live="off">
      {fmtMezo(value)}
    </span>
  );
}

/** Poll balances for an address every `ms` (5 s by default, per SPEC). */
export function useBalances(chainId: ChainId, address: string | undefined, ms = 5000) {
  const [data, setData] = useState<Balances | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const load = async () => {
    if (!address) return;
    try {
      const b = await readBalances(chainId, address as `0x${string}`);
      setData(b);
      setError(null);
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    setData(undefined);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, address]);
  useInterval(() => void load(), address ? ms : null);
  return { data, error, reload: load };
}

/** Pass it on / Claim MEZO / Cash out / Back up, acting with the active wallet. */
export function WalletActions({
  chainId,
  balances,
  reload,
  passOnAmount,
}: {
  chainId: ChainId;
  balances: Balances | undefined;
  reload: () => void | Promise<void>;
  passOnAmount?: bigint;
}) {
  const { t } = useI18n();
  const { active } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const b = balances;
  const savings = b ? b.staked + b.smusd : 0n;
  const passAmount = passOnAmount ?? (b ? b.musd + savings : 0n);

  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    setOk(false);
    try {
      await fn();
      setOk(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
      await reload();
    }
  };

  const noGas = b !== undefined && b.btc === 0n;

  return (
    <div className="stack">
      <div className="action-grid">
        {passAmount > 0n ? (
          <Link className="action" to={`/send?passOn=1&chain=${chainId}&amount=${passAmount.toString()}`}>
            <span className="action-icon">
              <IconEnvelope />
            </span>
            <span className="action-title">{t('action.passOn')}</span>
            <span className="action-body">{t('action.passOn.body')}</span>
          </Link>
        ) : (
          <button type="button" className="action" disabled>
            <span className="action-icon">
              <IconEnvelope />
            </span>
            <span className="action-title">{t('action.passOn')}</span>
            <span className="action-body">{t('action.passOn.body')}</span>
          </button>
        )}
        <button
          type="button"
          className="action"
          disabled={!active || !b || b.earned === 0n || busy !== null}
          onClick={() => active && run('mezo', () => claimMezo(active, chainId))}
        >
          <span className="action-icon">{busy === 'mezo' ? <span className="spinner" /> : <IconSpark />}</span>
          <span className="action-title">{t('action.claimMezo')}</span>
          {/* The live counter above shows the amount; a second, slower number here would disagree with it. */}
          <span className="action-body">{t('action.claimMezo.body')}</span>
        </button>
        <button
          type="button"
          className="action"
          disabled={!active || !b || savings === 0n || busy !== null}
          onClick={() => active && b && run('cash', () => cashOut(active, chainId, b))}
        >
          <span className="action-icon">{busy === 'cash' ? <span className="spinner" /> : <IconReturn />}</span>
          <span className="action-title">{b && b.staked === 0n && b.smusd > 0n ? t('action.withdrawSavings') : t('action.cashOut')}</span>
          <span className="action-body">
            {b && b.staked === 0n && b.smusd > 0n ? t('action.withdrawSavings.body') : t('action.cashOut.body')}
          </span>
        </button>
        {active?.kind === 'burner' ? (
          <button type="button" className="action" onClick={() => setBackupOpen(true)}>
            <span className="action-icon">
              <IconKey />
            </span>
            <span className="action-title">{t('action.backup')}</span>
            <span className="action-body">{t('action.backup.body')}</span>
          </button>
        ) : null}
      </div>
      {noGas ? <Notice>{t('action.needGas')}</Notice> : null}
      <ErrorNotice error={error} />
      {ok ? <Notice kind="ok">{t('action.done')}</Notice> : null}
      <BackupSheet open={backupOpen} onClose={() => setBackupOpen(false)} />
    </div>
  );
}
