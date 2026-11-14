# Hongbao 紅包

**MUSD red packets that land in Mezo savings.**

Send MUSD the way people already send money in group chats: as a red packet. One link in Telegram, WhatsApp or LINE; every friend who taps it gets an equal share **staked in Mezo's sMUSD gauge in their own name by default**, plus a little BTC for gas. They need nothing beforehand: no wallet, no gas, no MUSD.

Built for the [Mezo Buildathon](https://app.akindo.io/wave-hacks/OVOO0gdrVU8379D10), Track 2 (Access and distribution).

**Status:** live on Mezo mainnet as a **capped beta** since 2026-11-13; no external audit yet. Current caps are 50 MUSD per packet, 100 MUSD open per sender and 500 MUSD open in total. See [Safety](#safety) for the guardian's maximum cap-setting powers and [security notes](docs/SECURITY.md) for trust assumptions.

[Open the app](https://hongbao.trytry.net/) · [Watch the demo](https://hongbao.trytry.net/video/) · [Transaction evidence](docs/PROOF.md) · [Run locally](#run-locally) · [Security notes](docs/SECURITY.md)

## Start here

- **See the flow:** watch the [1:59 demo](https://youtu.be/1dhi0hyeWZ8), covering testnet interaction and a mainnet packet.
- **Inspect the implementation:** start with [how it works](#how-it-works), then the [contract](contracts/src/Hongbao.sol) and [security model](docs/SECURITY.md).
- **Try the code:** use the [local build and tests](#run-locally); these commands do not deploy contracts or send funds.

## Project links

| | |
|---|---|
| Live app | https://hongbao.trytry.net (no wallet needed to open or claim). Old `hongbao-mezo.pages.dev` links redirect here |
| Demo video | https://youtu.be/1dhi0hyeWZ8 (1:59: the app on live Mezo testnet, then a real packet sent from MetaMask on Mezo mainnet; also at https://hongbao.trytry.net/video/) |
| Deck | https://hongbao.trytry.net/deck.pdf ([source](docs/deck/)) |
| Track | Track 2: Access and distribution (Mezo Adoption) |
| Contract | Mezo mainnet [`0x116ca33fB361497010a5AA0f1eA5368D304728Ee`](https://explorer.mezo.org/address/0x116ca33fB361497010a5AA0f1eA5368D304728Ee) (capped beta, source verified); Mezo testnet [`0xf18a5eC3e76d4aBD1a5C06737A67F4EEa8C3a6c4`](https://explorer.test.mezo.org/address/0xf18a5eC3e76d4aBD1a5C06737A67F4EEa8C3a6c4) (source verified) |
| Evidence | [docs/PROOF.md](docs/PROOF.md): every packet, claim and refund with explorer links, team vs outside wallets ([config/team-wallets.json](config/team-wallets.json)). Every funding path (MUSD permit, BTC through Mezo's pool, a Mezo loan) and every payout (staked, saved, cash) plus a refund has a real testnet transaction. On mainnet, packets are funded with MUSD from MetaMask and claimed by wallets outside the team, staked in Mezo's gauge |
| Status | Entirely new, built during Wave 2. Live on Mezo mainnet since 2026-11-13 as a capped beta |

## Why

The first step on Mezo is the hardest. Gas is BTC, there is no MUSD faucet, the smallest MUSD loan is 1,800 MUSD plus a 200 MUSD gas deposit, and a new wallet that receives MUSD or MEZO cannot move it without BTC. Hongbao makes that first step a gift from someone you know, and it lands the new user inside Mezo savings instead of in an idle wallet.

## How it works

```
sender ──MUSD (permit) or BTC (swapped on Mezo's pool)──▶ Hongbao ──deposit──▶ MUSD Savings Rate vault (sMUSD)
                                                            │
link holder taps ──signed claim (link key)──▶ relayer ──claim──┤
                                                            ├─ Earn MEZO: VaultGauge.deposit(share, recipient)
                                                            ├─ Save:      sMUSD to the recipient
                                                            ├─ Cash:      MUSD to the recipient
                                                            └─ BTC gas drip to the recipient, tip to the relayer
expiry ──refund──▶ unclaimed MUSD and unused gas back to the sender
```

- The link carries a one-time key in its `#fragment`, which never reaches a server. The contract stores only the key's address and checks an EIP-712 `Claim(packetId, recipient, payout, relayer)` signature, so a signature cannot be redirected to another address, another payout or another relayer.
- Optional one-per-person mode: the relayer co-signs an `Attest(packetId, recipient, payout, deadline)` after rate-limiting by device and IP.
- The packet's tip pays the relayer's gas, so the relayer needs no subsidy. Claims on an open packet can be relayed by anyone; one-per-person claims go through the Hongbao relayer, which co-signs them.

## Mezo contracts Hongbao calls

| Mezo contract | Call | Why |
|---|---|---|
| MUSD | `permit`, `transferFrom`, `transfer` | fund packets with a permit signature, no separate approval |
| MUSD Savings Rate (sMUSD) | `deposit`, `withdraw`, `claimYield` | unclaimed packets earn savings yield; cash claims and refunds |
| sMUSD VaultGauge | `deposit(amount, recipient)` | each share is staked in the recipient's own name and earns MEZO |
| Pools voter | `isAlive(gauge)` | fall back to plain sMUSD if the gauge is ever killed |
| Tigris Router + BTC/MUSD pool | `swapExactTokensForTokens` | fund a packet with BTC |
| MUSD PriceFeed | `fetchPrice` | the BTC swap must clear the oracle price minus a capped slippage; stale price reverts |
| BorrowerOperations, TroveManager, HintHelpers, SortedTroves | `withdrawMUSD`, `getCurrentICR`, `getTroveMaxBorrowingCapacity`, hints | send a packet straight from your Mezo loan, with ICR and Recovery Mode checks |

## Safety

- No owner can move funds. A guardian can only pause new packets, set caps below hard caps fixed at deployment (mainnet beta: 50 MUSD per packet, 100 MUSD open per sender, 500 MUSD open in total; the guardian can raise them at most to 100 / 500 / 5,000), and hand the role over in two steps.
- Every packet is refundable by its sender at any time and by anyone (to the sender) after expiry. If the savings vault ever refuses a withdrawal, refunds and cash claims fall back to paying sMUSD in kind.
- Native BTC goes out last under a reentrancy guard; recipients that refuse BTC can pull it later.
- Claims are bound by EIP-712 to the recipient, the payout and the relayer, so a copied transaction can neither redirect the money nor take the relay tip.
- Reviewed in three independent AI-assisted passes before deployment (funds and accounting, authorization, correctness against Mezo's verified sources) and once more after the mainnet deploy; every confirmed finding is fixed or documented. See [docs/SECURITY.md](docs/SECURITY.md).
- Tests: `cd contracts && forge test` (28 unit, adversarial and fuzz tests, including a conservation fuzz: every MUSD is either paid out or refunded); `cd web && npm test` (116 tests); `scripts/e2e-fork.sh` runs the contract, relayer and app together on a fork of Mezo testnet.

## Repository

| Path | What |
|---|---|
| `contracts/` | Foundry project: `src/Hongbao.sol`, tests, deploy script |
| `web/` | Vite + React app and Cloudflare Pages Functions (relayer and attester) |
| `config/` | deployments and the list of team wallets used by the public ledger |
| `docs/` | spec, security notes |

## Run locally

Requirements: Git, Foundry, Node.js and npm. The clone includes the OpenZeppelin and forge-std submodules used by the contracts.

```bash
git clone --recurse-submodules https://github.com/tedinroc/hongbao.git
cd hongbao
(cd contracts && forge test)
(cd web && npm ci && npm run build && npm test)
```

For an existing clone, run `git submodule update --init --recursive` first. To start the frontend after installing dependencies, run `(cd web && npm run dev)`. Contract deployment, relaying and mainnet interactions are separate from these build commands.

## Built with AI assistance

Built by Ted Chen with AI coding assistance (Claude). Every contract change is covered by tests and was reviewed before deployment.

## License

MIT
