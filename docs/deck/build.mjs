#!/usr/bin/env node
// Builds the Hongbao pitch deck with no npm dependencies (Node >= 22 and Google Chrome):
//   1. reads docs/proof.json, config/*.json and, when reachable, the live /api/config and /api/stats,
//   2. prepares the phone screenshots listed in shots.json (crop, stack, JPEG) into img/,
//   3. fills deck.html into Hongbao-deck.html,
//   4. checks every slide for overflow, clipping, small text, missing images and leftover placeholders,
//   5. prints docs/Hongbao-deck.pdf (1920x1080 pages, no margins, backgrounds on) with headless Chrome.
//
//   node docs/deck/build.mjs                  live numbers when the site answers, else docs/proof.json
//   node docs/deck/build.mjs --offline        docs/proof.json only
//   node docs/deck/build.mjs --png <dir>      also save one PNG per slide
//   other flags: --site <url>  --proof <file>  --strict (exit 1 on any layout warning)  --no-pdf
//   links for the last slide, once they exist (any of them switches it to two columns):
//     --video-url <url>   the demo video        --deck-url <url>   where this PDF is hosted
//     --claim-url <url>   a live packet link for judges (shown without its #k= key, which stays in the href)
//   CHROME_BIN overrides the Chrome path.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DECK = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DECK, '..', '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const SITE = opt('--site', 'https://hongbao.trytry.net').replace(/\/$/, '');
const OUT_HTML = join(DECK, 'Hongbao-deck.html');
const OUT_PDF = join(ROOT, 'docs', 'Hongbao-deck.pdf');
const PNG_DIR = opt('--png', null);
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Facts that are not on-chain. Keep in sync with README.md and docs/SECURITY.md.
const FACTS = {
  repo: 'https://github.com/tedinroc/hongbao',
  appTests: 116, // `cd web && npm test` (vitest)
  reviewPasses: 3, // docs/SECURITY.md: three AI-assisted passes
  // MUSD; read from contracts/script/Deploy.s.sol when it is there, these are the fallback
  mainnetCaps: { perPacket: 50, perSender: 100, total: 500 },
  mainnetHardCaps: { perPacket: 100, perSender: 500, total: 5000 },
};
const LINKS = { video: opt('--video-url', null), deck: opt('--deck-url', null), claim: opt('--claim-url', null) };
const CHAINS = {
  31611: { name: 'Mezo testnet', explorer: 'https://explorer.test.mezo.org' },
  31612: { name: 'Mezo mainnet', explorer: 'https://explorer.mezo.org' },
};

const log = (...a) => console.log('[deck]', ...a);
const warnings = [];
const warn = (m) => { warnings.push(m); console.warn('[deck] WARN', m); };
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- data

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

const fmtMusd = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n) => Number(n).toLocaleString('en-US');
const weiToNum = (w) => Number(BigInt(w) / 10n ** 14n) / 1e4; // 4 decimals is plenty for display
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fmtStamp = (d) => `${fmtDate(d)} ${new Date(d).toISOString().slice(11, 16)} UTC`;   // a fixed time, not 'matches live' (new claims keep coming)

// Tags addresses from /api/stats recent events with config/team-wallets.json. Only trusted when the events cover the
// whole deployment (the endpoint returns at most 20 events per kind from a limited block window).
function tagLive(live, team, deployBlock) {
  const { stats, recent } = live;
  const complete = recent && recent.fromBlock <= deployBlock
    && recent.created.length === +stats.packets && recent.claimed.length === +stats.claims
    && recent.created.length < 20 && recent.claimed.length < 20 && recent.refunded.length < 20;
  if (!complete) return null;
  const isTeam = (a) => team.has(a.toLowerCase());
  const senders = new Set(recent.created.map((e) => e.sender.toLowerCase()));
  const recipients = new Set(recent.claimed.map((e) => e.recipient.toLowerCase()));
  const by = { stake: 0, save: 0, cash: 0 };
  for (const c of recent.claimed) by[String(c.payout).toLowerCase()] = (by[String(c.payout).toLowerCase()] || 0) + 1;
  return {
    packets: +stats.packets,
    claims: +stats.claims,
    refunds: recent.refunded.length,
    musdIntoPackets: weiToNum(stats.volume),
    senders: senders.size,
    outsideSenders: [...senders].filter((a) => !isTeam(a)).length,
    recipients: recipients.size,
    outsideRecipients: [...recipients].filter((a) => !isTeam(a)).length,
    outsideRecipientsWhoSignedOwnTx: null, // needs a full scan, only docs/proof.json has it
    claimsByPayout: by,
    fundedWithBTC: recent.created.filter((e) => e.funding === 'BTC').length,
  };
}

async function loadData() {
  const proofPath = resolve(process.cwd(), opt('--proof', join(ROOT, 'docs', 'proof.json')));
  const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
  // docs/PROOF.md is the readable twin of docs/proof.json, written by the same ops/proof.mjs run
  const proofName = proofPath === join(ROOT, 'docs', 'proof.json') ? 'docs/PROOF.md' : proofPath.split('/').pop();
  const deployments = readJson('config/deployments.json');
  const team = new Set(readJson('config/team-wallets.json').wallets.map((w) => w.address.toLowerCase()));

  let liveConfig = null;
  if (!flag('--offline')) {
    try { liveConfig = await getJson(`${SITE}/api/config`); log('live config from', SITE); }
    catch (e) { warn(`live config unreachable (${e.message}); using config/deployments.json`); }
  }

  const chains = [];
  for (const id of Object.keys(CHAINS)) {
    const dep = deployments[id] || {};
    const cfg = liveConfig?.chains?.[id];
    const address = cfg?.hongbao ?? dep.hongbao;
    const enabled = (cfg?.enabled ?? dep.enabled) && !!address;
    const p = proof.chains?.[id]?.summary;
    if (!enabled && !p) continue;
    const deployBlock = cfg?.deployBlock ?? dep.deployBlock ?? p?.fromBlock ?? 0;

    let s = p ? { ...p, musdIntoPackets: Number(p.musdIntoPackets) } : null;
    let source = p ? `${proofName}, ${fmtDate(proof.generatedAt)}` : null;
    let liveNote = null;
    if (enabled && !flag('--offline')) {
      try {
        const live = await getJson(`${SITE}/api/stats?chainId=${id}`);
        const tagged = tagLive(live, team, deployBlock);
        const asOf = fmtStamp(live.block?.timestamp ? live.block.timestamp * 1000 : Date.now());
        const newer = !s || +live.stats.packets > s.packets || +live.stats.claims > s.claims;
        if (tagged && newer) {
          // keep the proof-only metric when the live data adds nothing new for outside recipients
          tagged.outsideRecipientsWhoSignedOwnTx = s && tagged.outsideRecipients === s.outsideRecipients ? s.outsideRecipientsWhoSignedOwnTx : null;
          s = tagged; source = `live /api/stats, ${asOf}`;
        } else if (newer) {
          liveNote = `Live counter now: ${fmtInt(live.stats.packets)} packets, ${fmtInt(live.stats.claims)} claims (all wallets, ${asOf})`;
        } else {
          source = `${proofName}, matches live /api/stats as of ${asOf}`;
        }
        log(`chain ${id}: live packets=${live.stats.packets} claims=${live.stats.claims} recipients=${live.stats.recipients}`);
      } catch (e) { warn(`live stats for ${id} unreachable (${e.message}); using docs/proof.json`); }
    }
    if (!s) { warn(`no numbers for chain ${id}`); continue; }
    chains.push({ id: +id, ...CHAINS[id], address, enabled, stats: s, source, liveNote });
  }
  if (!chains.length) throw new Error('no chain data: docs/proof.json has no chains and nothing is live');
  return { chains, proof };
}

function countContractTests() {
  const dir = join(ROOT, 'contracts', 'test');
  let n = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sol'))) {
    n += (readFileSync(join(dir, f), 'utf8').match(/function (test|invariant)\w*\s*\(/g) || []).length;
  }
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').match(/forge test`\s*\((\d+)/);
  if (readme && +readme[1] !== n) warn(`README says ${readme[1]} contract tests, contracts/test has ${n}`);
  return n;
}

// Mainnet beta caps and hard caps as the deploy script sets them (MUSD).
function mainnetCaps() {
  const f = join(ROOT, 'contracts', 'script', 'Deploy.s.sol');
  if (!existsSync(f)) { log('Deploy.s.sol not found; mainnet caps from FACTS'); return { soft: FACTS.mainnetCaps, hard: FACTS.mainnetHardCaps }; }
  const block = (readFileSync(f, 'utf8').split('chainId == 31612')[1] || '').split('} else')[0];
  const v = (k) => { const m = block.match(new RegExp(`\\b${k}:\\s*([\\d_]+)e18`)); return m ? Number(m[1].replace(/_/g, '')) : null; };
  const soft = { perPacket: v('maxPerPacket'), perSender: v('maxPerSender'), total: v('maxOutstanding') };
  const hard = { perPacket: v('hardMaxPerPacket'), perSender: v('hardMaxPerSender'), total: v('hardMaxOutstanding') };
  if (Object.values(soft).concat(Object.values(hard)).some((x) => x == null)) {
    warn('could not read the mainnet caps from Deploy.s.sol; using FACTS');
    return { soft: FACTS.mainnetCaps, hard: FACTS.mainnetHardCaps };
  }
  for (const [name, got, want] of [['caps', soft, FACTS.mainnetCaps], ['hard caps', hard, FACTS.mainnetHardCaps]]) {
    if (JSON.stringify(got) !== JSON.stringify(want)) warn(`Deploy.s.sol mainnet ${name} ${JSON.stringify(got)} differ from FACTS ${JSON.stringify(want)}; the deck uses Deploy.s.sol`);
  }
  return { soft, hard };
}

// The app's default gas kit per share (web/src/lib/sendPlan.ts): drip to the recipient plus tip to the relayer.
function gasKit() {
  const src = readFileSync(join(ROOT, 'web', 'src', 'lib', 'sendPlan.ts'), 'utf8');
  const wei = (name) => { const m = src.match(new RegExp(`export const ${name} = ([\\d_]+)n`)); if (!m) throw new Error(`sendPlan.ts: no ${name}`); return BigInt(m[1].replace(/_/g, '')); };
  const btc = (w) => (Number(w) / 1e18).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  const drip = wei('DRIP'), tip = wei('TIP');
  return { drip: btc(drip), tip: btc(tip), kit: btc(drip + tip) };
}

// One real testnet transaction per Mezo call path, from docs/proof.json.
function proofTxs(proof) {
  const c = proof.chains?.['31611'] || {}, m = proof.chains?.['31612'] || {};
  const T = CHAINS[31611].explorer, M = CHAINS[31612].explorer;
  const pick = (list, test) => (list || []).find(test)?.tx || null;
  const link = (label, tx, explorer = T) => (tx
    ? `<a class="tx" href="${esc(`${explorer}/tx/${tx}`)}"><span>${esc(label)}</span><b>${esc(tx.slice(0, 10))}…</b></a>`
    : '<span class="by-app">not yet on testnet</span>');
  const tx = {
    // the permit row needs a createWithPermit tx: on testnet that is packet #5 (permit after the loan); packets #1, #2, #4
    // and #6 used create with a separate approval
    fundMusd: pick(c.packets, (p) => !!p.loanTx),
    fundBtc: pick(c.packets, (p) => p.funding === 'BTC'),
    stake: pick(c.claims, (x) => /^Earn MEZO/.test(x.payout)),
    save: pick(c.claims, (x) => /^Save/.test(x.payout)),
    cash: pick(c.claims, (x) => /^Cash/.test(x.payout)),
    refund: pick(c.refunds, () => true),
    loan: (c.packets || []).find((p) => p.loanTx)?.loanTx || null,
  };
  for (const [k, v] of Object.entries(tx)) if (!v) warn(`docs/proof.json has no testnet transaction for ${k}`);
  const mFund = pick(m.packets, (p) => p.funding === 'MUSD' && !p.loanTx), mStake = pick(m.claims, (x) => /^Earn MEZO/.test(x.payout));
  return {
    // mainnet evidence where it exists: every mainnet packet so far was funded from MetaMask with createWithPermit, and
    // every mainnet claim was staked in the gauge
    txFundMusd: mFund ? link('Mainnet packet', mFund, M) : link('MUSD packet', tx.fundMusd),
    txFundBtc: link('BTC packet', tx.fundBtc),
    txStake: mStake ? link('Mainnet staked claim', mStake, M) : link('Staked claim', tx.stake),
    txSave: link('Save', tx.save),
    txCash: link('Cash', tx.cash),
    txRefund: link('Refund', tx.refund),
    txLoan: link('withdrawMUSD', tx.loan),
  };
}

function licenseNote() {
  const f = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].map((n) => join(ROOT, n)).find(existsSync);
  const mit = f && /MIT License|Permission is hereby granted, free of charge/i.test(readFileSync(f, 'utf8'));
  if (!mit) log('no MIT LICENSE file in the repo: the deck does not say MIT');
  return `${mit ? 'MIT · ' : ''}contracts, app, relayer and tests`;
}

// ---------------------------------------------------------------- slide fragments

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many) => `${n === 1 ? one : many}`;

function stat(big, label, note, cls = '') {
  return `<div class="stat ${cls}"><div class="big">${esc(big)}</div><div class="stat-label">${esc(label)}</div>${note ? `<div class="stat-note">${esc(note)}</div>` : ''}</div>`;
}

function tractionHtml(chains, ledgerUrl) {
  const main = chains.find((c) => c.id === 31612 && c.enabled) || chains[0];
  const others = chains.filter((c) => c !== main);
  const s = main.stats;
  const by = s.claimsByPayout || {};
  const outside = (s.outsideSenders || 0) + (s.outsideRecipients || 0);
  const payouts = [by.stake && `${by.stake} staked`, by.save && `${by.save} saved`, by.cash && `${by.cash} cash`].filter(Boolean).join(' · ');
  // fundedFromMezoLoan only comes from docs/proof.json (ops/proof.mjs finds the sender's withdrawMUSD call)
  const nBtc = s.fundedWithBTC || 0, nLoan = s.fundedFromMezoLoan || 0, nMusd = s.packets - nBtc - nLoan;
  const funded = nBtc || nLoan
    ? [nMusd && `${nMusd} with MUSD`, nBtc && `${nBtc} with BTC`, nLoan && `${nLoan} from a Mezo loan`].filter(Boolean).join(', ')
    : 'funded with MUSD';
  const ledgerHost = ledgerUrl.replace(/^https?:\/\//, '');
  const allPayouts = by.stake > 0 && by.save > 0 && by.cash > 0;
  let h = '';
  if (outside === 0) {
    h += `<h2>${allPayouts ? `Live on ${esc(main.name)}. All three payouts proven on-chain.` : `Live on ${esc(main.name)}, proven on-chain.`}</h2>`;
    h += `<div class="row-label"><span class="tag">${esc(main.name)}</span><span>Team test wallets, tagged on the public ledger</span></div>`;
    h += '<div class="stats4">';
    h += stat(fmtInt(s.packets), plural(s.packets, 'packet', 'packets'), funded);
    h += stat(fmtInt(s.claims), plural(s.claims, 'claim', 'claims'), payouts);
    h += stat(fmtMusd(s.musdIntoPackets), 'MUSD into packets', 'parked as sMUSD until claimed');
    h += stat(fmtInt(s.refunds), plural(s.refunds, 'refund', 'refunds'), 'back to the sender');
    h += '</div>';
    h += `<div class="callout"><div class="callout-head">Open to anyone on ${esc(main.name)}</div>`;
    h += `<div class="callout-body">Every outside packet and claim shows up live, tagged team or outside: <a href="${esc(ledgerUrl)}">${esc(ledgerHost)}</a></div></div>`;
  } else {
    h += `<h2>${fmtInt(s.outsideRecipients)} ${plural(s.outsideRecipients, 'wallet', 'wallets')} outside the team opened a packet.</h2>`;
    h += `<div class="row-label"><span class="tag">${esc(main.name)}</span><span>Outside = not in the team wallet list</span></div>`;
    // outside metrics are highlighted only when they are above zero; the other slots carry the plain totals
    const cards = [stat(fmtInt(s.outsideRecipients), 'outside recipients', `of ${fmtInt(s.recipients)} in all`, 'hot')];
    if (s.outsideSenders > 0) cards.push(stat(fmtInt(s.outsideSenders), 'outside senders', `of ${fmtInt(s.senders)} in all`, 'hot'));
    if (s.outsideRecipientsWhoSignedOwnTx > 0) cards.push(stat(fmtInt(s.outsideRecipientsWhoSignedOwnTx), 'came back', 'outside recipients who later signed their own transaction', 'hot'));
    cards.push(stat(fmtInt(s.packets), plural(s.packets, 'packet', 'packets'), s.outsideSenders > 0 ? funded : `sent by the team, ${funded}`));
    cards.push(stat(fmtInt(s.claims), plural(s.claims, 'claim', 'claims'), payouts));
    const musdCard = cards.length < 4;
    if (musdCard) cards.push(stat(fmtMusd(s.musdIntoPackets), 'MUSD into packets', 'all wallets, parked as sMUSD until claimed'));
    h += `<div class="stats4">${cards.slice(0, 4).join('')}</div>`;
    h += `<div class="callout"><div class="callout-head">${musdCard ? 'Every packet and claim is public' : `${fmtMusd(s.musdIntoPackets)} MUSD into packets, all wallets`}</div>`;
    h += `<div class="callout-body">${musdCard ? 'Tagged team or outside, with explorer links' : 'Every packet and claim, tagged team or outside'}: <a href="${esc(ledgerUrl)}">${esc(ledgerHost)}</a></div></div>`;
  }
  for (const c of others) {
    const o = c.stats;
    h += o.outsideRecipients > 0
      ? `<p class="fine">${esc(c.name)}: ${fmtInt(o.packets)} packets, ${fmtInt(o.claims)} claims, ${fmtMusd(o.musdIntoPackets)} MUSD; outside recipients ${fmtInt(o.outsideRecipients)}.</p>`
      : `<p class="fine">${esc(c.name)} (team test runs, every funding path and payout): ${fmtInt(o.packets)} packets, ${fmtInt(o.claims)} claims, ${fmtMusd(o.musdIntoPackets)} MUSD.</p>`;
  }
  if (main.liveNote) h += `<p class="fine">${esc(main.liveNote)}</p>`;
  // the footer links to the evidence: PROOF.md on GitHub (explorer link per transaction), or the live ledger
  const sourceUrl = main.source.startsWith('live') ? ledgerUrl : `${FACTS.repo}/blob/main/docs/PROOF.md`;
  return { html: h, source: `Source: ${main.source}`, sourceUrl };
}

function extraLinkRows() {
  const bare = (u) => {
    const s = u.replace(/^https?:\/\//, '').replace(/#.*$/, '').replace(/\/$/, ''); // never print a packet's #k= key
    const parts = s.split('/');
    return s.length > 42 && parts.length > 2 ? `${parts[0]}/…/${parts[parts.length - 1]}` : s;
  };
  const row = (k, url, note, hot) => `<div class="link-row${hot ? ' hot' : ''}"><div class="link-k">${esc(k)}</div><div class="link-v"><a href="${esc(url)}">${esc(bare(url))}</a><span class="link-note">${esc(note)}</span></div></div>`;
  const rows = [];
  if (LINKS.claim) rows.push(row('Open a packet', LINKS.claim, 'a live packet for judges, one share per person', true));
  if (LINKS.video) rows.push(row('Demo video', LINKS.video, 'the product, start to finish'));
  if (LINKS.deck) rows.push(row('This deck', LINKS.deck, 'PDF with clickable links'));
  return rows;
}

function contractRows(chains) {
  // mainnet first
  return chains.filter((c) => c.address).sort((a, b) => (b.id === 31612) - (a.id === 31612)).map((c) => {
    const url = `${c.explorer}/address/${c.address}`;
    return `<div class="link-row"><div class="link-k">Contract</div><div class="link-v"><a class="mono addr" href="${esc(url)}">${esc(c.address)}</a><span class="link-note">${esc(c.name)} · source verified on ${esc(c.explorer.replace(/^https?:\/\//, ''))}</span></div></div>`;
  }).join('\n');
}

// ---------------------------------------------------------------- headless Chrome (DevTools protocol over WebSocket)

async function launchChrome() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_BIN)`);
  const profile = mkdtempSync(join(tmpdir(), 'hongbao-deck-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--force-color-profile=srgb',
    '--allow-file-access-from-files', '--mute-audio', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
  const kill = () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* gone */ } } try { rmSync(profile, { recursive: true, force: true }); } catch { /* ok */ } };
  process.on('exit', kill);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { kill(); process.exit(130); });

  let ws = null;
  for (let t = 0; t < 300 && !ws; t++) {
    await sleep(100);
    const f = join(profile, 'DevToolsActivePort');
    if (existsSync(f)) { const [port, path] = readFileSync(f, 'utf8').split('\n'); if (port && path) ws = `ws://127.0.0.1:${port}${path}`; }
  }
  if (!ws) { kill(); throw new Error('Chrome did not start'); }
  const sock = new WebSocket(ws);
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('DevTools socket failed')); });
  let id = 0; const pending = new Map();
  sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result); }
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej, method });
    sock.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
  });
  return {
    async page(width, height) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const s = (m, p) => send(m, p, sessionId);
      await s('Page.enable'); await s('Runtime.enable');
      await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      const evaluate = async (expression) => {
        const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      };
      return {
        send: s, evaluate,
        async goto(url) {
          await s('Page.navigate', { url });
          for (let t = 0; t < 600; t++) { if (await evaluate('document.readyState') === 'complete') return; await sleep(100); }
          throw new Error(`load timeout ${url}`);
        },
      };
    },
    close() { try { sock.close(); } catch { /* ok */ } kill(); },
  };
}

// ---------------------------------------------------------------- screenshots

async function prepareShots(browser) {
  const spec = JSON.parse(readFileSync(join(DECK, 'shots.json'), 'utf8'));
  const page = await browser.page(800, 600);
  const out = {};
  for (const shot of spec.shots) {
    const dest = join(DECK, shot.out);
    const key = shot.out.replace(/^img\//, '').replace(/\.\w+$/, '');
    out[key] = shot.out;
    const missing = shot.layers.map((l) => l.src).filter((p) => !existsSync(join(ROOT, p)));
    if (missing.length) {
      if (existsSync(dest)) { log(`${shot.out}: source missing, keeping the committed file`); continue; }
      throw new Error(`${shot.out}: missing ${missing.join(', ')} and no committed copy`);
    }
    const layers = shot.layers.map((l) => ({ ...l, data: 'data:image/png;base64,' + readFileSync(join(ROOT, l.src)).toString('base64') }));
    const dataUrl = await page.evaluate(`(async () => {
      const layers = ${JSON.stringify(layers)};
      const W = ${spec.width};
      const imgs = await Promise.all(layers.map(l => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = l.data; })));
      const parts = layers.map((l, k) => {
        const img = imgs[k], sx = img.naturalWidth / W;
        const h = l.h ? Math.round(l.h * sx) : img.naturalHeight;
        const y = l.y == null ? 0 : l.y < 0 ? img.naturalHeight + Math.round(l.y * sx) : Math.round(l.y * sx);
        return { img, y, h, dh: Math.round(h / sx) };
      });
      const c = document.createElement('canvas');
      c.width = W; c.height = parts.reduce((a, p) => a + p.dh, 0);
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      let at = 0;
      for (const p of parts) { g.drawImage(p.img, 0, p.y, p.img.naturalWidth, p.h, 0, at, W, p.dh); at += p.dh; }
      return c.toDataURL('image/jpeg', ${spec.quality});
    })()`);
    mkdirSync(dirname(dest), { recursive: true });
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    writeFileSync(dest, buf);
    log(`${shot.out}: ${(buf.length / 1024).toFixed(0)} KB`);
  }
  return out;
}

// ---------------------------------------------------------------- fill, check, print

function fill(template, vars) {
  let html = template
    .replace(/\{\{\{(\w+)\}\}\}/g, (m, k) => { if (!(k in vars)) throw new Error(`no value for {{{${k}}}}`); return String(vars[k]); })
    .replace(/\{\{(\w+)\}\}/g, (m, k) => { if (!(k in vars)) throw new Error(`no value for {{${k}}}`); return esc(vars[k]); });
  // page numbers: the n-th slide that carries __PN__ gets "NN / TOTAL"
  const two = (n) => String(n).padStart(2, '0');
  const sections = html.split(/(?=<section class="slide)/);
  const total = sections.length - 1;
  html = sections.map((s, i) => s.replace(/__PN__/g, `${two(i)} / ${two(total)}`)).join('');
  const left = html.match(/\{\{|__PN__|【|】/);
  if (left) throw new Error(`placeholder left in the deck near: ${html.slice(Math.max(0, left.index - 60), left.index + 60)}`);
  return html;
}

const CHECK = `(async () => {
  await document.fonts.ready;
  const fontsWanted = ['900 100px "Noto Serif TC"', '700 100px "Noto Serif"', '500 30px "Inter"', '500 30px "IBM Plex Mono"'];
  await Promise.all(fontsWanted.map(f => document.fonts.load(f, 'Hongbao 紅包恭喜發財福 0123').catch(() => null)));
  await document.fonts.ready;
  const missingFonts = fontsWanted.filter(f => !document.fonts.check(f, 'Hongbao 0'));
  const imgs = [...document.images];
  await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; })));
  const problems = [];
  const slides = [...document.querySelectorAll('.slide')];
  slides.forEach((slide, n) => {
    const where = 'slide ' + (n + 1);
    const sr = slide.getBoundingClientRect();
    if (Math.round(sr.width) !== 1920 || Math.round(sr.height) !== 1080) problems.push(where + ': slide is ' + sr.width + 'x' + sr.height);
    for (const el of slide.querySelectorAll('*')) {
      if (el.closest('[data-bleed]')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const label = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') + ' "' + (el.textContent || '').trim().slice(0, 40) + '"';
      if (r.left < sr.left - 1 || r.right > sr.right + 1 || r.top < sr.top - 1 || r.bottom > sr.bottom + 1) problems.push(where + ': outside the slide: ' + label);
      if (el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== 'visible' && el.clientWidth > 0) problems.push(where + ': clipped horizontally: ' + label);
      if (el.scrollHeight > el.clientHeight + 2 && cs.overflowY !== 'visible' && el.clientHeight > 0 && el !== slide) problems.push(where + ': clipped vertically: ' + label);
      const own = [...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim());
      if (own && parseFloat(cs.fontSize) < 20) problems.push(where + ': text under 20px (' + cs.fontSize + '): ' + label);
    }
    if (slide.scrollHeight > slide.clientHeight + 1 || slide.scrollWidth > slide.clientWidth + 1) problems.push(where + ': content overflows the slide (' + slide.scrollWidth + 'x' + slide.scrollHeight + ')');
    // padding keeps a safe margin: flow content must end above the footer
    const foot = slide.querySelector('.foot');
    if (foot) {
      const fr = foot.getBoundingClientRect();
      for (const el of slide.querySelectorAll(':scope > :not(.foot), .product-text, .phones, .demand-text, .demand-phone')) { const r = el.getBoundingClientRect(); if (r.bottom > fr.top - 8 && r.right > fr.left && r.left < fr.right && !el.closest('[data-bleed]')) problems.push(where + ': runs into the footer: ' + el.tagName.toLowerCase() + ' "' + el.textContent.trim().slice(0, 40) + '"'); }
    }
  });
  for (const i of imgs) if (!i.naturalWidth) problems.push('image failed to load: ' + i.getAttribute('src'));
  return { slides: slides.length, problems, missingFonts };
})()`;

async function main() {
  const t0 = Date.now();
  const { chains, proof } = await loadData();
  const contractTests = countContractTests();
  const testnet = chains.find((c) => c.id === 31611) || chains[0];
  const ledgerUrl = `${SITE}/ledger`;
  const caps = mainnetCaps();
  const kit = gasKit();
  const extraRows = extraLinkRows();

  const browser = await launchChrome();
  try {
    const img = await prepareShots(browser);
    const traction = tractionHtml(chains, ledgerUrl);
    const vars = {
      liveUrl: SITE, liveHost: SITE.replace(/^https?:\/\//, ''),
      ledgerUrl, ledgerHost: ledgerUrl.replace(/^https?:\/\//, ''),
      repoUrl: FACTS.repo, repoHost: FACTS.repo.replace(/^https?:\/\//, ''),
      contract: testnet.address, contractShort: short(testnet.address),
      contractUrl: `${testnet.explorer}/address/${testnet.address}`,
      contractTests, appTests: FACTS.appTests, reviewPasses: FACTS.reviewPasses,
      capPacket: fmtInt(caps.soft.perPacket), capSender: fmtInt(caps.soft.perSender), capTotal: fmtInt(caps.soft.total),
      hardPacket: fmtInt(caps.hard.perPacket), hardSender: fmtInt(caps.hard.perSender), hardTotal: fmtInt(caps.hard.total),
      kitBtc: kit.kit, dripBtc: kit.drip, tipBtc: kit.tip,
      ...proofTxs(proof),
      imgCover: img['cover-opened-zh'], imgSend: img.send, imgClaim: img.claim, imgOpened: img.opened, imgNext: img.next,
      traction: traction.html, tractionSource: traction.source, proofUrl: traction.sourceUrl,
      contractRows: contractRows(chains),
      codeNote: licenseNote(),
      extraRows: extraRows.join('\n'), linkListClass: extraRows.length ? ' two' : '',
    };
    const html = fill(readFileSync(join(DECK, 'deck.html'), 'utf8'), vars);
    writeFileSync(OUT_HTML, html);
    log('wrote', OUT_HTML.replace(ROOT + '/', ''));

    const page = await browser.page(1920, 1080);
    await page.goto(pathToFileURL(OUT_HTML).href);
    const res = await page.evaluate(CHECK);
    if (res.missingFonts.length) warn(`web fonts not loaded (offline?): ${res.missingFonts.join(', ')}; fallbacks used`);
    for (const p of res.problems) warn(p);
    log(`${res.slides} slides checked, ${res.problems.length} layout problems`);

    if (PNG_DIR) {
      const dir = resolve(process.cwd(), PNG_DIR); mkdirSync(dir, { recursive: true });
      const ys = await page.evaluate(`[...document.querySelectorAll('.slide')].map(s => s.getBoundingClientRect().top + scrollY)`);
      for (let i = 0; i < ys.length; i++) {
        const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: ys[i], width: 1920, height: 1080, scale: 1 } });
        writeFileSync(join(dir, `slide-${String(i + 1).padStart(2, '0')}.png`), Buffer.from(data, 'base64'));
      }
      log(`${ys.length} slide PNGs in ${dir}`);
    }

    if (!flag('--no-pdf')) {
      await page.send('Emulation.setEmulatedMedia', { media: 'print' });
      const { data } = await page.send('Page.printToPDF', {
        printBackground: true, preferCSSPageSize: true, paperWidth: 20, paperHeight: 11.25,
        marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0, scale: 1, displayHeaderFooter: false,
        generateDocumentOutline: false, generateTaggedPDF: false,
      });
      const pdf = Buffer.from(data, 'base64');
      writeFileSync(OUT_PDF, pdf);
      const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      log(`wrote ${OUT_PDF.replace(ROOT + '/', '')}: ${pages} pages, ${(pdf.length / 1048576).toFixed(2)} MB`);
      if (pages !== res.slides) warn(`PDF has ${pages} pages for ${res.slides} slides`);
      if (pdf.length > 8 * 1048576) warn('PDF is over 8 MB');
    }
  } finally {
    browser.close();
  }
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${warnings.length} warnings`);
  if (flag('--strict') && warnings.length) process.exit(1);
}

main().catch((e) => { console.error('[deck] FAILED', e.message); process.exit(1); });
