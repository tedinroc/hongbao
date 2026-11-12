import { useI18n } from '../i18n';
import { fmtBtc, fmtMusd, pct } from '../lib/format';
import { FLOOR_MIN_PCT, fmtRatio, type BorrowPlan, type Loan } from '../lib/trove';
import { IconMinus, IconPlus } from './Icons';
import { Loading } from './ui';

const FLOOR_MAX_PCT = 1000;

/**
 * "Fund from my Mezo loan": the sender's loan before and after borrowing what the
 * packet still needs, plus the ratio floor they accept. Reasons to refuse are shown
 * next to the Send button.
 */
export function LoanPanel({
  loan,
  loading,
  plan,
  borrow,
  floorPct,
  onFloorPct,
}: {
  loan: Loan | null | undefined;
  loading: boolean;
  plan: BorrowPlan | null;
  /** MUSD the packet still needs beyond the wallet's own MUSD. */
  borrow: bigint;
  floorPct: number;
  onFloorPct: (pct: number) => void;
}) {
  const { t } = useI18n();
  if (loan === undefined) return loading ? <Loading /> : null;
  if (loan === null) return null;
  const setFloor = (n: number) => onFloorPct(Math.min(FLOOR_MAX_PCT, Math.max(FLOOR_MIN_PCT, Math.round(n))));
  return (
    <section className="card stack">
      <h2 className="section-title">{t('loan.title')}</h2>
      <dl className="kv">
        {plan ? (
          <>
            <div>
              <dt>{t('loan.borrow')}</dt>
              <dd>{fmtMusd(plan.amount)} MUSD</dd>
            </div>
            <div>
              <dt>{t('loan.fee')}</dt>
              <dd>{fmtMusd(plan.fee)} MUSD</dd>
            </div>
            <div>
              <dt>{t('loan.debt')}</dt>
              <dd>
                {fmtMusd(plan.debtBefore)} → {fmtMusd(plan.debtAfter)} MUSD
              </dd>
            </div>
          </>
        ) : (
          <div>
            <dt>{t('loan.debt')}</dt>
            <dd>{fmtMusd(loan.debt)} MUSD</dd>
          </div>
        )}
        <div>
          <dt>{t('loan.coll')}</dt>
          <dd>{fmtBtc(loan.coll)} BTC</dd>
        </div>
        <div>
          <dt>{t('loan.icr')}</dt>
          <dd>
            {loan.icr !== null ? fmtRatio(loan.icr) : '—'}
            {plan && plan.icrAfter !== null ? ` → ${fmtRatio(plan.icrAfter)}` : ''}
          </dd>
        </div>
        {plan ? (
          <>
            <div>
              <dt>{t('loan.liq')}</dt>
              <dd>{t('loan.liqValue', { price: fmtMusd(plan.liquidationPriceAfter) })}</dd>
            </div>
            <div>
              <dt>{t('loan.room')}</dt>
              <dd>{fmtMusd(plan.roomAfter)} MUSD</dd>
            </div>
          </>
        ) : null}
      </dl>
      {loan.price !== null ? <span className="hint mono">{t('loan.price', { price: fmtMusd(loan.price) })}</span> : null}
      {borrow === 0n ? <p className="hint">{t('loan.enough')}</p> : null}

      <div className="field">
        <span className="label">{t('loan.floor')}</span>
        <div className="row" style={{ gap: 10 }}>
          <div className="stepper">
            <button type="button" aria-label={t('loan.floorDown')} onClick={() => setFloor(floorPct - 10)}>
              <IconMinus />
            </button>
            <input
              inputMode="numeric"
              aria-label={t('loan.floor')}
              value={floorPct}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ''));
                onFloorPct(Number.isFinite(n) ? Math.min(FLOOR_MAX_PCT, n) : FLOOR_MIN_PCT);
              }}
              onBlur={() => setFloor(floorPct)}
            />
            <button type="button" aria-label={t('loan.floorUp')} onClick={() => setFloor(floorPct + 10)}>
              <IconPlus />
            </button>
          </div>
          <span className="mono">%</span>
        </div>
        <span className="hint">{t('loan.floorHint', { mcr: fmtRatio(loan.mcr) })}</span>
      </div>

      <p className="hint">{t('loan.explain', { rate: pct(loan.interestRateBps) })}</p>
    </section>
  );
}
