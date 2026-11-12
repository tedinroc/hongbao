import { useEffect, useState, type ComponentType, type SVGProps } from 'react';
import { Link } from 'react-router-dom';
import type { Address } from 'viem';
import { useI18n, type MessageKey } from '../i18n';
import { Envelope } from '../components/Envelope';
import {
  IconArrowRight,
  IconCoin,
  IconExternal,
  IconGauge,
  IconLedger,
  IconShield,
  IconSpark,
  IconSwap,
  IconVault,
  IconEnvelope,
} from '../components/Icons';
import { getStatsApi, type StatsPayload } from '../lib/api';
import { addressUrl, chainInfo, defaultChainId } from '../lib/chains';
import { readFeeBps, readStatsChain } from '../lib/chainData';
import { fmtMusd, formatAmount, formatDateTime, pct, shortAddress } from '../lib/format';
import { snapshotFor } from '../lib/snapshot';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

function count(n: bigint): string {
  return formatAmount(n * 10n ** 18n, 0);
}

export function Landing() {
  const { t, lang } = useI18n();
  const chainId = defaultChainId();
  const info = chainInfo(chainId);
  const [payload, setPayload] = useState<StatsPayload>(() => snapshotFor(chainId));
  const [source, setSource] = useState<'snapshot' | 'live'>('snapshot');
  const [fee, setFee] = useState<bigint>(100n);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const p = await getStatsApi(chainId);
        if (live) {
          setPayload({ ...p, updatedAt: p.updatedAt ?? Date.now() });
          setSource('live');
        }
        return;
      } catch {
        /* fall back to a direct chain read */
      }
      if (!info.hongbao) return;
      try {
        const s = await readStatsChain(chainId);
        if (live) {
          setPayload((prev) => ({ stats: s, recent: prev.recent, updatedAt: Date.now() }));
          setSource('live');
        }
      } catch {
        /* keep the snapshot */
      }
    })();
    if (info.hongbao) {
      readFeeBps(chainId)
        .then((f) => live && setFee(f))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [chainId, info.hongbao]);

  const s = payload.stats;
  const a = info.addresses;
  const contracts: { key: string; name: MessageKey; body: MessageKey; address: Address | null; icon: Icon }[] = [
    { key: 'smusd', name: 'contracts.smusd', body: 'contracts.smusd.body', address: a.smusd, icon: IconVault },
    { key: 'gauge', name: 'contracts.gauge', body: 'contracts.gauge.body', address: a.gauge, icon: IconGauge },
    { key: 'router', name: 'contracts.router', body: 'contracts.router.body', address: a.router, icon: IconSwap },
    { key: 'feed', name: 'contracts.priceFeed', body: 'contracts.priceFeed.body', address: a.priceFeed, icon: IconShield },
    { key: 'musd', name: 'contracts.musd', body: 'contracts.musd.body', address: a.musd, icon: IconCoin },
    { key: 'hb', name: 'contracts.hongbao', body: 'contracts.hongbao.body', address: info.hongbao, icon: IconEnvelope },
  ];

  return (
    <div className="stack-lg">
      <section className="hero">
        <div>
          <div className="eyebrow">{t('landing.eyebrow')}</div>
          <h1 className="hero-title">
            {t('landing.title1')}
            <span className="accent">{t('landing.title2')}</span>
          </h1>
          <p className="hero-lead">{t('landing.lead')}</p>
          <div className="hero-ctas">
            <Link to="/send" className="btn btn-primary btn-lg">
              <IconEnvelope />
              {t('landing.ctaSend')}
            </Link>
            <Link to="/ledger" className="btn btn-ghost btn-lg">
              <IconLedger />
              {t('landing.ctaLedger')}
            </Link>
          </div>
          <ul className="hero-facts">
            <li>
              <IconShield />
              {t('landing.fact1')}
            </li>
            <li>
              <IconShield />
              {t('landing.fact2')}
            </li>
            <li>
              <IconShield />
              {t('landing.fact3', { pct: pct(fee) })}
            </li>
          </ul>
        </div>
        <div className="hero-visual" aria-hidden>
          <Envelope
            state="peek"
            message={t('landing.cardMessage')}
            sub={t('landing.cardShares')}
            letter={
              <>
                <div className="env-letter-label">{t('payout.stake')}</div>
                <div className="env-letter-amount">1.10</div>
                <div className="env-letter-unit">MUSD</div>
              </>
            }
          />
          <div className="float-chip">
            <span className="row" style={{ gap: 6 }}>
              <IconSpark width={16} height={16} />
              <b>MEZO</b>
            </span>
            {t('bal.staked')}
          </div>
        </div>
      </section>

      <section aria-labelledby="stats-title">
        <div className="row-between" style={{ marginBottom: 12 }}>
          <h2 id="stats-title" className="section-title">
            {t('stats.title')}
          </h2>
          <span className="chip">{t(info.nameKey)}</span>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="stat-value">{count(s.packets)}</div>
            <div className="stat-label">{t('stats.packets')}</div>
          </div>
          <div className="stat">
            <div className="stat-value">{count(s.claims)}</div>
            <div className="stat-label">{t('stats.claims')}</div>
          </div>
          <div className="stat">
            <div className="stat-value">{count(s.recipients)}</div>
            <div className="stat-label">{t('stats.recipients')}</div>
          </div>
          <div className="stat">
            <div className="stat-value">{fmtMusd(s.volume)}</div>
            <div className="stat-label">{t('stats.volume')}</div>
          </div>
          <div className="stat stat-wide">
            <div className="stat-value">{fmtMusd(s.open)}</div>
            <div className="stat-label">{t('stats.open')}</div>
          </div>
        </div>
        <div className="stats-meta">
          {source === 'live' ? (
            <>
              <span className="live-dot" />
              {t('stats.live')}
              {payload.updatedAt ? <span>· {t('stats.asOf', { time: formatDateTime(payload.updatedAt, lang) })}</span> : null}
            </>
          ) : info.hongbao ? (
            <>
              {t('stats.snapshot')}
              {payload.updatedAt ? <span>· {t('stats.asOf', { time: formatDateTime(payload.updatedAt, lang) })}</span> : null}
            </>
          ) : (
            <span>{t('stats.notLive')}</span>
          )}
          {info.testnet ? <span>· {t('chain.testnetNote')}</span> : null}
        </div>
        {payload.recent.length ? (
          <div className="card mt-4">
            <h3 className="small eyebrow" style={{ marginBottom: 6 }}>
              {t('stats.recent')}
            </h3>
            <ul className="activity">
              {payload.recent.slice(0, 6).map((e, i) => (
                <li key={`${e.txHash ?? i}-${e.kind}-${i}`}>
                  <span>
                    {t(`stats.recent.${e.kind}` as MessageKey, { id: e.id.toString() })}
                    {e.address ? <span className="faint mono tiny"> · {shortAddress(e.address)}</span> : null}
                  </span>
                  <span className="mono">{e.amount > 0n ? `${fmtMusd(e.amount)} MUSD` : ''}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="how-title">
        <h2 id="how-title" className="section-title" style={{ marginBottom: 12 }}>
          {t('how.title')}
        </h2>
        <div className="steps-grid">
          {(['1', '2', '3'] as const).map((n) => (
            <div className="step-card" key={n}>
              <div className="step-num">{n}</div>
              <h3>{t(`how.${n}.title` as MessageKey)}</h3>
              <p>{t(`how.${n}.body` as MessageKey)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="band" aria-labelledby="gas-title">
        <h2 id="gas-title">{t('gas.title')}</h2>
        <p>{t('gas.body')}</p>
      </section>

      <section aria-labelledby="contracts-title">
        <h2 id="contracts-title" className="section-title">
          {t('contracts.title')}
        </h2>
        <p className="page-lead" style={{ marginBottom: 12 }}>
          {t('contracts.lead', { chain: t(info.nameKey) })}
        </p>
        <div className="contract-list">
          {contracts.map((c) =>
            c.address ? (
              <a
                key={c.key}
                className="contract"
                href={addressUrl(chainId, c.address)}
                target="_blank"
                rel="noreferrer noopener"
              >
                <span className="contract-icon">
                  <c.icon />
                </span>
                <span className="contract-main">
                  <span className="contract-name">{t(c.name)}</span>
                  <span className="contract-body" style={{ display: 'block' }}>
                    {t(c.body)}
                  </span>
                  <span className="contract-addr">{shortAddress(c.address)}</span>
                </span>
                <IconExternal />
              </a>
            ) : (
              <div key={c.key} className="contract">
                <span className="contract-icon">
                  <c.icon />
                </span>
                <span className="contract-main">
                  <span className="contract-name">{t(c.name)}</span>
                  <span className="contract-body" style={{ display: 'block' }}>
                    {t('contracts.hongbao.pending')}
                  </span>
                </span>
              </div>
            ),
          )}
        </div>
      </section>

      <section className="card center stack" style={{ padding: '28px 20px' }}>
        <h2 className="section-title">{t('send.title')}</h2>
        <p className="muted">{t('send.lead')}</p>
        <div className="row wrap" style={{ justifyContent: 'center' }}>
          <Link to="/send" className="btn btn-primary btn-lg">
            {t('landing.ctaSend')}
            <IconArrowRight />
          </Link>
        </div>
      </section>
    </div>
  );
}
