#!/usr/bin/env node
// Collect on-chain evidence for Hongbao into docs/PROOF.md and docs/proof.json.
//   node ops/proof.mjs [chainId ...]        (default: every chain with a deployment)
// Reads config/deployments.json and config/team-wallets.json. Read-only: it only calls public RPCs.
// Env overrides (e.g. to point at a local fork): HONGBAO_<chainId>, DEPLOY_BLOCK_<chainId>,
// RPC_<chainId> (comma list = fallbacks).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "web", "package.json"));
const { createPublicClient, fallback, http, formatUnits, getAddress, isAddress } = require("viem");

const CHAINS = {
  31611: { name: "Mezo testnet", rpc: ["https://rpc.test.mezo.org"], explorer: "https://explorer.test.mezo.org", gauge: "0xA6972f35550717280f2538EA77638B29073e3F07", borrowerOperations: "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5" },
  31612: { name: "Mezo mainnet", rpc: ["https://mainnet.mezo.public.validationcloud.io", "https://rpc-http.mezo.boar.network"], explorer: "https://explorer.mezo.org", gauge: "0x677817bF3e44b90E8F95222F75e2950b7904a401", borrowerOperations: "0x44b1bac67dDA612a41a58AAf779143B181dEe031" },
};
const PAYOUT = ["Earn MEZO (staked)", "Save (sMUSD)", "Cash (MUSD)"];
const FUNDING = ["MUSD", "BTC"];
// Mezo RPCs refuse eth_getLogs when toBlock - fromBlock > 10,000 (same window as web/functions/_lib/chains.ts).
const LOG_WINDOW = 9_999n;

// Event definitions come from the contract's own ABI, so they cannot drift from Hongbao.sol.
const abi = JSON.parse(readFileSync(join(ROOT, "shared/Hongbao.abi.json"), "utf8"));
const EVENTS = ["PacketCreated", "Claimed", "Refunded"].map((name) => {
  const ev = abi.find((x) => x.type === "event" && x.name === name);
  if (!ev) throw new Error(`event ${name} missing from shared/Hongbao.abi.json`);
  return ev;
});

const deployments = JSON.parse(readFileSync(join(ROOT, "config/deployments.json"), "utf8"));
const team = new Set(JSON.parse(readFileSync(join(ROOT, "config/team-wallets.json"), "utf8")).wallets.map((w) => getAddress(w.address)));
const tag = (a) => (team.has(getAddress(a)) ? "team" : "outside");
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const musd = (v) => Number(formatUnits(v, 18)).toFixed(2);
const fail = (msg) => {
  console.error(`${msg} docs/ left unchanged.`);
  process.exit(1);
};

function deploymentFor(chainId) {
  const d = deployments[chainId] ?? {};
  const env = (k) => (process.env[`${k}_${chainId}`] ?? "").trim();
  const hongbao = env("HONGBAO") || d.hongbao || null;
  if (hongbao && !isAddress(hongbao, { strict: false })) fail(`Hongbao address for chain ${chainId} is not an address.`);
  const block = env("DEPLOY_BLOCK") || (d.deployBlock ?? "");
  if (String(block) !== "" && !/^\d+$/.test(String(block))) fail(`Deploy block for chain ${chainId} is not a block number.`);
  const rpc = env("RPC").split(",").map((s) => s.trim()).filter((s) => /^https?:\/\/\S+$/i.test(s));
  return {
    hongbao: hongbao ? getAddress(hongbao) : null,
    deployBlock: String(block) === "" ? null : BigInt(block),
    rpc: rpc.length ? rpc : CHAINS[chainId]?.rpc ?? [],
  };
}

/** All three events in one eth_getLogs call per window, windows read in order. */
async function getLogsChunked(client, address, from, to) {
  const out = [];
  for (let b = from; b <= to; b += LOG_WINDOW + 1n) {
    const end = b + LOG_WINDOW > to ? to : b + LOG_WINDOW;
    out.push(...(await client.getLogs({ address, events: EVENTS, fromBlock: b, toBlock: end, strict: true })));
  }
  return out.filter((l) => !l.removed);
}

const want = process.argv.slice(2).map(Number);
const report = { generatedAt: new Date().toISOString(), chains: {} };
let md = `# Hongbao on-chain evidence\n\nGenerated ${report.generatedAt} by \`ops/proof.mjs\` from public RPCs. Team wallets are listed in \`config/team-wallets.json\`; every other address is tagged outside.\n`;

for (const id of Object.keys(CHAINS)) {
  const chainId = Number(id);
  if (want.length && !want.includes(chainId)) continue;
  const d = deploymentFor(chainId);
  if (!d.hongbao) continue;
  const c = CHAINS[chainId];
  if (d.deployBlock === null) {
    fail(`${c.name}: no deploy block. Set deployBlock in config/deployments.json or DEPLOY_BLOCK_${chainId}; scanning from block 0 takes thousands of requests.`);
  }
  const opts = { timeout: 30_000, batch: { batchSize: 50 } };
  const client = createPublicClient({
    transport: d.rpc.length > 1 ? fallback(d.rpc.map((u) => http(u, opts))) : http(d.rpc[0], opts),
  });
  const rpcChain = await client.getChainId();
  if (rpcChain !== chainId) fail(`${c.name}: the RPC answers chain id ${rpcChain}, expected ${chainId}.`);
  const head = await client.getBlockNumber();
  const from = d.deployBlock;
  const logs = await getLogsChunked(client, d.hongbao, from, head);
  const cr = logs.filter((l) => l.eventName === "PacketCreated");
  const cl = logs.filter((l) => l.eventName === "Claimed");
  const rf = logs.filter((l) => l.eventName === "Refunded");

  const recipients = [...new Set(cl.map((l) => getAddress(l.args.recipient)))];
  // Did each recipient later sign a transaction of their own? A claim the recipient submitted
  // itself (relayer == recipient) raises its nonce too, so it does not count.
  const nonces = Object.fromEntries(await Promise.all(recipients.map(async (r) => [r, await client.getTransactionCount({ address: r })])));
  const selfClaims = {};
  for (const l of cl) {
    const r = getAddress(l.args.recipient);
    if (getAddress(l.args.relayer) === r) selfClaims[r] = (selfClaims[r] ?? 0) + 1;
  }
  const ownTx = (r) => nonces[r] - (selfClaims[r] ?? 0) > 0;
  const senders = [...new Set(cr.map((l) => getAddress(l.args.sender)))];
  const outsideSenders = senders.filter((s) => tag(s) === "outside");
  const outsideRecipients = recipients.filter((r) => tag(r) === "outside");
  const actedOnOwn = outsideRecipients.filter(ownTx);
  const vol = cr.reduce((s, l) => s + l.args.net, 0n);
  const byPayout = [0, 1, 2].map((p) => cl.filter((l) => Number(l.args.payout) === p).length);

  // A packet funded from the sender's Mezo loan: the app sends BorrowerOperations.withdrawMUSD from the sender's wallet
  // just before the create transaction. Look for that call in the 40 blocks up to the packet's block.
  const WITHDRAW_MUSD = "0xaf8b4fd0"; // withdrawMUSD(uint256,address,address)
  const loanTx = {};
  for (const l of cr) {
    if (Number(l.args.funding) !== 0) continue;
    const sender = getAddress(l.args.sender);
    const topic = "0x" + sender.slice(2).toLowerCase().padStart(64, "0");
    const bo = await client.request({ method: "eth_getLogs", params: [{ address: c.borrowerOperations, topics: [null, topic],
      fromBlock: "0x" + (l.blockNumber > 40n ? l.blockNumber - 40n : 0n).toString(16), toBlock: "0x" + l.blockNumber.toString(16) }] });
    for (const h of [...new Set(bo.map((x) => x.transactionHash))].reverse()) {
      let tx = null; // load-balanced RPC nodes sometimes miss a fresh tx; retry
      for (let i = 0; i < 4 && !tx; i++) tx = await client.request({ method: "eth_getTransactionByHash", params: [h] }).catch(() => null) ?? (await new Promise((r) => setTimeout(r, 1500)), null);
      if (!tx) continue;
      if (getAddress(tx.from) === sender && tx.input.slice(0, 10).toLowerCase() === WITHDRAW_MUSD) { loanTx[l.transactionHash] = h; break; }
    }
  }

  const summary = {
    contract: d.hongbao, fromBlock: Number(from), toBlock: Number(head),
    packets: cr.length, claims: cl.length, refunds: rf.length, musdIntoPackets: musd(vol),
    senders: senders.length, outsideSenders: outsideSenders.length,
    recipients: recipients.length, outsideRecipients: outsideRecipients.length,
    outsideRecipientsWhoSignedOwnTx: actedOnOwn.length, claimsByPayout: { stake: byPayout[0], save: byPayout[1], cash: byPayout[2] },
    fundedWithBTC: cr.filter((l) => Number(l.args.funding) === 1).length,
    fundedFromMezoLoan: Object.keys(loanTx).length,
  };
  report.chains[chainId] = { summary, packets: cr.map((l) => ({ id: String(l.args.id), sender: l.args.sender, tag: tag(l.args.sender), net: musd(l.args.net), shares: l.args.shares, funding: loanTx[l.transactionHash] ? "Mezo loan" : FUNDING[Number(l.args.funding)], loanTx: loanTx[l.transactionHash] ?? null, tx: l.transactionHash })),
    claims: cl.map((l) => ({ id: String(l.args.id), recipient: l.args.recipient, tag: tag(l.args.recipient), relayer: l.args.relayer, amount: musd(l.args.amount), payout: PAYOUT[Number(l.args.payout)], signedOwnTx: ownTx(getAddress(l.args.recipient)), tx: l.transactionHash })),
    refunds: rf.map((l) => ({ id: String(l.args.id), to: l.args.to, amount: musd(l.args.amount), inKind: l.args.inKind, tx: l.transactionHash })) };

  const x = (h) => `[${h.slice(0, 10)}…](${c.explorer}/tx/${h})`;
  const a = (h) => `[${short(h)}](${c.explorer}/address/${h})`;
  md += `\n## ${c.name}\n\nContract ${a(d.hongbao)}, blocks ${from} to ${head}\n\n| | |\n|---|---|\n`;
  md += `| Packets | ${summary.packets} (${summary.fundedWithBTC} funded with BTC, ${summary.fundedFromMezoLoan} from a Mezo loan) |\n| MUSD put into packets | ${summary.musdIntoPackets} |\n`;
  md += `| Claims | ${summary.claims} (staked ${byPayout[0]}, saved ${byPayout[1]}, cash ${byPayout[2]}) |\n| Refunds | ${summary.refunds} |\n`;
  md += `| Distinct senders | ${summary.senders} (outside: ${summary.outsideSenders}) |\n| Distinct recipients | ${summary.recipients} (outside: ${summary.outsideRecipients}) |\n`;
  md += `| Outside recipients who later signed their own transaction | ${summary.outsideRecipientsWhoSignedOwnTx} |\n`;
  md += `\n### Packets\n\n| # | Sender | Net MUSD | Shares | Funding | Tx |\n|---|---|---|---|---|---|\n`;
  for (const p of report.chains[chainId].packets) md += `| ${p.id} | ${a(p.sender)} ${p.tag} | ${p.net} | ${p.shares} | ${p.loanTx ? `Mezo loan (withdrawMUSD ${x(p.loanTx)})` : p.funding} | ${x(p.tx)} |\n`;
  md += `\n### Claims\n\n| # | Recipient | MUSD | Received as | Signed own tx later | Tx |\n|---|---|---|---|---|---|\n`;
  for (const q of report.chains[chainId].claims) md += `| ${q.id} | ${a(q.recipient)} ${q.tag} | ${q.amount} | ${q.payout} | ${q.signedOwnTx ? "yes" : "no"} | ${x(q.tx)} |\n`;
  if (rf.length) {
    md += `\n### Refunds\n\n| # | To | MUSD | In kind | Tx |\n|---|---|---|---|---|\n`;
    for (const r of report.chains[chainId].refunds) md += `| ${r.id} | ${a(r.to)} | ${r.amount} | ${r.inKind ? "yes" : "no"} | ${x(r.tx)} |\n`;
  }
  console.log(c.name, JSON.stringify(summary));
}

// Never replace earlier evidence with an empty report.
if (!Object.keys(report.chains).length) {
  fail(`No chain to report${want.length ? ` among ${want.join(", ")}` : ""}: set a Hongbao address in config/deployments.json or HONGBAO_<chainId>.`);
}
writeFileSync(join(ROOT, "docs/PROOF.md"), md);
writeFileSync(join(ROOT, "docs/proof.json"), JSON.stringify(report, null, 2));
console.log("wrote docs/PROOF.md and docs/proof.json");
