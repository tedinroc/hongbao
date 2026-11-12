import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n, type MessageKey } from '../i18n';
import { IconRefresh } from '../components/Icons';
import { AddressLink, ChainPicker, ErrorNotice, Loading, Notice, TxLink } from '../components/ui';
import { getConfig, getStatsApi, type RecentEvent } from '../lib/api';
import { chainInfo, defaultChainId, type ChainId } from '../lib/chains';
import {
  blockTimestamps,
  loadFollowUps,
  loadHongbaoEvents,
  type FollowUp,
  type HongbaoEvents,
} from '../lib/chainData';
import { cleanMessage, fmtMusd, formatDateTime } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { addTeamAddress, isTeam } from '../lib/snapshot';

interface LedgerData {
  ev: HongbaoEvents;
  follow: FollowUp[];
  times: Map<bigint, number>;
}

type Tab = 'packets' | 'claims' | 'follow';
const PAGE = 100;

const PAYOUT_KEY: Record<number, MessageKey> = { 0: 'payout.stake', 1: 'payout.save', 2: 'payout.cash' };

export function Ledger() {
  const { t, lang } = useI18n();
  const [chainId, setChainId] = useState<ChainId>(defaultChainId);
  const info = chainInfo(chainId);
  const [progress, setProgress] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('packets');
  const [limit, setLimit] = useState(PAGE);

  const data = useAsync<LedgerData>(
    async () => {
      try {
        const cfg = await getConfig();
        const c = cfg.chains[String(chainId)];
        addTeamAddress(c?.relayer, 'relayer');
        addTeamAddress(c?.attester, 'attester');
      } catch {
        /* the static team list still applies */
      }
      const ev = await loadHongbaoEvents(chainId, (d, n) => setProgress(t('me.scan', { done: d, total: n })));
      const follow = await loadFollowUps(chainId, ev, (a) => !isTeam(a), (d, n) =>
        setProgress(t('me.scan', { done: d, total: n })),
      );
      const recentBlocks = [
        ...ev.created.map((e) => e.blockNumber),
        ...ev.claimed.map((e) => e.blockNumber),
        ...follow.map((f) => f.blockNumber),
      ]
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
        .slice(0, 150);
      const times = await blockTimestamps(chainId, recentBlocks, 150);
      setProgress(null);
      return { ev, follow, times };
    },
    [chainId],
    Boolean(info.hongbao),
  );

  // If the RPC is unreachable, show the API's recent events instead.
  const apiFallback = useAsync<RecentEvent[]>(
    async () => (await getStatsApi(chainId)).recent,
    [chainId, Boolean(data.error)],
    Boolean(info.hongbao && data.error),
  );

  const counts = useMemo(() => {
    if (!data.data) return null;
    const { ev, follow } = data.data;
    const senders = new Set(ev.created.filter((e) => !isTeam(e.sender)).map((e) => e.sender.toLowerCase()));
    const claimers = new Set(ev.claimed.filter((e) => !isTeam(e.recipient)).map((e) => e.recipient.toLowerCase()));
    return { senders: senders.size, claimers: claimers.size, follow: follow.length };
  }, [data.data]);

  const when = (block: bigint) => {
    const ts = data.data?.times.get(block);
    return ts ? formatDateTime(ts * 1000, lang) : `#${block.toString()}`;
  };

  const created = data.data ? [...data.data.ev.created].reverse() : [];
  const claimed = data.data ? [...data.data.ev.claimed].reverse() : [];
  const refundedIds = new Set(data.data?.ev.refunded.map((r) => r.id.toString()) ?? []);
  const openedById = new Map<string, number>();
  for (const c of claimed) openedById.set(c.id.toString(), (openedById.get(c.id.toString()) ?? 0) + 1);
  const follow = data.data?.follow ?? [];

  return (
    <div className="stack-lg">
      <header>
        <div className="eyebrow">{t(info.nameKey)}</div>
        <h1 className="page-title">{t('ledger.title')}</h1>
        <p className="page-lead">{t('ledger.lead')}</p>
      </header>

      <div style={{ maxWidth: 420 }}>
        <ChainPicker value={chainId} onChange={setChainId} />
      </div>

      {!info.hongbao ? (
        <div className="empty">{t('ledger.notDeployed')}</div>
      ) : (
        <>
          <section className="ledger-counts" aria-label={t('ledger.title')}>
            <div className="ledger-count">
              <div className="n">{counts ? counts.senders : <span className="skeleton" />}</div>
              <div className="l">{t('ledger.outsideSenders')}</div>
            </div>
            <div className="ledger-count">
              <div className="n">{counts ? counts.claimers : <span className="skeleton" />}</div>
              <div className="l">{t('ledger.outsideClaimers')}</div>
            </div>
            <div className="ledger-count">
              <div className="n">{counts ? counts.follow : <span className="skeleton" />}</div>
              <div className="l">{t('ledger.followUps')}</div>
            </div>
          </section>
          <p className="hint">{t('ledger.followUpsHint')}</p>

          {data.loading ? <Loading label={progress ?? undefined} /> : null}

          {data.error ? (
            <div className="stack">
              <ErrorNotice error={data.error} />
              {apiFallback.data ? (
                <>
                  <Notice>{t('ledger.apiOnly')}</Notice>
                  <ul className="list">
                    {apiFallback.data.map((e, i) => (
                      <li key={`${e.txHash ?? i}-${i}`} className="list-item">
                        <div className="row-between">
                          <b>{t(`stats.recent.${e.kind}` as MessageKey, { id: e.id.toString() })}</b>
                          <span className="mono">{e.amount > 0n ? `${fmtMusd(e.amount)} MUSD` : ''}</span>
                        </div>
                        <div className="row-between small">
                          {e.address ? <AddressLink chainId={chainId} address={e.address} showTag /> : <span />}
                          {e.txHash ? <TxLink chainId={chainId} hash={e.txHash} /> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <button type="button" className="btn btn-ghost" onClick={data.reload}>
                <IconRefresh />
                {t('common.retry')}
              </button>
            </div>
          ) : null}

          {data.data ? (
            <section className="stack">
              <div className="tabs" role="tablist">
                  {(
                    [
                      ['packets', t('ledger.packets'), created.length],
                      ['claims', t('ledger.claims'), claimed.length],
                      ['follow', t('ledger.followList'), follow.length],
                    ] as [Tab, string, number][]
                  ).map(([k, label, n]) => (
                    <button
                      key={k}
                      type="button"
                      role="tab"
                      aria-selected={tab === k}
                      onClick={() => {
                        setTab(k);
                        setLimit(PAGE);
                      }}
                    >
                      {label} <span className="mono">{n}</span>
                    </button>
                  ))}
              </div>

              {tab === 'packets' ? (
                created.length ? (
                  <ul className="list">
                    {created.slice(0, limit).map((e) => (
                      <li key={e.id.toString()} className="list-item">
                        <div className="row-between">
                          <b>
                            <Link to={`/c/${chainId}/${e.id.toString()}`}>
                              {t('ledger.packetRow', { id: e.id.toString(), shares: e.shares })}
                            </Link>
                          </b>
                          <span className="mono">{fmtMusd(e.net)} MUSD</span>
                        </div>
                        <div className="ledger-msg">{t('common.quote', { text: cleanMessage(e.message) })}</div>
                        <div className="small muted">
                          {t('me.opened', { opened: openedById.get(e.id.toString()) ?? 0, total: e.shares })} ·{' '}
                          {t('ledger.paidWith', { asset: e.funding === 1 ? 'BTC' : 'MUSD' })}
                          {refundedIds.has(e.id.toString()) ? ` · ${t('me.status.refunded')}` : ''}
                        </div>
                        <div className="row-between small wrap">
                          <AddressLink chainId={chainId} address={e.sender} showTag />
                          <span className="faint">{when(e.blockNumber)}</span>
                          <TxLink chainId={chainId} hash={e.txHash} />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="empty">{t('ledger.empty')}</div>
                )
              ) : null}

              {tab === 'claims' ? (
                claimed.length ? (
                  <ul className="list">
                    {claimed.slice(0, limit).map((e) => (
                      <li key={`${e.txHash}-${e.logIndex}`} className="list-item">
                        <div className="row-between">
                          <b>
                            <Link to={`/c/${chainId}/${e.id.toString()}`}>{t('ledger.claimRow', { id: e.id.toString() })}</Link>
                          </b>
                          <span className="mono">{fmtMusd(e.amount)} MUSD</span>
                        </div>
                        <div className="small muted">{t(PAYOUT_KEY[e.payout] ?? 'payout.save')}</div>
                        <div className="row-between small wrap">
                          <AddressLink chainId={chainId} address={e.recipient} showTag />
                          <span className="faint">{when(e.blockNumber)}</span>
                          <TxLink chainId={chainId} hash={e.txHash} />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="empty">{t('ledger.empty')}</div>
                )
              ) : null}

              {tab === 'follow' ? (
                follow.length ? (
                  <ul className="list">
                    {follow.slice(0, limit).map((f) => (
                      <li key={f.txHash} className="list-item">
                        <div className="row-between">
                          <b>{t(`ledger.follow.${f.kind}` as MessageKey, { id: f.packetId?.toString() ?? '' })}</b>
                          <span className="faint small">{when(f.blockNumber)}</span>
                        </div>
                        <div className="row-between small wrap">
                          <AddressLink chainId={chainId} address={f.who} showTag />
                          <TxLink chainId={chainId} hash={f.txHash} />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="empty">{t('ledger.empty')}</div>
                )
              ) : null}

              {(tab === 'packets' ? created.length : tab === 'claims' ? claimed.length : follow.length) > limit ? (
                <button type="button" className="btn btn-ghost" onClick={() => setLimit((l) => l + PAGE)}>
                  +{PAGE}
                </button>
              ) : null}

              <div className="ledger-foot">
                <p className="hint">
                  {t('ledger.source', {
                    from: data.data.ev.fromBlock.toString(),
                    to: data.data.ev.toBlock.toString(),
                  })}
                </p>
                <button type="button" className="btn btn-ghost btn-sm" onClick={data.reload}>
                  <IconRefresh />
                  {t('ledger.refresh')}
                </button>
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
