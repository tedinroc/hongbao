#!/usr/bin/env node
// Return expired Hongbao packets to their senders.
//
//   node ops/keeper.mjs [chainId ...] [--send] [--from-id N] [--max N]
//
// Lists every packet that is past its expiry, not refunded, and still holds MUSD
// (remaining > 0). That is all it does by default: a dry run sends nothing.
// With --send it calls refund(id) for each listed packet from the key in the
// RELAYER_PRIVATE_KEY environment variable. After expiry anyone may call refund;
// the contract pays the MUSD and the unused BTC gas kits to the packet's sender,
// never to the caller, so the keeper only spends gas.
//
// Chains: every chain with a Hongbao address (default) or the chain ids given.
// Config comes from config/deployments.json; these env vars override it:
//   HONGBAO_<chainId>   Hongbao address        RPC_<chainId>  RPC URL (comma list = fallbacks)
// Options:
//   --from-id N   start at packet N (default 1)
//   --max N       refund at most N packets in this run (with --send)
// MAX_FEE_PER_GAS_WEI caps the fee per gas the keeper pays (default 1 gwei; Mezo is ~1e6 wei).
// The key is read from the environment only and never printed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "web", "package.json"));
const {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, defineChain, fallback,
  formatUnits, getAddress, http, isAddress, parseEventLogs,
} = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const CHAINS = {
  31611: { name: "Mezo testnet", rpc: ["https://rpc.test.mezo.org"], explorer: "https://explorer.test.mezo.org" },
  31612: {
    name: "Mezo mainnet",
    rpc: ["https://mainnet.mezo.public.validationcloud.io", "https://rpc-http.mezo.boar.network"],
    explorer: "https://explorer.mezo.org",
  },
};
const abi = JSON.parse(readFileSync(join(ROOT, "shared/Hongbao.abi.json"), "utf8"));
const deployments = JSON.parse(readFileSync(join(ROOT, "config/deployments.json"), "utf8"));

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: node ops/keeper.mjs [chainId ...] [--send] [--from-id N] [--max N]");
  process.exit(2);
}

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
let send = false;
let fromId = 1n;
let max = Infinity;
const want = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--send") send = true;
  else if (a === "--from-id" || a === "--max") {
    const v = args[++i];
    if (!/^\d{1,18}$/.test(v ?? "")) usage(`${a} needs a whole number`);
    if (a === "--from-id") fromId = BigInt(v) > 0n ? BigInt(v) : 1n;
    else max = Number(v);
  } else if (a === "-h" || a === "--help") usage();
  else if (/^\d+$/.test(a) && CHAINS[a]) want.push(Number(a));
  else usage(`unknown argument: ${a}`);
}

const fmt = (wei, d = 2) => Number(formatUnits(wei, 18)).toFixed(d);
const iso = (sec) => new Date(Number(sec) * 1000).toISOString().replace(".000Z", "Z");
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function hongbaoFor(chainId) {
  const raw = (process.env[`HONGBAO_${chainId}`] ?? "").trim() || deployments[chainId]?.hongbao || "";
  if (!raw) return null;
  if (!isAddress(raw, { strict: false })) throw new Error(`Hongbao address for chain ${chainId} is not an address`);
  return getAddress(raw);
}

function rpcFor(chainId) {
  const raw = (process.env[`RPC_${chainId}`] ?? "").split(",").map((s) => s.trim()).filter((s) => /^https?:\/\/\S+$/i.test(s));
  return raw.length ? raw : CHAINS[chainId].rpc;
}

function errorName(e) {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r?.data?.errorName) return r.data.errorName;
    return e.shortMessage;
  }
  return String(e?.message ?? e).slice(0, 160);
}

let key = null;
if (send) {
  const raw = (process.env.RELAYER_PRIVATE_KEY ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) usage("--send needs RELAYER_PRIVATE_KEY (0x + 64 hex) in the environment");
  key = raw;
}
const maxFee = BigInt(/^\d{1,20}$/.test(process.env.MAX_FEE_PER_GAS_WEI ?? "") ? process.env.MAX_FEE_PER_GAS_WEI : "1000000000");

// ---------------------------------------------------------------- main
let failures = 0;
const chainIds = (want.length ? want : Object.keys(CHAINS).map(Number)).filter((id) => want.length || hongbaoFor(id));
if (!chainIds.length) usage("no chain has a Hongbao address (config/deployments.json or HONGBAO_<chainId>)");

for (const chainId of chainIds) {
  const c = CHAINS[chainId];
  const hongbao = hongbaoFor(chainId);
  if (!hongbao) {
    console.error(`${c.name} (${chainId}): no Hongbao address; skipped`);
    failures++;
    continue;
  }
  const urls = rpcFor(chainId);
  const opts = { timeout: 20_000, batch: { batchSize: 50 } };
  const transport = urls.length > 1 ? fallback(urls.map((u) => http(u, opts))) : http(urls[0], opts);
  const chain = defineChain({
    id: chainId,
    name: c.name,
    nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
    rpcUrls: { default: { http: urls } },
  });
  const client = createPublicClient({ chain, transport, pollingInterval: 1_000 });

  const rpcChain = await client.getChainId();
  if (rpcChain !== chainId) {
    console.error(`${c.name}: the RPC answers chain id ${rpcChain}, expected ${chainId}; skipped`);
    failures++;
    continue;
  }
  const [count, block] = await Promise.all([
    client.readContract({ address: hongbao, abi, functionName: "packetCount" }),
    client.getBlock({ blockTag: "latest" }),
  ]);
  console.log(`${c.name} (${chainId}) Hongbao ${hongbao}: ${count} packets, block ${block.number} at ${iso(block.timestamp)}`);

  // Read every packet from --from-id on, 100 ids per round of batched calls.
  const due = [];
  for (let start = fromId; start <= count; start += 100n) {
    const ids = [];
    for (let id = start; id < start + 100n && id <= count; id++) ids.push(id);
    const packets = await Promise.all(ids.map((id) => client.readContract({ address: hongbao, abi, functionName: "getPacket", args: [id] })));
    packets.forEach((p, i) => {
      if (!p.refunded && p.remaining > 0n && block.timestamp >= p.expiry) due.push({ id: ids[i], ...p });
    });
  }

  if (!due.length) {
    console.log("  no expired packets hold money");
    continue;
  }
  let musd = 0n;
  let kitsTotal = 0n;
  console.log(`  ${due.length} expired packet(s) still hold money:`);
  for (const p of due) {
    const kits = BigInt(p.sharesLeft) * (p.dripPerShare + p.tipPerShare);
    musd += p.remaining;
    kitsTotal += kits;
    console.log(
      `  #${p.id}  sender ${short(p.sender)}  expired ${iso(p.expiry)}  ${p.sharesLeft} of ${p.sharesTotal} shares left  ` +
        `${fmt(p.remaining)} MUSD  ${fmt(kits, 6)} BTC in gas kits`,
    );
  }
  console.log(`  total ${fmt(musd)} MUSD and ${fmt(kitsTotal, 6)} BTC would go back to their senders`);

  if (!send) {
    console.log("  dry run: nothing sent. Run again with --send and RELAYER_PRIVATE_KEY set to refund them.");
    continue;
  }

  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ chain, account, transport });
  console.log(`  refunding from ${account.address} (balance ${fmt(await client.getBalance({ address: account.address }), 8)} BTC)`);
  let done = 0;
  for (const p of due) {
    if (done >= max) {
      console.log(`  stopped after --max ${max}; ${due.length - done} left for the next run`);
      break;
    }
    try {
      // Simulate first: a packet someone refunded a moment ago reverts PacketClosed here, not on chain.
      const { request } = await client.simulateContract({ account, address: hongbao, abi, functionName: "refund", args: [p.id] });
      const estimate = await client.estimateContractGas({ account, address: hongbao, abi, functionName: "refund", args: [p.id] });
      const gas = (estimate * 13n) / 10n;
      let fees;
      try {
        const f = await client.estimateFeesPerGas();
        fees = { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
      } catch {
        fees = { gasPrice: await client.getGasPrice() };
      }
      const perGas = fees.maxFeePerGas ?? fees.gasPrice;
      if (perGas > maxFee) {
        console.log(`  #${p.id} skipped: the network asks ${perGas} wei per gas, above MAX_FEE_PER_GAS_WEI ${maxFee}`);
        failures++;
        break;
      }
      const hash = await wallet.writeContract({ ...request, gas, ...fees });
      const rc = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (rc.status !== "success") throw new Error(`transaction ${hash} reverted`);
      const ev = parseEventLogs({ abi, logs: rc.logs, eventName: "Refunded" })[0];
      const what = ev
        ? `${fmt(ev.args.amount)} ${ev.args.inKind ? "sMUSD (in kind)" : "MUSD"} and ${fmt(ev.args.btcReturned, 6)} BTC to ${short(ev.args.to)}`
        : "no Refunded event";
      console.log(`  #${p.id} refunded: ${what}  ${c.explorer}/tx/${hash}`);
      done++;
    } catch (e) {
      const why = errorName(e);
      if (why === "PacketClosed") {
        console.log(`  #${p.id} skipped: someone refunded it a moment ago`);
        continue;
      }
      console.log(`  #${p.id} not refunded: ${why}`);
      failures++;
    }
  }
  console.log(`  refunded ${done} of ${due.length}`);
}

process.exit(failures ? 1 : 0);
