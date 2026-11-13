import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatUnits, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { useI18n, type MessageKey } from '../i18n';
import { Envelope } from '../components/Envelope';
import { IconCopy, IconEnvelope, IconExternal, IconMinus, IconPlus, IconShare } from '../components/Icons';
import { LoanPanel } from '../components/LoanPanel';
import { Qr } from '../components/Qr';
import { ErrorNotice, Notice, Steps, TxLink, ChainPicker, type StepDef } from '../components/ui';
import { WalletPicker, WalletSummary } from '../components/WalletPanel';
import { createPacket, prepareMusd, prepareTxCount } from '../lib/actions';
import { getConfig } from '../lib/api';
import { chainInfo, defaultChainId, parseChainId, publicClient, type ChainId } from '../lib/chains';
import { capProblem, readBalances, readBtcPrice, readPoolQuote, readSendContext } from '../lib/chainData';
import { packetLink } from '../lib/eip712';
import { shareUrls } from '../lib/share';
import { cleanMessage, fmtBtc, fmtMusd, parseAmountInput, pct, stripControls, utf8Bytes } from '../lib/format';
import { useAsync, useCopy } from '../lib/hooks';
import { GAS, ORACLE_SLIPPAGE_BPS, btcPreflight, sizeKits } from '../lib/sendPlan';
import {
  FLOOR_DEFAULT_PCT,
  borrowForPacket,
  floorFromPct,
  fmtRatio,
  planBorrow,
  readBorrowingFee,
  readLoan,
  type LoanProblem,
} from '../lib/trove';
import { useWallet } from '../lib/walletContext';

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const E18 = 10n ** 18n;
const MIN_SHARE = 10n ** 16n; // 0.01 MUSD
type Funding = 'musd' | 'btc' | 'loan';
type Block = { key: MessageKey; vars?: Record<string, string | number> };

function loanBlock(p: LoanProblem): Block {
  switch (p.kind) {
    case 'price':
      return { key: 'loan.block.price' };
    case 'recovery':
      return { key: 'loan.block.recovery' };
    case 'capacity':
      return { key: 'loan.block.capacity', vars: { cap: fmtMusd(p.cap) } };
    case 'floor':
      return { key: 'loan.block.floor', vars: { icr: fmtRatio(p.icr), floor: fmtRatio(p.floor) } };
    case 'system':
      return { key: 'loan.block.system', vars: { ccr: fmtRatio(p.ccr) } };
  }
}
// Hongbao.MAX_DURATION is 7 days from the block that includes the create; keep 15 minutes of
// slack so a phone clock running ahead (or a slow block) cannot push "7 days" past it (BadExpiry).
const EXPIRY = { '1h': 3600, '24h': 86400, '3d': 3 * 86400, '7d': 7 * 86400 - 900 } as const;
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

  // MUSD is the default everywhere; on mainnet Mezo's BTC pool is thin (SPEC.md, UI rules from the review).
  const [funding, setFunding] = useState<Funding>('musd');
  const [floorPct, setFloorPct] = useState(FLOOR_DEFAULT_PCT);
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

  const ctx = useAsync(() => readSendContext(chainId, active?.address), [chainId, active?.address], Boolean(info.hongbao));
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
  const [btcPlan, setBtcPlan] = useState<{ btcIn: bigint; quote: bigint | null } | null>(null);
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
        setBtcPlan({ btcIn, quote: q1 });
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

  // BTC funding preflight: the pool quote against the PriceFeed floor createWithBTC enforces.
  const btcIn = funding === 'btc' ? btcPlan?.btcIn ?? 0n : 0n;
  const pre = funding === 'btc' && btcPlan ? btcPreflight(btcPlan.btcIn, btcPlan.quote, price.data ?? null) : null;
  const swapFloor = pre ? (pre.oracleMin > pre.minMusdOut ? pre.oracleMin : pre.minMusdOut) : null;

  // Fund from my Mezo loan: borrow what the wallet's own MUSD does not cover.
  const loanEligible = Boolean(active) && !passOn;
  const loan = useAsync(() => readLoan(chainId, active!.address), [chainId, active?.address], loanEligible);
  const showLoan = loanEligible && (active?.kind === 'injected' || Boolean(loan.data));
  useEffect(() => {
    if (funding === 'loan' && !showLoan) setFunding('musd');
  }, [funding, showLoan]);
  const borrowNeed = funding === 'loan' && amount && bal.data && amount > bal.data.musd ? amount - bal.data.musd : 0n;
  const borrowFee = useAsync(() => readBorrowingFee(chainId, borrowNeed), [chainId, borrowNeed], borrowNeed > 0n);
  const floor = floorFromPct(floorPct);
  const loanPlan =
    funding === 'loan' && loan.data && borrowNeed > 0n && borrowFee.data !== undefined && !borrowFee.loading
      ? planBorrow(loan.data, borrowNeed, borrowFee.data, floor)
      : null;
  const loanReadFailed =
    funding === 'loan' && ((Boolean(loan.error) && loan.data === undefined) || (borrowNeed > 0n && Boolean(borrowFee.error)));
  const loanPending =
    funding === 'loan' &&
    !loanReadFailed &&
    (loan.data === undefined || (borrowNeed > 0n && loanPlan === null) || bal.data === undefined);

  const spendable = bal.data ? bal.data.musd + bal.data.smusd + bal.data.staked : null;
  const prepCount = funding === 'musd' && amount && bal.data ? prepareTxCount(amount, bal.data) : 0;

  // Gas kits sized to what the wallet's BTC pays after this send's own transactions.
  const btcBal = bal.data?.btc ?? null;
  const gasUnits =
    funding === 'btc'
      ? GAS.createBtc
      : GAS.approve + GAS.create + (funding === 'loan' ? (borrowNeed > 0n ? GAS.borrow : 0n) : BigInt(prepCount) * GAS.prepare);
  const kitPlan = sizeKits({ shares, btcBalance: btcBal, btcIn, gasPrice: gas.data ?? 2_000_000n, gasUnits });
  const drip = kitPlan.dripPerShare;
  const tip = kitPlan.tipPerShare;
  const kits = kitPlan.kits;

  const attesterCfg = cfg.data?.chains[String(chainId)]?.attester ?? null;
  const attester = onePer && attesterCfg ? attesterCfg : ZERO;

  const cleanShown = cleanMessage(shownMessage);
  const msgBytes = utf8Bytes(stripControls(shownMessage));
  const cap = useMemo(() => (net !== null && ctx.data ? capProblem(ctx.data, net) : null), [net, ctx.data]);

  const block: Block | null = (() => {
    if (!info.enabled) return { key: 'send.notLive' };
    if (ctx.data?.paused) return { key: 'send.paused' };
    if (!amount || amount <= 0n) return { key: 'send.invalid.amount' };
    if (shares < 1 || shares > 100) return { key: 'send.invalid.shares' };
    if (msgBytes > 200) return { key: 'send.invalid.message' };
    if (funding === 'btc') {
      if (price.data === null || pre?.problem === 'noPrice') return { key: 'send.quote.unavailable' };
      if (pre?.problem === 'noQuote') return { key: 'send.quote.poolUnavailable' };
      if (pre?.problem === 'poolLow' && btcPlan?.quote && price.data) {
        return {
          key: 'send.quote.poolLow',
          vars: { pool: fmtMusd(btcPlan.quote), oracle: fmtMusd((btcPlan.btcIn * price.data) / E18) },
        };
      }
    }
    if (net !== null && net / BigInt(shares) < MIN_SHARE) return { key: 'send.invalid.min' };
    if (cap) {
      const vars = { cap: cap.kind !== 'total' ? fmtMusd(cap.cap) : '', room: cap.kind !== 'packet' ? fmtMusd(cap.room) : '' };
      return { key: cap.kind === 'packet' ? 'send.invalid.cap' : cap.kind === 'sender' ? 'send.invalid.senderCap' : 'send.invalid.totalCap', vars };
    }
    if (funding === 'musd' && spendable !== null && amount > spendable) return { key: 'send.invalid.balance' };
    if (funding === 'loan') {
      if (loanReadFailed) return { key: 'loan.block.read' };
      if (loan.data === null) return { key: 'loan.none', vars: { chain: t(info.nameKey) } };
      if (loanPlan?.problem) return loanBlock(loanPlan.problem);
    }
    if (btcBal !== null && kitPlan.mode === 'none') {
      return btcBal < btcIn + kitPlan.gasCost ? { key: 'send.invalid.btc' } : { key: 'send.kits.none', vars: { n: shares } };
    }
    return null;
  })();
  const waiting = (funding === 'btc' && (!btcPlan || quoting)) || loanPending;

  /* ---------------------------------------------------------------- submit */

  const keyRef = useRef<Hex | null>(null);
  const [busy, setBusy] = useState(false);
  const [borrowing, setBorrowing] = useState<bigint>(0n);
  const [step, setStep] = useState<string | null>(null);
  const [seen, setSeen] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<Done | null>(null);

  const onSubmit = async () => {
    if (!active || block || waiting || !amount || busy) return;
    if (funding === 'btc' && (!btcPlan || !pre || pre.problem)) return;
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
      if (funding === 'loan') {
        // Tx 1: borrow only what the wallet lacks right now (a retry after a failed tx 2 borrows nothing).
        const fresh = await readBalances(chainId, active.address);
        const need = amount > fresh.musd ? amount - fresh.musd : 0n;
        if (need > 0n) {
          setBorrowing(need);
          report('borrow');
          await borrowForPacket(active, chainId, need, floor);
        }
      }
      const created = await createPacket(
        active,
        chainId,
        funding === 'btc'
          ? {
              kind: 'btc',
              btcIn: btcPlan!.btcIn,
              minMusdOut: pre!.minMusdOut,
              maxSlippageBps: Number(ORACLE_SLIPPAGE_BPS),
            }
          : { kind: 'musd', amount },
        {
          shares,
          expiry: BigInt(Math.floor(Date.now() / 1000) + EXPIRY[expiry]),
          claimKey,
          attester,
          dripPerShare: drip,
          tipPerShare: tip,
          message: cleanShown,
        },
        report,
      );
      setDone({
        chainId,
        id: created.id,
        txHash: created.txHash,
        link: packetLink(window.location.origin, chainId, created.id, linkKey, info.hongbao ?? undefined),
        message: cleanShown,
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
      ctx.reload();
      if (funding === 'loan') loan.reload();
    }
  };

  if (done) return <SendDone done={done} onAgain={() => setDone(null)} />;

  const stepDefs: StepDef[] = [
    ...(seen.includes('prepare') || prepCount > 0 ? [{ key: 'prepare', label: t('send.step.prepare') }] : []),
    ...(seen.includes('borrow') || borrowNeed > 0n
      ? [{ key: 'borrow', label: t('send.step.borrow', { amount: fmtMusd(borrowing || borrowNeed) }) }]
      : []),
    ...(funding !== 'btc'
      ? seen.includes('approve')
        ? [{ key: 'approve', label: t('send.step.approve') }]
        : seen.includes('permit') || !seen.includes('create')
          ? [{ key: 'permit', label: t('send.step.permit') }]
          : []
      : []),
    { key: 'create', label: t('send.step.create') },
  ];

  const balLine = bal.data
    ? `${fmtBtc(bal.data.btc)} BTC · ${fmtMusd(bal.data.musd)} MUSD`
    : null;

  return (
    <div className="send-layout">
      <div className="send-form stack-lg">
      <header>
        <div className="eyebrow">{passOn ? t('send.passOn.title') : t('brand.tagline')}</div>
        <h1 className="page-title">{passOn ? t('send.passOn.title') : t('send.title')}</h1>
        <p className="page-lead">{passOn ? t('send.passOn.lead') : t('send.lead')}</p>
      </header>

      <section className="field">
        <span className="label">{t('send.network')}</span>
        <ChainPicker value={chainId} onChange={setChainId} need="enabled" />
        <span className="hint">{t(info.testnet ? 'chain.testnetNote' : 'chain.mainnetNote')}</span>
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
          {showLoan ? (
            <button type="button" aria-pressed={funding === 'loan'} onClick={() => setFunding('loan')}>
              {t('send.fund.loan')}
            </button>
          ) : null}
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
            {btcPlan?.quote ? (
              <span className="hint mono">
                {t('send.quote.pool', { btc: fmtBtc(btcPlan.btcIn), musd: fmtMusd(btcPlan.quote) })}
              </span>
            ) : quoting ? (
              <span className="hint">{t('common.loading')}</span>
            ) : null}
            {pre && !pre.problem && swapFloor !== null ? (
              <span className="hint">{t('send.slippage', { min: fmtMusd(swapFloor) })}</span>
            ) : null}
            {!info.testnet ? <span className="hint">{t('send.quote.thinPool')}</span> : null}
          </div>
        ) : null}
      </section>

      {funding === 'loan' ? (
        <LoanPanel
          loan={loan.data}
          loading={loan.loading}
          plan={loanPlan}
          borrow={borrowNeed}
          floorPct={floorPct}
          onFloorPct={setFloorPct}
        />
      ) : null}

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
      </div>

      {/* Wide screens: the summary and the button stay in view beside the form. */}
      <aside className="send-aside stack">
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
            <dt>
              {t('send.sum.kits')}
              <span className="kv-sub">{t('send.sum.kitsEach', { n: shares, each: `${fmtBtc(drip + tip)} BTC` })}</span>
            </dt>
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
        {kitPlan.mode === 'reduced' ? (
          <Notice kind="gold">{t('send.kits.reduced', { each: fmtBtc(drip + tip) })}</Notice>
        ) : kitPlan.mode === 'tipOnly' ? (
          <Notice kind="gold">{t('send.kits.tipOnly')}</Notice>
        ) : null}
        {prepCount > 0 && amount && bal.data && spendable !== null && amount <= spendable ? (
          <Notice>{t('send.prepareNote', { amount: fmtMusd(amount - bal.data.musd), n: prepCount })}</Notice>
        ) : null}
        <p className="hint">{t('send.yieldNote')}</p>
        <p className="hint">{t('gas.body')}</p>
      </section>

      <section className="stack">
        {busy ? <Steps steps={stepDefs} current={step} done={false} /> : null}
        <ErrorNotice error={error} />
        {block && amountStr !== '' ? <Notice kind="warn">{t(block.key, block.vars)}</Notice> : null}
        {active ? (
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            disabled={busy || Boolean(block) || waiting}
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
      </aside>

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

  const shareText = t('done.shareText', { message: done.message, n: done.shares });
  const urls = shareUrls(done.link, shareText);
  const path = done.link.replace(window.location.origin, '');
  const shared = () => setSecured(true);

  return (
    <div className="stack-lg send-done">
      <Envelope
        state="peek"
        size="sm"
        message={done.message}
        sub={`${done.shares} × ${fmtMusd(done.net / BigInt(done.shares))} MUSD`}
        letter={
          <>
            <div className="env-letter-label">{t('send.sum.net')}</div>
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

      {/* Share order (SPEC.md, Phase 2): Telegram, WhatsApp, LINE, copy, QR, then the system sheet. */}
      <div className="stack-sm">
        <a className="btn btn-tg btn-lg btn-block" href={urls.telegram} target="_blank" rel="noreferrer noopener" onClick={shared}>
          {t('done.telegram')}
        </a>
        <div className="share-grid">
          <a className="btn btn-wa" href={urls.whatsapp} target="_blank" rel="noreferrer noopener" onClick={shared}>
            {t('done.whatsapp')}
          </a>
          <a className="btn btn-line" href={urls.line} target="_blank" rel="noreferrer noopener" onClick={shared}>
            {t('done.line')}
          </a>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          onClick={async () => {
            if (await copy(done.link)) shared();
          }}
        >
          <IconCopy />
          {copied ? t('common.copied') : t('done.copy')}
        </button>
      </div>

      <Qr text={done.link} label="QR" />

      <div className="stack-sm">
        {canShare ? (
          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={async () => {
              try {
                await navigator.share({ text: shareText, url: done.link });
                shared();
              } catch {
                /* cancelled */
              }
            }}
          >
            <IconShare />
            {t('done.share')}
          </button>
        ) : null}
        <Link className="btn btn-ghost btn-block" to={path} onClick={shared}>
          <IconExternal />
          {t('done.open')}
        </Link>
      </div>

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
