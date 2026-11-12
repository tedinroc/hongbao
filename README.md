# Hongbao 紅包 — MUSD red packets that land in Mezo savings

Send MUSD the way people already send money in group chats: as a red packet. One link in Telegram, WhatsApp or LINE; every friend who taps it gets an equal share **already staked in Mezo's sMUSD gauge in their own name**, plus a little BTC for gas. They need nothing beforehand: no wallet, no gas, no MUSD.

Built for the [Mezo Buildathon](https://app.akindo.io/wave-hacks/OVOO0gdrVU8379D10), Track 2 (Access and distribution).

| | |
|---|---|
| Live app | https://hongbao-mezo.pages.dev (no wallet needed to open or claim) |
| Demo video | https://hongbao-mezo.pages.dev/video/ (1:44, app footage on live Mezo testnet) |
| Deck | https://hongbao-mezo.pages.dev/deck.pdf ([source](docs/deck/)) |
| Track | Track 2: Access and distribution (Mezo Adoption) |
| Contract | Mezo testnet [`0xf18a5eC3e76d4aBD1a5C06737A67F4EEa8C3a6c4`](https://explorer.test.mezo.org/address/0xf18a5eC3e76d4aBD1a5C06737A67F4EEa8C3a6c4) (source verified); Mezo mainnet: capped beta, address added at launch |
| Evidence | [docs/PROOF.md](docs/PROOF.md): every packet, claim and refund with explorer links, team vs outside wallets. Every funding path (MUSD permit, BTC through Mezo's pool, a Mezo loan) and every payout (staked, saved, cash) plus a refund has a real testnet transaction |
| Status | Entirely new, built during Wave 2 |

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
- Anyone can relay a claim; the packet's tip pays for it, so the relayer needs no subsidy.

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

- No owner can move funds. A guardian can only pause new packets, set caps below hard caps fixed at deployment (mainnet beta: 50 MUSD per packet, 100 MUSD open per sender, 500 MUSD open in total), and hand the role over in two steps.
- Every packet is refundable by its sender at any time and by anyone (to the sender) after expiry. If the savings vault ever refuses a withdrawal, refunds and cash claims fall back to paying sMUSD in kind.
- Native BTC goes out last under a reentrancy guard; recipients that refuse BTC can pull it later.
- Claims are bound by EIP-712 to the recipient, the payout and the relayer, so a copied transaction can neither redirect the money nor take the relay tip.
- Reviewed in three independent passes (funds and accounting, authorization, correctness against Mezo's verified sources); every confirmed finding is fixed and covered by a test. See [docs/SECURITY.md](docs/SECURITY.md).
- Tests: `cd contracts && forge test` (28 unit, adversarial and fuzz tests, including a conservation fuzz: every MUSD is either paid out or refunded); `cd web && npm test` (107 tests); `scripts/e2e-fork.sh` runs the contract, relayer and app together on a fork of Mezo testnet.

## Repository

| Path | What |
|---|---|
| `contracts/` | Foundry project: `src/Hongbao.sol`, tests, deploy script |
| `web/` | Vite + React app and Cloudflare Pages Functions (relayer and attester) |
| `config/` | deployments and the list of team wallets used by the public ledger |
| `docs/` | spec, security notes |

## Run locally

```bash
cd contracts && forge test
cd web && npm install && npm run build && npm test
```

## Built with AI assistance

Built by Ted Chen with AI coding assistance (Claude). Every contract change is covered by tests and was reviewed before deployment.

## License

MIT
