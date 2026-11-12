import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatUnits, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { useI18n, type MessageKey } from '../i18n';
import { Envelope } from '../components/Envelope';
import { IconCopy, IconEnvelope, IconExternal, IconMinus, IconPlus, IconShare } from '../components/Icons';
import { Qr } from '../components/Qr';
import { ErrorNotice, Notice, Steps, TxLink, ChainPicker, type StepDef } from '../components/ui';
import { WalletPicker, WalletSummary } from '../components/WalletPanel';
import { createPacket, prepareMusd, prepareTxCount } from '../lib/actions';
import { getConfig } from '../lib/api';
import { chainInfo, defaultChainId, parseChainId, publicClient, type ChainId } from '../lib/chains';
import { readBalances, readBtcPrice, readPoolQuote, readSendContext } from '../lib/chainData';
import { packetLink } from '../lib/eip712';
import { fmtBtc, fmtMusd, parseAmountInput, pct, utf8Bytes } from '../lib/format';
import { useAsync, useCopy } from '../lib/hooks';
import { useWallet } from '../lib/walletContext';

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const DRIP = 3_000_000_000_000n; // 0.000003 BTC
const TIP = 1_000_000_000_000n; // 0.000001 BTC
const MIN_SHARE = 10n ** 16n; // 0.01 MUSD
const SLIPPAGE_BPS = 150;
const EXPIRY = { '1h': 3600, '24h': 86400, '3d': 3 * 86400, '7d': 7 * 86400 } as const;
type ExpiryKey = keyof typeof EXPIRY;

interface Done {
  chainId: ChainId;
  id: bigint;
  txHash: Hex;
  link: string;
  message: string;
  shares: number;
  net: bigint;
}

export function Send() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const passOn = params.get('passOn') === '1';
  const [chainId, setChainId] = useState<ChainId>(() => {
    const q = parseChainId(params.get('chain'));
    return q && chainInfo(q).enabled ? q : defaultChainId();
  });
  const info = chainInfo(chainId);
  const { active } = useWallet();
  const [pickerOpen, setPickerOpen] = useState(false);

  const [funding, setFunding] = useState<'musd' | 'btc'>('musd');
  const [amountStr, setAmountStr] = useState(() => {
    const q = params.get('amount');
    if (q && /^\d+$/.test(q)) {
      const half = BigInt(q) / 2n;
      return half >= MIN_SHARE ? Number(formatUnits(half, 18)).toFixed(2) : '';
    }
    return passOn ? '' : '8.88';
  });
  const [shares, setShares] = useState(passOn ? 3 : 8);
  const [messageTouched, setMessageTouched] = useState(false);
  const [message, setMessage] = useState('');
  const [expiry, setExpiry] = useState<ExpiryKey>('24h');
  const [onePer, setOnePer] = useState(true);

  const shownMessage = messageTouched ? message : t('send.messageDefault');

  const ctx = useAsync(() => readSendContext(chainId), [chainId], Boolean(info.hongbao));
  const bal = useAsync(
    () => readBalances(chainId, active!.address),
    [chainId, active?.address],
    Boolean(active),
  );
  const cfg = useAsync(() => getConfig(), []);
  const gas = useAsync(() => publicClient(chainId).getGasPrice(), [chainId]);
  const price = useAsync(() => readBtcPrice(chainId), [chainId], funding === 'btc');

  const amount = parseAmountInput(amountStr);
  const feeBps = ctx.data?.feeBps ?? 100n;

  // BTC funding: size btcIn so the pool returns about `amount` MUSD.
  const [btcPlan, setBtcPlan] = useState<{ btcIn: bigint; quote: bigint } | null>(null);
  const [quoting, setQuoting] = useState(false);
  useEffect(() => {
    setBtcPlan(null);
    if (funding !== 'btc' || !amount || !price.data) return;
    let live = true;
    setQuoting(true);
    const timer = setTimeout(async () => {
      const p = price.data!;
      const guess = (amount * 10n ** 18n + p - 1n) / p;
      const q0 = await readPoolQuote(chainId, guess);
      let btcIn = guess;
      if (q0 && q0 > 0n) btcIn = (guess * amount + q0 - 1n) / q0;
      const q1 = await readPoolQuote(chainId, btcIn);
      if (live) {
        setBtcPlan(q1 ? { btcIn, quote: q1 } : null);
        setQuoting(false);
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
      setQuoting(false);
    };
  }, [funding, amount, price.data, chainId]);

  const gross = funding === 'btc' ? btcPlan?.quote ?? null : amount;
  const fee = gross !== null ? (gross * feeBps) / 10_000n : null;
  const net = gross !== null && fee !== null ? gross - fee : null;
  const each = net !== null && shares > 0 ? net / BigInt(shares) : null;

  const btcIn = funding === 'btc' ? btcPlan?.btcIn ?? 0n : 0n;
  const gasReserve = (gas.data ?? 2_000_000n) * 3_000_000n;
  const fullKits = BigInt(shares) * (DRIP + TIP);
  const btcBal = bal.data?.btc ?? null;
  const dropKits = btcBal !== null && btcBal < fullKits + btcIn + gasReserve && btcBal >= btcIn + gasReserve / 2n;
  const drip = dropKits ? 0n : DRIP;
  const tip = dropKits ? 0n : TIP;
  const kits = BigInt(shares) * (drip + tip);

  const attesterCfg = cfg.data?.chains[String(chainId)]?.attester ?? null;
  const attester = onePer && attesterCfg ? attesterCfg : ZERO;

  const spendable = bal.data ? bal.data.musd + bal.data.smusd + bal.data.staked : null;
  const prepCount = funding === 'musd' && amount && bal.data ? prepareTxCount(amount, bal.data) : 0;
  const msgBytes = utf8Bytes(shownMessage);

  const oracleMin =
    funding === 'btc' && price.data && btcIn > 0n ? ((btcIn * price.data) / 10n ** 18n) * BigInt(10_000 - SLIPPAGE_BPS) / 10_000n : null;
  const poolLow = oracleMin !== null && btcPlan !== null && btcPlan.quote < oracleMin;

  const invalid: MessageKey | null = useMemo(() => {
    if (!info.enabled) return 'send.notLive';
    if (ctx.data?.paused) return 'send.paused';
    if (!amount || amount <= 0n) return 'send.invalid.amount';
    if (shares < 1 || shares > 100) return 'send.invalid.shares';
    if (msgBytes > 200) return 'send.invalid.message';
    if (funding === 'btc' && price.data === null) return 'send.quote.unavailable';
    if (net !== null && net / BigInt(shares) < MIN_SHARE) return 'send.invalid.min';
    if (net !== null && ctx.data && net > ctx.data.maxPerPacket) return 'send.invalid.cap';
    if (funding === 'musd' && spendable !== null && amount > spendable) return 'send.invalid.balance';
    if (btcBal !== null && btcBal < btcIn + kits) return 'send.invalid.btc';
    return null;
  }, [info.enabled, ctx.data, amount, shares, msgBytes, funding, price.data, net, spendable, btcBal, btcIn, kits]);

  /* ---------------------------------------------------------------- submit */

  const keyRef = useRef<Hex | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [seen, setSeen] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<Done | null>(null);

  const onSubmit = async () => {
    if (!active || invalid || !amount || busy) return;
    if (funding === 'btc' && (!btcPlan || poolLow)) return;
    setBusy(true);
    setError(null);
    setSeen([]);
    const report = (s: string) => {
      setStep(s);
      setSeen((prev) => (prev.includes(s) ? prev : [...prev, s]));
    };
    try {
      if (!keyRef.current) keyRef.current = generatePrivateKey();
      const linkKey = keyRef.current;
      const claimKey = privateKeyToAccount(linkKey).address;
      if (funding === 'musd' && bal.data && prepCount > 0) await prepareMusd(active, chainId, amount, bal.data, report);
      const created = await createPacket(
        active,
        chainId,
        funding === 'musd'
          ? { kind: 'musd', amount }
          : {
              kind: 'btc',
              btcIn: btcPlan!.btcIn,
              minMusdOut: (btcPlan!.quote * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n,
              maxSlippageBps: SLIPPAGE_BPS,
            },
        {
          shares,
          expiry: BigInt(Math.floor(Date.now() / 1000) + EXPIRY[expiry]),
          claimKey,
          attester,
          dripPerShare: drip,
          tipPerShare: tip,
          message: shownMessage,
        },
        report,
      );
      setDone({
        chainId,
        id: created.id,
        txHash: created.txHash,
        link: packetLink(window.location.origin, chainId, created.id, linkKey),
        message: shownMessage,
        shares,
        net: created.net,
      });
      keyRef.current = null;
      window.scrollTo(0, 0);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setStep(null);
      bal.reload();
    }
  };

  if (done) return <SendDone done={done} onAgain={() => setDone(null)} />;

  const stepDefs: StepDef[] = [
    ...(seen.includes('prepare') || prepCount > 0 ? [{ key: 'prepare', label: t('send.step.prepare') }] : []),
    ...(funding === 'musd'
      ? seen.includes('approve')
        ? [{ key: 'approve', label: t('send.step.approve') }]
        : seen.includes('permit') || !seen.length
          ? [{ key: 'permit', label: t('send.step.permit') }]
          : []
      : []),
    { key: 'create', label: t('send.step.create') },
  ];

  const balLine = bal.data
    ? `${fmtBtc(bal.data.btc)} BTC · ${fmtMusd(bal.data.musd)} MUSD`
    : null;

  return (
    <div className="stack-lg">
      <header>
        <div className="eyebrow">{passOn ? t('send.passOn.title') : t('brand.tagline')}</div>
        <h1 className="page-title">{passOn ? t('send.passOn.title') : t('send.title')}</h1>
        <p className="page-lead">{passOn ? t('send.passOn.lead') : t('send.lead')}</p>
      </header>

      <section className="field">
        <span className="label">{t('send.network')}</span>
        <ChainPicker value={chainId} onChange={setChainId} need="enabled" />
        {info.testnet ? <span className="hint">{t('chain.testnetNote')}</span> : null}
      </section>

      <section className="card stack">
        <span className="label">{t('send.wallet')}</span>
        <WalletSummary onPick={() => setPickerOpen(true)} />
        {balLine ? <div className="hint mono">{t('send.balance', { amount: balLine })}</div> : null}
        {bal.data && bal.data.smusd + bal.data.staked > 0n ? (
          <div className="hint">{t('send.spendable', { amount: fmtMusd(spendable ?? 0n) })}</div>
        ) : null}
      </section>

      <section className="field">
        <span className="label">{t('send.fundWith')}</span>
        <div className="seg" role="group" aria-label={t('send.fundWith')}>
          <button type="button" aria-pressed={funding === 'musd'} onClick={() => setFunding('musd')}>
            MUSD
          </button>
          <button type="button" aria-pressed={funding === 'btc'} onClick={() => setFunding('btc')} disabled={passOn}>
            BTC
          </button>
        </div>
      </section>

      <section className="field">
        <label className="label" htmlFor="amount">
          {t('send.amount')}
        </label>
        <div className="input-amount">
          <input
            id="amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
          />
          <span className="unit">MUSD</span>
        </div>
        <div className="chips">
          {['1.68', '8.88', '16.8', '66'].map((v) => (
            <button key={v} type="button" aria-pressed={amountStr === v} onClick={() => setAmountStr(v)}>
              {v}
            </button>
          ))}
        </div>
        {funding === 'btc' ? (
          <div className="stack-sm">
            {price.loading ? null : price.data ? (
              <span className="hint mono">{t('send.quote.oracle', { price: fmtMusd(price.data) })}</span>
            ) : (
              <Notice kind="warn">{t('send.quote.unavailable')}</Notice>
            )}
            {btcPlan ? (
              <span className="hint mono">
                {t('send.quote.pool', { btc: fmtBtc(btcPlan.btcIn), musd: fmtMusd(btcPlan.quote) })}
              </span>
            ) : quoting ? (
              <span className="hint">{t('common.loading')}</span>
            ) : null}
            {poolLow ? <Notice kind="warn">{t('send.quote.poolLow')}</Notice> : <span className="hint">{t('send.slippage')}</span>}
          </div>
        ) : null}
      </section>

      <section className="field">
        <span className="label">{t('send.shares')}</span>
        <div className="row-between">
          <div className="stepper">
            <button type="button" aria-label="−" onClick={() => setShares((n) => Math.max(1, n - 1))}>
              <IconMinus />
            </button>
            <input
              inputMode="numeric"
              aria-label={t('send.shares')}
              value={shares}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ''));
                setShares(Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 1);
              }}
            />
            <button type="button" aria-label="+" onClick={() => setShares((n) => Math.min(100, n + 1))}>
              <IconPlus />
            </button>
          </div>
          <span className="hint">{t('send.sharesHint')}</span>
        </div>
      </section>

      <section className="field">
        <label className="label" htmlFor="msg">
          {t('send.message')}
        </label>
        <textarea
          id="msg"
          className="textarea"
          rows={2}
          value={shownMessage}
          onChange={(e) => {
            setMessageTouched(true);
            setMessage(e.target.value);
          }}
        />
        <span className={`hint ${msgBytes > 200 ? 'notice-error' : ''}`}>{t('send.bytes', { n: msgBytes })}</span>
      </section>

      <section className="field">
        <span className="label">{t('send.expiry')}</span>
        <div className="chips">
          {(Object.keys(EXPIRY) as ExpiryKey[]).map((k) => (
            <button key={k} type="button" aria-pressed={expiry === k} onClick={() => setExpiry(k)}>
              {t(`send.expiry.${k}` as MessageKey)}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <label className="switch-row">
          <input
            type="checkbox"
            className="switch-input sr-only"
            checked={onePer}
            onChange={(e) => setOnePer(e.target.checked)}
          />
          <span className="switch" aria-hidden />
          <span className="stack-sm" style={{ gap: 4 }}>
            <span className="option-title">
              {t('send.onePer')}
              <span className="chip chip-gold">{t('send.onePerTag')}</span>
            </span>
            <span className="option-body">
              {onePer ? (cfg.error && !attesterCfg ? t('send.onePerUnavailable') : t('send.onePerOn')) : t('send.onePerOff')}
            </span>
          </span>
        </label>
      </section>

      <section className="card stack">
        <h2 className="section-title">{t('send.summary')}</h2>
        <dl className="kv">
          {funding === 'btc' ? (
            <div>
              <dt>{t('send.sum.btcSwap')}</dt>
              <dd>{btcPlan ? `${fmtBtc(btcPlan.btcIn)} BTC` : '—'}</dd>
            </div>
          ) : null}
          <div>
            <dt>{t('send.sum.gross')}</dt>
            <dd>{gross !== null ? `${funding === 'btc' ? '≈ ' : ''}${fmtMusd(gross)} MUSD` : '—'}</dd>
          </div>
          <div>
            <dt>{t('send.sum.fee', { pct: pct(feeBps) })}</dt>
            <dd>{fee !== null ? `− ${fmtMusd(fee)} MUSD` : '—'}</dd>
          </div>
          <div>
            <dt>{t('send.sum.net')}</dt>
            <dd>{net !== null ? `${fmtMusd(net)} MUSD` : '—'}</dd>
          </div>
          <div>
            <dt>{t('send.sum.kits', { n: shares, each: `${fmtBtc(drip + tip)} BTC` })}</dt>
            <dd>{fmtBtc(kits)} BTC</dd>
          </div>
          {funding === 'btc' ? (
            <div>
              <dt>{t('send.sum.btcTotal')}</dt>
              <dd>{fmtBtc(btcIn + kits)} BTC</dd>
            </div>
          ) : null}
          <hr className="divider" />
          <div className="kv-total">
            <dt>{t('send.sum.each')}</dt>
            <dd>{each !== null ? `${fmtMusd(each)} MUSD` : '—'}</dd>
          </div>
        </dl>
        {dropKits ? <Notice kind="gold">{t('send.noKitsNote')}</Notice> : null}
        {prepCount > 0 && amount && bal.data ? (
          <Notice>{t('send.prepareNote', { amount: fmtMusd(amount - bal.data.musd), n: prepCount })}</Notice>
        ) : null}
        <p className="hint">{t('gas.body')}</p>
      </section>

      <section className="stack">
        {busy ? <Steps steps={stepDefs} current={step} done={false} /> : null}
        <ErrorNotice error={error} />
        {invalid && amountStr !== '' ? (
          <Notice kind="warn">
            {t(invalid, { cap: ctx.data ? fmtMusd(ctx.data.maxPerPacket) : '' })}
          </Notice>
        ) : null}
        {active ? (
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            disabled={busy || Boolean(invalid) || (funding === 'btc' && (!btcPlan || poolLow))}
            onClick={onSubmit}
          >
            {busy ? <span className="spinner" /> : <IconEnvelope />}
            {busy ? t('common.working') : t('send.button')}
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => setPickerOpen(true)}>
            {t('send.connectFirst')}
          </button>
        )}
        <p className="hint center">{t('send.keyNote')}</p>
      </section>

      <WalletPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </div>
  );
}

function SendDone({ done, onAgain }: { done: Done; onAgain: () => void }) {
  const { t } = useI18n();
  const [copied, copy] = useCopy();
  const [secured, setSecured] = useState(false);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  // Warn before leaving until the link has been copied or shared: we keep no copy.
  useEffect(() => {
    if (secured) return;
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [secured]);

  const lineText = `${t('done.lineText', { message: done.message, n: done.shares })}\n${done.link}`;
  const lineUrl = `https://line.me/R/share?text=${encodeURIComponent(lineText)}`;
  const path = done.link.replace(window.location.origin, '');

  return (
    <div className="stack-lg">
      <Envelope
        state="peek"
        message={done.message}
        sub={`${done.shares} × ${fmtMusd(done.net / BigInt(done.shares))} MUSD`}
        letter={
          <>
            <div className="env-letter-label">#{done.id.toString()}</div>
            <div className="env-letter-amount">{fmtMusd(done.net)}</div>
            <div className="env-letter-unit">MUSD</div>
          </>
        }
      />
      <header className="center">
        <h1 className="page-title">{t('done.title')}</h1>
        <p className="page-lead">{t('done.lead')}</p>
      </header>

      <Notice kind="warn">{t('done.warn')}</Notice>

      <div className="link-box">
        <span>{done.link}</span>
      </div>

      <div className="share-grid">
        <button
          type="button"
          className="btn btn-primary"
          onClick={async () => {
            if (await copy(done.link)) setSecured(true);
          }}
        >
          <IconCopy />
          {copied ? t('common.copied') : t('done.copy')}
        </button>
        <a className="btn btn-line" href={lineUrl} target="_blank" rel="noreferrer noopener" onClick={() => setSecured(true)}>
          {t('done.line')}
        </a>
        {canShare ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={async () => {
              try {
                await navigator.share({ text: lineText });
                setSecured(true);
              } catch {
                /* cancelled */
              }
            }}
          >
            <IconShare />
            {t('done.share')}
          </button>
        ) : null}
        <Link className="btn btn-ghost" to={path} onClick={() => setSecured(true)}>
          <IconExternal />
          {t('done.open')}
        </Link>
      </div>

      <Qr text={done.link} label="QR" />

      <div className="row-between wrap">
        <TxLink chainId={done.chainId} hash={done.txHash} />
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            if (secured || window.confirm(t('done.leaveWarn'))) onAgain();
          }}
        >
          {t('done.another')}
        </button>
      </div>
    </div>
  );
}
