#!/usr/bin/env node
// Collect on-chain evidence for Hongbao into docs/PROOF.md and docs/proof.json.
//   node ops/proof.mjs [chainId ...]        (default: every chain with a deployment)
// Reads config/deployments.json and config/team-wallets.json. Read-only: it only calls public RPCs.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "web", "package.json"));
const { createPublicClient, http, parseAbiItem, formatUnits, getAddress } = require("viem");

const CHAINS = {
  31611: { name: "Mezo testnet", rpc: "https://rpc.test.mezo.org", explorer: "https://explorer.test.mezo.org", gauge: "0xA6972f35550717280f2538EA77638B29073e3F07" },
  31612: { name: "Mezo mainnet", rpc: "https://mainnet.mezo.public.validationcloud.io", explorer: "https://explorer.mezo.org", gauge: "0x677817bF3e44b90E8F95222F75e2950b7904a401" },
};
const PAYOUT = ["Earn MEZO (staked)", "Save (sMUSD)", "Cash (MUSD)"];
const FUNDING = ["MUSD", "BTC"];

const created = parseAbiItem("event PacketCreated(uint256 indexed id, address indexed sender, uint256 net, uint256 fee, uint32 shares, uint64 expiry, uint8 funding, address claimKey, address attester, string message)");
const claimedEv = parseAbiItem("event Claimed(uint256 indexed id, address indexed recipient, address indexed relayer, uint256 amount, uint8 payout)");
const refunded = parseAbiItem("event Refunded(uint256 indexed id, address indexed to, uint256 amount, uint256 btcReturned, bool inKind)");

const deployments = JSON.parse(readFileSync(join(ROOT, "config/deployments.json"), "utf8"));
const team = new Set(JSON.parse(readFileSync(join(ROOT, "config/team-wallets.json"), "utf8")).wallets.map((w) => getAddress(w.address)));
const tag = (a) => (team.has(getAddress(a)) ? "team" : "outside");
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const musd = (v) => Number(formatUnits(v, 18)).toFixed(2);

async function getLogsChunked(client, address, event, from, to) {
  const out = [];
  const step = 50_000n;
  for (let b = from; b <= to; b += step) {
    const end = b + step - 1n > to ? to : b + step - 1n;
    out.push(...(await client.getLogs({ address, event, fromBlock: b, toBlock: end })));
  }
  return out;
}

const want = process.argv.slice(2).map(Number);
const report = { generatedAt: new Date().toISOString(), chains: {} };
let md = `# Hongbao on-chain evidence\n\nGenerated ${report.generatedAt} by \`ops/proof.mjs\` from public RPCs. Team wallets are listed in \`config/team-wallets.json\`; every other address is tagged outside.\n`;

for (const [id, d] of Object.entries(deployments)) {
  const chainId = Number(id);
  if (!d.hongbao || (want.length && !want.includes(chainId))) continue;
  const c = CHAINS[chainId];
  const client = createPublicClient({ transport: http(c.rpc) });
  const head = await client.getBlockNumber();
  const from = BigInt(d.deployBlock ?? 0);
  const [cr, cl, rf] = await Promise.all([
    getLogsChunked(client, d.hongbao, created, from, head),
    getLogsChunked(client, d.hongbao, claimedEv, from, head),
    getLogsChunked(client, d.hongbao, refunded, from, head),
  ]);

  const recipients = [...new Set(cl.map((l) => getAddress(l.args.recipient)))];
  // Did each recipient later sign a transaction of their own (nonce > 0)?
  const nonces = Object.fromEntries(await Promise.all(recipients.map(async (r) => [r, await client.getTransactionCount({ address: r })])));
  const senders = [...new Set(cr.map((l) => getAddress(l.args.sender)))];
  const outsideSenders = senders.filter((s) => tag(s) === "outside");
  const outsideRecipients = recipients.filter((r) => tag(r) === "outside");
  const actedOnOwn = outsideRecipients.filter((r) => nonces[r] > 0);
  const vol = cr.reduce((s, l) => s + l.args.net, 0n);
  const byPayout = [0, 1, 2].map((p) => cl.filter((l) => Number(l.args.payout) === p).length);

  const summary = {
    contract: d.hongbao, packets: cr.length, claims: cl.length, refunds: rf.length, musdIntoPackets: musd(vol),
    senders: senders.length, outsideSenders: outsideSenders.length,
    recipients: recipients.length, outsideRecipients: outsideRecipients.length,
    outsideRecipientsWhoSignedOwnTx: actedOnOwn.length, claimsByPayout: { stake: byPayout[0], save: byPayout[1], cash: byPayout[2] },
    fundedWithBTC: cr.filter((l) => Number(l.args.funding) === 1).length,
  };
  report.chains[chainId] = { summary, packets: cr.map((l) => ({ id: String(l.args.id), sender: l.args.sender, tag: tag(l.args.sender), net: musd(l.args.net), shares: l.args.shares, funding: FUNDING[Number(l.args.funding)], tx: l.transactionHash })),
    claims: cl.map((l) => ({ id: String(l.args.id), recipient: l.args.recipient, tag: tag(l.args.recipient), relayer: l.args.relayer, amount: musd(l.args.amount), payout: PAYOUT[Number(l.args.payout)], signedOwnTx: nonces[getAddress(l.args.recipient)] > 0, tx: l.transactionHash })),
    refunds: rf.map((l) => ({ id: String(l.args.id), to: l.args.to, amount: musd(l.args.amount), inKind: l.args.inKind, tx: l.transactionHash })) };

  const x = (h) => `[${h.slice(0, 10)}…](${c.explorer}/tx/${h})`;
  const a = (h) => `[${short(h)}](${c.explorer}/address/${h})`;
  md += `\n## ${c.name}\n\nContract ${a(d.hongbao)}\n\n| | |\n|---|---|\n`;
  md += `| Packets | ${summary.packets} (${summary.fundedWithBTC} funded with BTC) |\n| MUSD put into packets | ${summary.musdIntoPackets} |\n`;
  md += `| Claims | ${summary.claims} (staked ${byPayout[0]}, saved ${byPayout[1]}, cash ${byPayout[2]}) |\n| Refunds | ${summary.refunds} |\n`;
  md += `| Distinct senders | ${summary.senders} (outside: ${summary.outsideSenders}) |\n| Distinct recipients | ${summary.recipients} (outside: ${summary.outsideRecipients}) |\n`;
  md += `| Outside recipients who later signed their own transaction | ${summary.outsideRecipientsWhoSignedOwnTx} |\n`;
  md += `\n### Packets\n\n| # | Sender | Net MUSD | Shares | Funding | Tx |\n|---|---|---|---|---|---|\n`;
  for (const p of report.chains[chainId].packets) md += `| ${p.id} | ${a(p.sender)} ${p.tag} | ${p.net} | ${p.shares} | ${p.funding} | ${x(p.tx)} |\n`;
  md += `\n### Claims\n\n| # | Recipient | MUSD | Received as | Signed own tx later | Tx |\n|---|---|---|---|---|---|\n`;
  for (const q of report.chains[chainId].claims) md += `| ${q.id} | ${a(q.recipient)} ${q.tag} | ${q.amount} | ${q.payout} | ${q.signedOwnTx ? "yes" : "no"} | ${x(q.tx)} |\n`;
  if (rf.length) {
    md += `\n### Refunds\n\n| # | To | MUSD | In kind | Tx |\n|---|---|---|---|---|\n`;
    for (const r of report.chains[chainId].refunds) md += `| ${r.id} | ${a(r.to)} | ${r.amount} | ${r.inKind ? "yes" : "no"} | ${x(r.tx)} |\n`;
  }
  console.log(c.name, JSON.stringify(summary));
}

writeFileSync(join(ROOT, "docs/PROOF.md"), md);
writeFileSync(join(ROOT, "docs/proof.json"), JSON.stringify(report, null, 2));
console.log("wrote docs/PROOF.md and docs/proof.json");
