/**
 * End-to-end test of the Hongbao relayer/attester against an anvil fork of Mezo testnet.
 * Run through scripts/e2e-fork.sh (which starts anvil and deploys Hongbao), or by hand:
 *
 *   E2E_RPC=http://127.0.0.1:8545 E2E_HONGBAO=0x... E2E_DEPLOY_BLOCK=123 \
 *     node scripts/lib/run-ts.mjs scripts/e2e/fork-e2e.ts
 *
 * E2E_MODE=direct (default) imports the Pages Functions handlers and calls them with
 * constructed Requests. E2E_MODE=http runs a smaller suite over HTTP against
 * `wrangler pages dev` at E2E_BASE (real Workers runtime).
 *
 * Accounts: anvil's default mnemonic only. Keys are never printed.
 */
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  getAddress,
  hashDomain,
  hashTypedData,
  http,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  parseEventLogs,
  parseSignature,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { hongbaoAbi } from "../../web/functions/_lib/abi";
import { CHAINS, MEZO } from "../../web/functions/_lib/chains";
import { ATTEST_TYPES, CLAIM_TYPES, hongbaoDomain } from "../../web/functions/_lib/eip712";
import type { Env } from "../../web/functions/_lib/env";
import { decodeRevert } from "../../web/functions/_lib/errors";
import { handleClaim } from "../../web/functions/api/claim";
import { handleConfig } from "../../web/functions/api/config";
import { handlePacket } from "../../web/functions/api/packet";
import { handleStats } from "../../web/functions/api/stats";

// ---------------------------------------------------------------- setup

const RPC = process.env.E2E_RPC ?? "";
const HONGBAO_RAW = process.env.E2E_HONGBAO ?? "";
const DEPLOY_BLOCK = process.env.E2E_DEPLOY_BLOCK ?? "";
const MODE = (process.env.E2E_MODE ?? "direct") as "direct" | "http";
const BASE = (process.env.E2E_BASE ?? "").replace(/\/$/, "");
if (!RPC || !/^0x[0-9a-fA-F]{40}$/.test(HONGBAO_RAW)) {
  console.error("E2E_RPC and E2E_HONGBAO are required");
  process.exit(2);
}
const HONGBAO: Address = getAddress(HONGBAO_RAW);
if (MODE === "http" && !BASE) {
  console.error("E2E_BASE is required in http mode");
  process.exit(2);
}

const CHAIN_ID = 31611 as const;
const M = MEZO[CHAIN_ID];
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil default
const hd = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const keyOf = (i: number) => toHex(hd(i).getHdKey().privateKey!) as Hex;

const sender = privateKeyToAccount(keyOf(1));
const relayerKey = keyOf(2);
const attesterKey = keyOf(3);
const relayer = privateKeyToAccount(relayerKey).address;
const attester = privateKeyToAccount(attesterKey).address;
const stranger = privateKeyToAccount(keyOf(4));

const chain = { ...CHAINS[CHAIN_ID], rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 200 });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const walletFor = (account: PrivateKeyAccount) =>
  createWalletClient({ chain, account, transport: http(RPC), pollingInterval: 200 });

const env: Env = {
  RELAYER_PRIVATE_KEY: relayerKey,
  ATTESTER_PRIVATE_KEY: attesterKey,
  RPC_31611: RPC,
  HONGBAO_31611: HONGBAO,
  DEPLOY_BLOCK_31611: DEPLOY_BLOCK,
  // anvil suggests a >= 1 gwei tip (Mezo: ~16 wei), above the 1 gwei production cap.
  MAX_FEE_PER_GAS_WEI: "5000000000",
};

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function nonces(address) view returns (uint256)",
]);
const gaugeAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function earned(address) view returns (uint256)",
  "function periodFinish() view returns (uint256)",
  "function rewardRate() view returns (uint256)",
]);

const DRIP = 3_000_000_000_000n; // 0.000003 BTC
const TIP = 1_000_000_000_000n; // 0.000001 BTC
const MESSAGE = "恭喜發財";

// ---------------------------------------------------------------- reporting

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): boolean {
  if (ok) {
    passed++;
    console.log(`  PASS ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

function skip(name: string, why: string) {
  skipped++;
  console.log(`  SKIP ${name} — ${why}`);
}

function section(title: string) {
  console.log(`\n== ${title}`);
}

const fmt = (wei: bigint, d = 6) => Number(formatUnits(wei, 18)).toFixed(d);

// ---------------------------------------------------------------- API transport

const ORIGIN = MODE === "http" ? BASE : "https://hongbao.test";
type Handler = (ctx: { request: Request; env: Env }) => Promise<Response>;
const routes: Record<string, Handler> = {
  "/api/config": handleConfig,
  "/api/claim": handleClaim,
  "/api/packet": handlePacket,
  "/api/stats": handleStats,
};

interface ApiResult {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
}

async function api(
  path: string,
  init: { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string | null>; envPatch?: Partial<Env> } = {},
): Promise<ApiResult> {
  const method = init.method ?? (init.body !== undefined || init.rawBody !== undefined ? "POST" : "GET");
  const h: Record<string, string> = {};
  if (init.body !== undefined) h["content-type"] = "application/json";
  if (method !== "GET") h.origin = ORIGIN;
  for (const [k, v] of Object.entries(init.headers ?? {})) {
    if (v === null) delete h[k];
    else h[k] = v;
  }
  const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  let res: Response;
  if (MODE === "http") {
    res = await fetch(BASE + path, { method, headers: h, body });
  } else {
    const request = new Request(ORIGIN + path, { method, headers: h, body });
    const handler = routes[new URL(request.url).pathname];
    res = await handler({ request, env: { ...env, ...(init.envPatch ?? {}) } });
  }
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

// ---------------------------------------------------------------- chain helpers

async function blockTime(): Promise<bigint> {
  return (await pub.getBlock({ blockTag: "latest" })).timestamp;
}

async function bal(token: Address, who: Address): Promise<bigint> {
  return pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [who] });
}

async function staked(who: Address): Promise<bigint> {
  return pub.readContract({ address: M.gauge, abi: gaugeAbi, functionName: "balanceOf", args: [who] });
}

/** Give `to` MUSD on the fork: impersonate an EOA holder from the explorer, else write the balance slot. */
async function getMusd(to: Address, amount: bigint): Promise<string> {
  try {
    const ctl = AbortSignal.timeout(15_000);
    const r = await fetch(`https://api.explorer.test.mezo.org/api/v2/tokens/${M.musd}/holders`, { signal: ctl });
    const j = (await r.json()) as { items: { address: { hash: string; is_contract: boolean }; value: string }[] };
    const holders = j.items.filter((it) => !it.address.is_contract && BigInt(it.value) >= amount * 2n);
    for (const hld of holders.slice(0, 5)) {
      const holder = hld.address.hash as Address;
      const onFork = await bal(M.musd, holder);
      if (onFork < amount) continue;
      await test.impersonateAccount({ address: holder });
      await test.setBalance({ address: holder, value: parseUnits("1", 18) });
      const w = createWalletClient({ chain, account: holder, transport: http(RPC) });
      const fees = await pub.estimateFeesPerGas(); // anvil's own fill for unlocked accounts can be inconsistent
      const hash = await w.writeContract({ address: M.musd, abi: erc20, functionName: "transfer", args: [to, amount], ...fees });
      const rc = await pub.waitForTransactionReceipt({ hash });
      await test.stopImpersonatingAccount({ address: holder });
      if (rc.status === "success") return `impersonated holder ${holder}`;
    }
  } catch (e) {
    console.log(`  (explorer holder lookup failed: ${(e as Error).message.slice(0, 80)}; using storage fallback)`);
  }
  // Fallback: find the balances mapping slot by probing.
  const before = await bal(M.musd, to);
  for (let slot = 0n; slot < 30n; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, slot]));
    const prev = await pub.getStorageAt({ address: M.musd, slot: key });
    await test.setStorageAt({ address: M.musd, index: key, value: pad(numberToHex(before + amount), { size: 32 }) });
    if ((await bal(M.musd, to)) === before + amount) return `anvil_setStorageAt slot ${slot}`;
    await test.setStorageAt({ address: M.musd, index: key, value: prev ?? pad("0x0", { size: 32 }) });
  }
  throw new Error("could not obtain MUSD on the fork");
}

interface Made {
  id: bigint;
  linkKey: Hex;
  amount: bigint;
  net: bigint;
  shares: number;
  txHash: Hex;
}

/** Create a packet exactly like the web app: link key generated locally, MUSD via EIP-2612 permit. */
async function createPacket(opts: { amount: string; shares: number; attester: Address; ttl: number; message?: string }): Promise<Made> {
  const linkKey = generatePrivateKey();
  const claimKey = privateKeyToAccount(linkKey).address;
  const amount = parseUnits(opts.amount, 18);
  const now = await blockTime();
  const deadline = now + 3600n;
  const nonce = await pub.readContract({ address: M.musd, abi: erc20, functionName: "nonces", args: [sender.address] });
  const sig = await sender.signTypedData({
    domain: { name: "Mezo USD", version: "1", chainId: CHAIN_ID, verifyingContract: M.musd },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: sender.address, spender: HONGBAO, value: amount, nonce, deadline },
  });
  const { r, s, v, yParity } = parseSignature(sig);
  const vNum = v !== undefined ? Number(v) : yParity + 27;
  const params = {
    shares: opts.shares,
    expiry: now + BigInt(opts.ttl),
    claimKey,
    attester: opts.attester,
    dripPerShare: DRIP,
    tipPerShare: TIP,
    message: opts.message ?? MESSAGE,
  };
  const w = walletFor(sender);
  const txHash = await w.writeContract({
    address: HONGBAO,
    abi: hongbaoAbi,
    functionName: "createWithPermit",
    args: [amount, params, deadline, vNum, r, s],
    value: BigInt(opts.shares) * (DRIP + TIP),
  });
  const rc = await pub.waitForTransactionReceipt({ hash: txHash });
  if (rc.status !== "success") throw new Error("createWithPermit reverted");
  const ev = parseEventLogs({ abi: hongbaoAbi, logs: rc.logs, eventName: "PacketCreated" })[0] as unknown as {
    args: { id: bigint; net: bigint };
  };
  return { id: ev.args.id, linkKey, amount, net: ev.args.net, shares: opts.shares, txHash };
}

/** Sign Claim(packetId, recipient, payout) with the link key, as the browser does. */
async function signClaim(linkKey: Hex, id: bigint, recipient: Address, payout: number): Promise<Hex> {
  return privateKeyToAccount(linkKey).signTypedData({
    domain: hongbaoDomain(CHAIN_ID, HONGBAO),
    types: CLAIM_TYPES,
    primaryType: "Claim",
    message: { packetId: id, recipient, payout },
  });
}

let ipSeq = 10;
const freshIp = () => `198.51.100.${ipSeq++}`;
let devSeq = 0;
const freshDevice = () => `device-${Date.now().toString(36)}-${devSeq++}`;

async function postClaim(
  p: Made,
  recipient: Address,
  payout: number,
  o: { device?: string | null; ip?: string; signPayout?: number; envPatch?: Partial<Env> } = {},
): Promise<ApiResult> {
  const keySig = await signClaim(p.linkKey, p.id, recipient, o.signPayout ?? payout);
  const body: Record<string, unknown> = { chainId: CHAIN_ID, packetId: p.id.toString(), recipient, payout, keySig };
  if (o.device !== null) body.device = o.device ?? freshDevice();
  const cpu0 = process.cpuUsage();
  const res = await api("/api/claim", {
    body,
    headers: { "cf-connecting-ip": o.ip ?? freshIp() },
    envPatch: o.envPatch,
  });
  const cpu = process.cpuUsage(cpu0);
  lastClaimCpuMs = (cpu.user + cpu.system) / 1000;
  return res;
}

/** CPU time this process spent inside the last /api/claim call (direct mode ≈ handler CPU). */
let lastClaimCpuMs = 0;

interface ClaimOutcome {
  ok: boolean;
  amount: bigint;
  payout: number;
  gasCost: bigint;
}

/** Claim through the API, wait for the receipt like the client, and verify the money landed. */
async function claimAndVerify(label: string, p: Made, payout: 0 | 1 | 2, o: { device?: string; ip?: string } = {}): Promise<ClaimOutcome> {
  const recipient = privateKeyToAccount(generatePrivateKey()).address; // brand-new wallet, no BTC, no MUSD
  const digest = await pub.readContract({ address: HONGBAO, abi: hongbaoAbi, functionName: "claimDigest", args: [p.id, recipient, payout] });
  const local = hashTypedData({ domain: hongbaoDomain(CHAIN_ID, HONGBAO), types: CLAIM_TYPES, primaryType: "Claim", message: { packetId: p.id, recipient, payout } });
  check(`${label}: viem Claim digest == contract claimDigest`, digest === local);

  const relayerBefore = await pub.getBalance({ address: relayer });
  const res = await postClaim(p, recipient, payout, o);
  if (MODE === "direct") console.log(`  INFO ${label}: handler CPU ${lastClaimCpuMs.toFixed(1)} ms (Node; Workers free plan allows 10 ms)`);
  if (!check(`${label}: POST /api/claim → 200`, res.status === 200, res.status === 200 ? `tx ${String(res.body.txHash).slice(0, 12)}…` : JSON.stringify(res.body))) {
    return { ok: false, amount: 0n, payout: -1, gasCost: 0n };
  }
  const rc = await pub.waitForTransactionReceipt({ hash: res.body.txHash as Hex });
  check(`${label}: receipt success`, rc.status === "success", `gas ${rc.gasUsed}`);
  check(`${label}: tx sent from relayer to Hongbao`, rc.from.toLowerCase() === relayer.toLowerCase() && rc.to?.toLowerCase() === HONGBAO.toLowerCase());
  const ev = parseEventLogs({ abi: hongbaoAbi, logs: rc.logs, eventName: "Claimed" })[0] as unknown as {
    args: { id: bigint; recipient: Address; relayer: Address; amount: bigint; payout: number };
  };
  check(`${label}: Claimed event for recipient`, !!ev && ev.args.recipient === recipient && ev.args.id === p.id);
  check(`${label}: paid as requested (${["Stake", "Save", "Cash"][payout]})`, ev?.args.payout === payout, `event payout=${ev?.args.payout}`);
  check(`${label}: simulation predicted amount`, res.body.expected?.amount === ev?.args.amount.toString());
  const amount = ev?.args.amount ?? 0n;
  if (payout === 0) check(`${label}: gauge balanceOf(recipient) == share`, (await staked(recipient)) === amount, `${fmt(amount)} sMUSD staked`);
  if (payout === 1) check(`${label}: sMUSD balanceOf(recipient) == share`, (await bal(M.smusd, recipient)) === amount, `${fmt(amount)} sMUSD`);
  if (payout === 2) check(`${label}: MUSD balanceOf(recipient) == share`, (await bal(M.musd, recipient)) === amount, `${fmt(amount)} MUSD`);
  const btc = await pub.getBalance({ address: recipient });
  check(`${label}: gas drip arrived`, btc === DRIP, `${fmt(btc, 9)} BTC`);
  const gasCost = rc.gasUsed * rc.effectiveGasPrice;
  const relayerAfter = await pub.getBalance({ address: relayer });
  check(`${label}: relayer got tip minus gas`, relayerAfter === relayerBefore - gasCost + TIP, `net ${relayerAfter - relayerBefore} wei`);
  lastRecipients.push({ recipient, payout, id: p.id, tx: res.body.txHash });
  return { ok: rc.status === "success", amount, payout: ev?.args.payout ?? -1, gasCost };
}

const lastRecipients: { recipient: Address; payout: number; id: bigint; tx: Hex }[] = [];

// ---------------------------------------------------------------- suites

async function setup(): Promise<void> {
  section("setup");
  check("fork chain id is 31611", (await pub.getChainId()) === CHAIN_ID);
  const code = await pub.getCode({ address: HONGBAO });
  check("Hongbao deployed on fork", !!code && code.length > 2, HONGBAO);
  await test.setBalance({ address: sender.address, value: parseUnits("10", 18) });
  await test.setBalance({ address: relayer, value: parseUnits("1", 18) });
  check("funded sender (acct 1) and relayer (acct 2) with BTC", (await pub.getBalance({ address: relayer })) === parseUnits("1", 18));
  const wiring = await Promise.all(
    (["musd", "smusd", "gauge"] as const).map((f) => pub.readContract({ address: HONGBAO, abi: hongbaoAbi, functionName: f })),
  );
  check("Hongbao wired to Mezo MUSD / sMUSD / gauge", wiring[0] === M.musd && wiring[1] === M.smusd && wiring[2] === M.gauge);
  const ds = await pub.readContract({ address: HONGBAO, abi: hongbaoAbi, functionName: "domainSeparator" });
  const local = hashDomain({
    domain: hongbaoDomain(CHAIN_ID, HONGBAO),
    types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] },
  });
  check("EIP-712 domain separator matches contract", ds === local);
  const need = parseUnits("100", 18);
  const before = await bal(M.musd, sender.address);
  if (before < need) {
    const how = await getMusd(sender.address, need);
    check("sender obtained test MUSD on fork", (await bal(M.musd, sender.address)) >= need, how);
  } else {
    check("sender already holds test MUSD", true, fmt(before, 2));
  }
}

async function configSuite() {
  section("GET /api/config");
  const r = await api("/api/config");
  check("200", r.status === 200);
  const c = r.body?.chains?.["31611"];
  check("testnet entry enabled with our Hongbao", c?.enabled === true && c?.hongbao === HONGBAO);
  check("relayer/attester addresses (no keys)", c?.relayer === relayer && c?.attester === attester && !JSON.stringify(r.body).includes(relayerKey.slice(2, 20)));
  check("mainnet entry present but disabled", r.body?.chains?.["31612"]?.enabled === false);
}

async function directSuite() {
  await configSuite();

  section("create packets (createWithPermit, like the browser)");
  const A = await createPacket({ amount: "4", shares: 4, attester, ttl: 3600 });
  check("packet A: 4 shares, one-per-person (our attester)", A.net === (A.amount * 99n) / 100n, `id ${A.id}, net ${fmt(A.net, 2)} MUSD`);
  const B = await createPacket({ amount: "2", shares: 2, attester: "0x0000000000000000000000000000000000000000", ttl: 3600 });
  check("packet B: 2 shares, open (no attester)", B.id === A.id + 1n, `id ${B.id}`);
  const foreign = privateKeyToAccount(generatePrivateKey()).address;
  const C = await createPacket({ amount: "1", shares: 1, attester: foreign, ttl: 3600 });
  check("packet C: foreign attester", C.id === B.id + 1n, `id ${C.id}`);
  const D = await createPacket({ amount: "3", shares: 3, attester, ttl: 3600 });
  check("packet D: 3 shares, our attester", D.id === C.id + 1n, `id ${D.id}`);
  const E = await createPacket({ amount: "1", shares: 1, attester: "0x0000000000000000000000000000000000000000", ttl: 660 });
  check("packet E: expires in 11 minutes", E.id === D.id + 1n, `id ${E.id}`);

  const ad = await pub.readContract({ address: HONGBAO, abi: hongbaoAbi, functionName: "attestDigest", args: [A.id, attester, 123n] });
  const adLocal = hashTypedData({ domain: hongbaoDomain(CHAIN_ID, HONGBAO), types: ATTEST_TYPES, primaryType: "Attest", message: { packetId: A.id, recipient: attester, deadline: 123n } });
  check("attester Attest digest == contract attestDigest", ad === adLocal);

  section("claims on packet A: Stake, Save, Cash (relayed, attested)");
  const dev1 = freshDevice();
  const ip1 = freshIp();
  const stake = await claimAndVerify("A/Stake", A, 0, { device: dev1, ip: ip1 });
  await claimAndVerify("A/Save", A, 1);
  await claimAndVerify("A/Cash", A, 2);
  if (!stake.ok || lastRecipients.length === 0) throw new Error("first relayed claim failed; later checks depend on it");
  const stakeRecipient = lastRecipients[0].recipient;

  section("refusals");
  {
    const r = await postClaim(A, stakeRecipient, 0);
    check("double claim → 409 AlreadyClaimed", r.status === 409 && r.body.error === "AlreadyClaimed", JSON.stringify(r.body));
  }
  {
    // The contract-level revert path decodes to the same name.
    let name = "";
    try {
      const sig = await signClaim(A.linkKey, A.id, stakeRecipient, 0);
      await pub.simulateContract({ address: HONGBAO, abi: hongbaoAbi, functionName: "claim", args: [A.id, stakeRecipient, 0, sig, 0n, "0x"], account: relayer });
    } catch (e) {
      name = decodeRevert(e)?.name ?? "";
    }
    check("contract revert for double claim decodes to AlreadyClaimed", name === "AlreadyClaimed", name);
  }
  {
    const r = await postClaim(A, privateKeyToAccount(generatePrivateKey()).address, 0, { device: dev1 });
    check("same device, same packet → 429 device-per-packet", r.status === 429 && r.body.limit === "device-per-packet", JSON.stringify(r.body));
  }
  {
    const r = await postClaim(A, privateKeyToAccount(generatePrivateKey()).address, 0, { ip: ip1 });
    check("same IP, same packet → 429 ip-per-packet", r.status === 429 && r.body.limit === "ip-per-packet", JSON.stringify(r.body));
  }
  {
    const r = await postClaim(C, privateKeyToAccount(generatePrivateKey()).address, 0);
    check("foreign attester → 409 ForeignAttester (no signature issued)", r.status === 409 && r.body.error === "ForeignAttester", JSON.stringify(r.body));
  }
  {
    const r = await postClaim(D, privateKeyToAccount(generatePrivateKey()).address, 0, { device: null });
    check("one-per-person packet without device → 400 DeviceRequired", r.status === 400 && r.body.error === "DeviceRequired", JSON.stringify(r.body));
  }
  const devX = freshDevice();
  const ipX = freshIp();
  {
    const r = await postClaim(D, privateKeyToAccount(generatePrivateKey()).address, 0, { device: devX, ip: ipX, signPayout: 1 });
    check("link signature for another payout → 400 BadSignature (decoded from simulation)", r.status === 400 && r.body.error === "BadSignature", JSON.stringify(r.body));
  }
  {
    const r = await postClaim(D, privateKeyToAccount(generatePrivateKey()).address, 0, { device: devX, ip: ipX, envPatch: { MAX_FEE_PER_GAS_WEI: "1000" } });
    check("fee above the relayer's cap → 503 GasPriceTooHigh (nothing sent)", r.status === 503 && r.body.error === "GasPriceTooHigh", JSON.stringify(r.body));
  }
  await claimAndVerify("D/Stake after a refused attempt (limit slot released)", D, 0, { device: devX, ip: ipX });
  {
    const fake: Made = { ...A, id: 999_999n };
    const r = await postClaim(fake, privateKeyToAccount(generatePrivateKey()).address, 0);
    check("unknown packet → 404 UnknownPacket", r.status === 404 && r.body.error === "UnknownPacket", JSON.stringify(r.body));
  }
  {
    const someone = privateKeyToAccount(generatePrivateKey()).address;
    const sig = await signClaim(B.linkKey, B.id, someone, 0);
    const good = { chainId: CHAIN_ID, packetId: B.id.toString(), recipient: someone, payout: 0, keySig: sig };
    const cases: [string, Parameters<typeof api>[1], number, string][] = [
      ["cross-origin POST → 403", { body: good, headers: { origin: "https://evil.example" } }, 403, "Forbidden"],
      ["sec-fetch-site cross-site → 403", { body: good, headers: { origin: null, "sec-fetch-site": "cross-site" } }, 403, "Forbidden"],
      ["text/plain body → 415", { rawBody: JSON.stringify(good), headers: { "content-type": "text/plain" } }, 415, "UnsupportedMediaType"],
      ["oversized body → 413", { body: { ...good, pad: "x".repeat(5000) } }, 413, "PayloadTooLarge"],
      ["bad recipient → 400", { body: { ...good, recipient: "0x1234" } }, 400, "BadRequest"],
      ["bad checksum → 400", { body: { ...good, recipient: someone.slice(0, 2) + someone.slice(2).split("").map((ch, i) => (i % 2 ? ch.toUpperCase() : ch.toLowerCase())).join("") } }, 400, "BadRequest"],
      ["bad payout → 400", { body: { ...good, payout: 7 } }, 400, "BadRequest"],
      ["short signature → 400", { body: { ...good, keySig: "0x1234" } }, 400, "BadRequest"],
      ["unsupported chain → 400", { body: { ...good, chainId: 1 } }, 400, "UnsupportedChain"],
      ["mainnet not enabled → 503", { body: { ...good, chainId: 31612 } }, 503, "ChainDisabled"],
      ["recipient = Hongbao → 400", { body: { ...good, recipient: HONGBAO } }, 400, "BadRequest"],
      ["GET /api/claim → 405", { method: "GET" }, 405, "MethodNotAllowed"],
      ["OPTIONS preflight → 403", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } }, 403, "Forbidden"],
    ];
    for (const [name, init, status, code] of cases) {
      const r = await api("/api/claim", init);
      check(name, r.status === status && r.body?.error === code && !r.headers.get("access-control-allow-origin"), `${r.status} ${r.body?.error}`);
    }
  }
  {
    const patch = { LIMIT_IP_PER_HOUR: "1" };
    const ip = freshIp();
    const r1 = await postClaim(B, privateKeyToAccount(generatePrivateKey()).address, 1, { ip, device: null, envPatch: patch });
    if (r1.status === 200) await pub.waitForTransactionReceipt({ hash: r1.body.txHash });
    const r2 = await postClaim(B, privateKeyToAccount(generatePrivateKey()).address, 1, { ip, device: null, envPatch: patch });
    check("open packet relays without device; IP hourly cap → 429 ip-per-hour", r1.status === 200 && r1.body.attested === false && r2.status === 429 && r2.body.limit === "ip-per-hour", `${r1.status} then ${r2.status} ${r2.body?.limit ?? ""}`);
    const r3 = await postClaim(B, privateKeyToAccount(generatePrivateKey()).address, 2, { device: null });
    if (r3.status === 200) await pub.waitForTransactionReceipt({ hash: r3.body.txHash });
    check("other IP claims the last share of B", r3.status === 200, `${r3.status}`);
    const r4 = await postClaim(B, privateKeyToAccount(generatePrivateKey()).address, 2, { device: null });
    check("empty packet → 410 PacketClosed", r4.status === 410 && r4.body.error === "PacketClosed", JSON.stringify(r4.body));
  }

  section("concurrent claims (nonce handling)");
  {
    const rs = [privateKeyToAccount(generatePrivateKey()).address, privateKeyToAccount(generatePrivateKey()).address];
    const res = await Promise.all(rs.map((r, i) => postClaim(D, r, i === 0 ? 1 : 2)));
    check("two simultaneous claims both accepted", res.every((r) => r.status === 200), res.map((r) => r.status).join(","));
    const rcs = await Promise.all(res.filter((r) => r.status === 200).map((r) => pub.waitForTransactionReceipt({ hash: r.body.txHash })));
    check("both mined successfully", rcs.length === 2 && rcs.every((r) => r.status === "success"));
    const pk = (await pub.readContract({ address: HONGBAO, abi: hongbaoAbi, functionName: "getPacket", args: [D.id] })) as { sharesLeft: number; remaining: bigint };
    check("packet D fully claimed", pk.sharesLeft === 0 && pk.remaining === 0n);
  }

  section("refund");
  {
    const pk = (await pub.readContract({ address: HONGBAO, abi: hongbaoAbi, functionName: "getPacket", args: [A.id] })) as { sharesLeft: number; remaining: bigint };
    const musdBefore = await bal(M.musd, sender.address);
    const r = await api("/api/claim", { body: {}, headers: {} });
    check("empty body → 400", r.status === 400);
    const hash = await walletFor(sender).writeContract({ address: HONGBAO, abi: hongbaoAbi, functionName: "refund", args: [A.id] });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const ev = parseEventLogs({ abi: hongbaoAbi, logs: rc.logs, eventName: "Refunded" })[0] as unknown as {
      args: { amount: bigint; btcReturned: bigint; inKind: boolean; to: Address };
    };
    check("sender refunds the last share of A", rc.status === "success" && ev?.args.amount === pk.remaining && !ev.args.inKind, `${fmt(pk.remaining)} MUSD back`);
    check("refund returns MUSD to sender", (await bal(M.musd, sender.address)) === musdBefore + pk.remaining);
    check("refund returns unused gas kits", ev?.args.btcReturned === BigInt(pk.sharesLeft) * (DRIP + TIP), `${ev?.args.btcReturned} wei`);
    const after = await postClaim(A, privateKeyToAccount(generatePrivateKey()).address, 0);
    check("claim after refund → 410 PacketClosed", after.status === 410 && after.body.error === "PacketClosed");
  }

  section("GET /api/packet");
  {
    const r = await api(`/api/packet?chainId=${CHAIN_ID}&id=${A.id}&recipient=${stakeRecipient}`);
    check("200", r.status === 200, JSON.stringify(r.body).slice(0, 120));
    check("status refunded, 4 shares total", r.body?.status === "refunded" && r.body?.packet?.sharesTotal === 4);
    check("sender's message from PacketCreated", r.body?.created?.message === MESSAGE && r.body?.created?.funding === "MUSD", r.body?.created?.message);
    check("attesterMode ours, claimedBy true", r.body?.attesterMode === "ours" && r.body?.claimedBy === true);
    check("cache-control max-age=5", (r.headers.get("cache-control") ?? "").includes("max-age=5"));
    const e = await api(`/api/packet?chainId=${CHAIN_ID}&id=${E.id}`);
    check("open packet E shows nextShare", e.body?.status === "open" && e.body?.nextShare === E.net.toString(), `${e.body?.status} ${e.body?.nextShare}`);
    const c = await api(`/api/packet?chainId=${CHAIN_ID}&id=${C.id}`);
    check("foreign-attester packet flagged", c.body?.attesterMode === "foreign");
    const u = await api(`/api/packet?chainId=${CHAIN_ID}&id=424242`);
    check("unknown id → 404 UnknownPacket", u.status === 404 && u.body?.error === "UnknownPacket");
    const bad = await api(`/api/packet?chainId=${CHAIN_ID}&id=abc`);
    check("bad id → 400", bad.status === 400);
  }

  section("GET /api/stats");
  {
    const r = await api(`/api/stats?chainId=${CHAIN_ID}`);
    check("200", r.status === 200);
    const s = r.body?.stats ?? {};
    const onchain = (await pub.readContract({ address: HONGBAO, abi: hongbaoAbi, functionName: "stats" })) as readonly bigint[];
    check("stats() mirrored", s.packets === onchain[0].toString() && s.claims === onchain[1].toString() && s.open === onchain[5].toString(), `packets ${s.packets}, claims ${s.claims}, recipients ${s.recipients}`);
    check("5 packets, 8 claims on this fork", s.packets === "5" && s.claims === "8");
    const txs = new Set((r.body?.recent?.claimed ?? []).map((c: { txHash: string }) => c.txHash));
    check("recent Claimed events include our relayed txs", lastRecipients.every((l) => txs.has(l.tx)), `${txs.size} recent claims`);
    check("recent PacketCreated events carry messages", (r.body?.recent?.created ?? []).length === 5 && r.body.recent.created.every((c: { message: string }) => c.message === MESSAGE));
    check("recent Refunded events", (r.body?.recent?.refunded ?? []).length === 1);
    check("cache-control max-age=30", (r.headers.get("cache-control") ?? "").includes("max-age=30"));
  }

  section("expiry, refund by anyone, MEZO accrual");
  {
    const finish = await pub.readContract({ address: M.gauge, abi: gaugeAbi, functionName: "periodFinish" });
    await test.increaseTime({ seconds: 700 });
    await test.mine({ blocks: 1 });
    const r = await postClaim(E, privateKeyToAccount(generatePrivateKey()).address, 0, { device: null });
    check("claim after expiry → 410 Expired", r.status === 410 && r.body.error === "Expired", JSON.stringify(r.body));
    const musdBefore = await bal(M.musd, sender.address);
    const hash = await walletFor(stranger).writeContract({ address: HONGBAO, abi: hongbaoAbi, functionName: "refund", args: [E.id] });
    const rc = await pub.waitForTransactionReceipt({ hash });
    check("anyone can refund after expiry; money goes to the sender", rc.status === "success" && (await bal(M.musd, sender.address)) === musdBefore + E.net);
    const now = await blockTime();
    if (stake.ok && finish > now) {
      const earned = await pub.readContract({ address: M.gauge, abi: gaugeAbi, functionName: "earned", args: [stakeRecipient] });
      check("staked recipient accrues MEZO (gauge earned > 0)", earned > 0n, `${earned} wei MEZO after ~700 s`);
    } else {
      skip("MEZO accrual", "gauge reward period finished on the fork");
    }
  }

  section("not testable on a fork");
  skip("createWithBTC", "BTC ERC-20 view precompile 0x7b7c…0000 does not run on an anvil fork");
  skip("gauge getReward (Claim MEZO)", "MEZO token precompile 0x7b7c…0001 does not run on an anvil fork");
}

/** Smaller suite over real HTTP against `wrangler pages dev` (Workers runtime + local KV). */
async function httpSuite() {
  await configSuite();
  section("HTTP: create + claim through wrangler pages dev");
  const F = await createPacket({ amount: "2", shares: 2, attester, ttl: 3600 });
  const stake = await claimAndVerify("F/Stake via HTTP", F, 0, { ip: "203.0.113.7" });
  if (stake.ok) {
    const again = await postClaim(F, lastRecipients[lastRecipients.length - 1].recipient, 0);
    check("double claim via HTTP → 409 AlreadyClaimed", again.status === 409 && again.body.error === "AlreadyClaimed", JSON.stringify(again.body));
  }
  const dev = freshDevice();
  const G = await createPacket({ amount: "1", shares: 1, attester, ttl: 3600 });
  await claimAndVerify("G/Cash via HTTP", G, 2, { device: dev, ip: "203.0.113.8" });
  {
    const H = await createPacket({ amount: "2", shares: 2, attester, ttl: 3600 });
    const r = await postClaim(H, privateKeyToAccount(generatePrivateKey()).address, 1, { device: dev, ip: "203.0.113.9" });
    if (r.status === 200) await pub.waitForTransactionReceipt({ hash: r.body.txHash });
    const r2 = await postClaim(H, privateKeyToAccount(generatePrivateKey()).address, 1, { device: dev, ip: "203.0.113.10" });
    check("KV-backed device limit via HTTP → 429", r.status === 200 && r2.status === 429 && r2.body.limit === "device-per-packet", `${r.status} then ${r2.status} ${r2.body?.limit ?? r2.body?.error}`);
  }
  {
    const r = await api("/api/claim", { body: { chainId: CHAIN_ID }, headers: { origin: "https://evil.example" } });
    check("cross-origin via HTTP → 403, no CORS headers", r.status === 403 && !r.headers.get("access-control-allow-origin"));
  }
  {
    const r = await api(`/api/packet?chainId=${CHAIN_ID}&id=${F.id}`);
    check("GET /api/packet via HTTP", r.status === 200 && r.body?.created?.message === MESSAGE && r.body?.packet?.sharesLeft === 1, `${r.status} ${r.body?.status}`);
    const s = await api(`/api/stats?chainId=${CHAIN_ID}`);
    check("GET /api/stats via HTTP", s.status === 200 && Number(s.body?.stats?.claims) >= 3, `claims ${s.body?.stats?.claims}`);
    const n = await api("/api/nope");
    check("unknown /api path → JSON 404", n.status === 404 && n.body?.error === "NotFound");
  }
}

// ---------------------------------------------------------------- main

const t0 = Date.now();
console.log(`Hongbao relayer e2e — mode=${MODE}, rpc=${RPC}, hongbao=${HONGBAO}`);
try {
  await setup();
  if (MODE === "http") await httpSuite();
  else await directSuite();
} catch (e) {
  failed++;
  failures.push(`uncaught: ${(e as Error).message?.slice(0, 300)}`);
  console.log(`  FAIL uncaught error — ${(e as Error).stack?.split("\n").slice(0, 4).join(" | ")}`);
}
console.log(`\nSUMMARY (${MODE}): ${passed} passed, ${failed} failed, ${skipped} skipped in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (failures.length) console.log(`FAILED: ${failures.join("; ")}`);
process.exitCode = failed ? 1 : 0;
