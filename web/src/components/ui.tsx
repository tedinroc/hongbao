import { useEffect, useRef, type ReactNode } from 'react';
import type { Address } from 'viem';
import { useI18n, type MessageKey } from '../i18n';
import { CHAIN_IDS, addressUrl, chainInfo, txUrl, type ChainId } from '../lib/chains';
import { errorCode, errorDetail } from '../lib/errors';
import { shortAddress } from '../lib/format';
import { isTeam } from '../lib/snapshot';
import { IconAlert, IconCheck, IconExternal, IconInfo } from './Icons';

export function Notice({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'warn' | 'error' | 'ok' | 'gold';
  children: ReactNode;
}) {
  const Icon = kind === 'warn' || kind === 'error' ? IconAlert : kind === 'ok' ? IconCheck : IconInfo;
  return (
    <div className={`notice ${kind === 'info' ? '' : `notice-${kind}`}`} role={kind === 'error' ? 'alert' : undefined}>
      <Icon />
      <div>{children}</div>
    </div>
  );
}

/** A friendly message for any thrown error, mapped from contract/relayer error names. */
export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (!error) return null;
  const code = errorCode(error);
  const detail = errorDetail(error);
  return (
    <Notice kind="error">
      {t(`err.${code}` as MessageKey)}
      {(code === 'Unknown' || code === 'LoanBlocked') && detail ? <div className="tiny mt-2 mono">{detail}</div> : null}
    </Notice>
  );
}

export interface StepDef {
  key: string;
  label: string;
}

export function Steps({ steps, current, done }: { steps: StepDef[]; current: string | null; done: boolean }) {
  const idx = current ? steps.findIndex((s) => s.key === current) : -1;
  return (
    <ol className="progress-steps" aria-live="polite">
      {steps.map((s, i) => {
        const state = done || i < idx ? 'done' : i === idx ? 'active' : '';
        return (
          <li key={s.key} className={state}>
            <span className="dot">{state === 'done' ? <IconCheck /> : state === 'active' ? <span className="spinner" /> : null}</span>
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet stack"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="section-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function AddressLink({
  chainId,
  address,
  showTag = false,
  you,
}: {
  chainId: ChainId;
  address: Address | string;
  showTag?: boolean;
  you?: boolean;
}) {
  const { t } = useI18n();
  const team = showTag && isTeam(address);
  return (
    <span className="addr">
      <a href={addressUrl(chainId, address)} target="_blank" rel="noreferrer noopener" title={address}>
        {shortAddress(address)}
      </a>
      {you ? <span className="tag tag-outside" style={{ marginLeft: 6 }}>{t('claim.you')}</span> : null}
      {showTag ? (
        <span className={`tag ${team ? 'tag-team' : 'tag-outside'}`} style={{ marginLeft: 6 }}>
          {team ? t('tag.team') : t('tag.outside')}
        </span>
      ) : null}
    </span>
  );
}

export function TxLink({ chainId, hash, label }: { chainId: ChainId; hash: string; label?: string }) {
  const { t } = useI18n();
  return (
    <a className="tx-link" href={txUrl(chainId, hash)} target="_blank" rel="noreferrer noopener">
      {label ?? t('common.viewTx')}
      <IconExternal style={{ width: 15, height: 15 }} />
    </a>
  );
}

/**
 * Network picker. `need` decides which chains are selectable: "enabled" (live for
 * new packets), "deployed" (Hongbao exists there) or "all" (balances only).
 */
export function ChainPicker({
  value,
  onChange,
  need = 'deployed',
}: {
  value: ChainId;
  onChange: (id: ChainId) => void;
  need?: 'enabled' | 'deployed' | 'all';
}) {
  const { t } = useI18n();
  const ids = [...CHAIN_IDS].reverse(); // testnet first visually, mainnet second
  const usable = (id: ChainId) => {
    const info = chainInfo(id);
    return need === 'enabled' ? info.enabled : need === 'deployed' ? Boolean(info.hongbao) : true;
  };
  // Only one network to pick: say which one it is instead of showing a switch with a dead half.
  if (ids.filter(usable).length === 1 && usable(value)) {
    return (
      <div className="net-static" role="group" aria-label={t('common.network')}>
        <span className="net-dot" aria-hidden />
        <b>{t(chainInfo(value).nameKey)}</b>
        {ids
          .filter((id) => id !== value)
          .map((id) => (
            <span key={id} className="net-other">
              {t('chain.otherNotLive', { chain: t(chainInfo(id).nameKey) })}
            </span>
          ))}
      </div>
    );
  }
  return (
    <div className="seg" role="group" aria-label={t('common.network')}>
      {ids.map((id) => {
        const info = chainInfo(id);
        const unavailable = need === 'enabled' ? !info.enabled : need === 'deployed' ? !info.hongbao : false;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={value === id}
            disabled={unavailable}
            onClick={() => onChange(id)}
            title={unavailable ? t('chain.notLive') : undefined}
          >
            {t(info.nameKey)}
            {unavailable ? <span className="tiny faint"> · {t('chain.notLive')}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="row muted small" role="status">
      <span className="spinner" />
      {label ?? t('common.loading')}
    </div>
  );
}
