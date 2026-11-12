# Hongbao (紅包) — build spec

MUSD red packets that land in Mezo savings. Built for the Mezo Buildathon Wave 2 (deadline 2026-11-15 15:00 UTC), Track 2 "Access and distribution" (Mezo calls it the Mezo Adoption track), and meant to continue as a real product.

## The product in one paragraph

A sender puts MUSD (or BTC, swapped on Mezo's own pool) into a red packet split into N equal shares and shares one link, typically in a LINE group. While unclaimed, the money sits in Mezo's MUSD Savings Rate vault as sMUSD. Anyone with the link claims one share with nothing prepared: no wallet, no gas, no MUSD. The share is staked in Mezo's sMUSD gauge **in the recipient's own name** (earning MEZO), or kept as sMUSD, or paid as MUSD. Each share also carries a small BTC gas drip so the new wallet can act on Mezo, plus a tip that pays whoever relays the claim. Unclaimed money returns to the sender.

## Contract (done)

`contracts/src/Hongbao.sol`, ABI in `shared/Hongbao.abi.json`. Key functions:

- `create(uint256 amount, CreateParams p) payable` — MUSD pulled with transferFrom (needs approve). `msg.value` must equal `shares * (dripPerShare + tipPerShare)`.
- `createWithPermit(amount, p, deadline, v, r, s) payable` — MUSD via EIP-2612 permit (MUSD domain name `"Mezo USD"`, version `"1"`).
- `createWithBTC(btcIn, minMusdOut, maxSlippageBps, p) payable` — `msg.value = btcIn + kits`. maxSlippageBps ≤ 300; use 150 by default.
- `CreateParams { uint32 shares; uint64 expiry; address claimKey; address attester; uint96 dripPerShare; uint96 tipPerShare; string message; }`
  - shares 1..100; expiry between now+10min and now+30d; message ≤ 200 bytes; dripPerShare ≤ 0.0001 BTC; tipPerShare ≤ 0.00001 BTC; each share ≥ 0.01 MUSD after the 1% fee.
  - Defaults for the UI: `dripPerShare = 0.000003 BTC` (3e12 wei), `tipPerShare = 0.000001 BTC` (1e12 wei), expiry 24h, attester = the relayer's attester address (one-per-person mode) unless the sender turns it off.
- `claim(id, recipient, payout, keySig, attestDeadline, attestSig) returns (amount, paid)` — payout enum: `0 Stake, 1 Save, 2 Cash`. `keySig` is EIP-712 `Claim(uint256 packetId,address recipient,uint8 payout)` signed by the link key. If the packet has an attester, `attestSig` is EIP-712 `Attest(uint256 packetId,address recipient,uint256 deadline)` signed by the attester. Domain: `{name: "Hongbao", version: "1", chainId, verifyingContract: <Hongbao address>}`. Helper views: `claimDigest`, `attestDigest`, `domainSeparator`.
- `refund(id)` — sender any time, anyone after expiry (funds go to sender).
- `sweepYield()`, `withdrawBTC()`, guardian functions.
- Views: `getPacket(id)` → `{sender, expiry, sharesTotal, claimKey, sharesLeft, refunded, attester, dripPerShare, remaining, tipPerShare}`, `nextShare(id)`, `stats()` → `(packets, claims, volume, recipients, senders, open)`, `claimed(id, addr)`, `packetCount()`.
- Events: `PacketCreated(id, sender, net, fee, shares, expiry, funding, claimKey, attester, message)`, `Claimed(id, recipient, relayer, amount, payout)`, `Refunded(id, to, amount, btcReturned, inKind)`.
- Errors are custom errors; decode them for friendly messages (AlreadyClaimed, Expired, PacketClosed, BadSignature, AttestationExpired, …).

## Chains

| | Mezo testnet (Matsnet) | Mezo mainnet |
|---|---|---|
| chainId | 31611 | 31612 |
| RPC | https://rpc.test.mezo.org | https://mainnet.mezo.public.validationcloud.io (fallback https://rpc-http.mezo.boar.network) |
| Explorer | https://explorer.test.mezo.org | https://explorer.mezo.org |
| Native gas token | BTC, 18 decimals | BTC, 18 decimals |
| MUSD | 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 | 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186 |
| sMUSD (MUSDSavingsRate) | 0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16 | 0xb4D498029af77680cD1eF828b967f010d06C51CC |
| sMUSD VaultGauge | 0xA6972f35550717280f2538EA77638B29073e3F07 | 0x677817bF3e44b90E8F95222F75e2950b7904a401 |
| MEZO token | 0x7B7c000000000000000000000000000000000001 | 0x7B7c000000000000000000000000000000000001 |
| BTC (ERC-20 view) | 0x7b7C000000000000000000000000000000000000 | 0x7b7C000000000000000000000000000000000000 |
| Router (Tigris) | 0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9 | 0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706 |
| PoolFactory | 0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A | 0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248 |
| PriceFeed | 0x86bCF0841622a5dAC14A313a15f96A95421b9366 | 0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88 |
| Hongbao | from `config/deployments.json` (filled after deploy) | same |

Gauge facts: `deposit(amount, recipient)`, `withdraw(amount)` (caller's own stake), `getReward(account)` (only the account itself can call), `earned(account) view`, `balanceOf(account) view`, `rewardRate() view`, `totalSupply() view`. sMUSD: `deposit(amount)`, `withdraw(amount)`, `claimYield()`, `balanceOf`. Gas price on Mezo is tiny (~1.5e6 wei mainnet); a claim is ~300k gas, a create ~400k gas.

Mezo docs are partly stale; trust the addresses above.

## Link format

`https://<site>/c/<chainId>/<packetId>#k=<0x private key of the link key>`

- The sender's browser generates the link key (`viem` `generatePrivateKey`) and passes only its address as `claimKey`. The private key lives only in the URL fragment, which is never sent to the server.
- Also offer a short QR code of the same link and a LINE share button: `https://line.me/R/share?text=<urlencoded message + link>`.

## Recipient wallet

- Default: "a new wallet on this phone", created with `generatePrivateKey` and stored in `localStorage` (`hongbao.wallet.v1`). Always offer "Back up this wallet" (show/copy key with a clear warning) and "Use my own wallet instead".
- Optional: connect an injected wallet (MetaMask, Rabby, OKX, Mezo Passport-compatible EIP-1193). Add/switch chain with `wallet_addEthereumChain` using the table above.
- No third-party login SDK, no WalletConnect project id, no paid service.

## Relayer and attester API (Cloudflare Pages Functions, `functions/api/*`)

Secrets (Cloudflare env): `RELAYER_PRIVATE_KEY`, `ATTESTER_PRIVATE_KEY`. Config: `config/deployments.json` (Hongbao address per chain, enabled chains).

- `GET /api/config` → `{ chains: { "31611": {hongbao, relayer, attester, enabled}, "31612": {...} } }`.
- `POST /api/claim` body `{ chainId, packetId, recipient, payout, keySig, device }`
  1. Validate types, chain enabled, recipient is an address.
  2. Read the packet; reject if unknown/closed/expired/already claimed (return a clear error code).
  3. If the packet's attester equals our attester: rate-limit (per IP and per `device` id: at most 1 claim per packet, at most 10 claims per IP per hour; use a KV namespace `HB_LIMITS` if bound, otherwise an in-memory Map with a warning), then sign `Attest(packetId, recipient, deadline=now+600)`.
  4. Simulate `claim(...)` with `eth_call` from the relayer address; on revert decode the custom error and return it.
  5. Send the transaction from the relayer key (legacy or EIP-1559, whatever Mezo accepts; set a gas limit from `estimateGas` × 1.3), return `{ txHash }` immediately; the client waits for the receipt itself.
- `GET /api/packet?chainId&id` → packet view plus `nextShare` (cache 5 s).
- `GET /api/stats?chainId` → `stats()` plus recent Claimed/PacketCreated events (cache 30 s).
- The relayer must never forward arbitrary calldata: it only calls `claim` on our Hongbao address.

## Web app (static, Vite + React + TypeScript + viem; no wagmi needed)

Routes (hash-free paths, served as SPA with a `_redirects` fallback):

1. `/` — **Landing.** Must render meaningful content within 2 s without a wallet (the judges use a headless browser): headline, a live stats strip (packets, claims, distinct recipients, MUSD sent, MUSD earning in Mezo savings) that first renders from a build-time snapshot (`public/snapshot.json`) and then refreshes from `/api/stats`. A short "how it works" in three steps, a "Mezo contracts we call" panel with explorer links (sMUSD vault, sMUSD gauge, Tigris router, PriceFeed, MUSD), CTA "Send a red packet", and a link to the public ledger.
2. `/send` — **Create.** Connect wallet → choose network (testnet/mainnet) → amount (MUSD), number of shares, message (default 「恭喜發財」 / "Good fortune"), expiry, fund with MUSD (permit, one signature + one tx) or BTC (shows the PriceFeed quote and the pool quote), toggle "one per person (recommended)". Shows the fee (1%), gas kit cost, and what each recipient gets. After the tx: the link, QR, LINE share, copy button, and "open the packet page".
3. `/c/:chainId/:id` — **Claim.** Red-packet visual with the sender's message and "N of M left". If the fragment key is missing, show how to get a link. Buttons: choose how to receive — **Earn MEZO** (stake, default), **Save** (sMUSD), **Cash** (MUSD), each with a one-line plain explanation. One tap → sign with the link key in the browser → POST `/api/claim` → wait for receipt → success screen with the amount, a live "MEZO earned" counter (gauge `earned` polled every 5 s), the tx link, and next steps: **Pass it on** (make your own packet from part of your share), **Claim MEZO** (`getReward(self)`), **Cash out** (gauge `withdraw` → sMUSD `withdraw`), **Back up wallet**. After expiry or when empty, show the final tally.
4. `/me` — **My wallet.** Balances: BTC, MUSD, sMUSD, staked sMUSD, MEZO earned; actions as above; list of packets I sent with refund buttons.
5. `/ledger` — **Public ledger** for judges: every packet and claim from events, with explorer links; each address tagged `team` if listed in `config/team-wallets.json`, else `outside`; counts of outside senders, outside claimers, and outside follow-up transactions (recipients who later called the gauge or created their own packet). This page is the evidence for "real users beyond the team".

Language: Traditional Chinese and English with a toggle; default from `navigator.language` (zh-* → zh-Hant). Keep strings in one dictionary file.

Design: the subject is a red envelope. Use a deep red and warm gold palette with a calm neutral; strong typographic hierarchy (Noto Serif TC for display Chinese, Noto Sans TC / Inter for body, a monospace for amounts and addresses). Mobile-first (LINE in-app browser, 360–430 px wide), large tap targets, no horizontal scroll, works in light and dark. One celebratory moment: the envelope opening on a successful claim (respect prefers-reduced-motion). No emoji as icons.

Copy rules: plain words, active voice, the button says what happens ("Open the red packet", "Send", "Claim MEZO"). Explain BTC gas once in plain words. Never claim a feature the code does not have.

## Quality bar

- TypeScript strict, `npm run build` clean, `npm run lint` if configured.
- Unit tests for the signing helpers (EIP-712 digest must equal the contract's `claimDigest`; there is a Foundry test vector you can reproduce: compute with viem and compare against `cast call <hongbao> "claimDigest(uint256,address,uint8)"` once deployed, or against an anvil deployment).
- Never log or send the link private key or the wallet private key anywhere.
- All external fetches go to the Mezo RPCs and our own `/api`.
