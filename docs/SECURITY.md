# Hongbao security notes

## What the contract holds

- **sMUSD** for every open packet (`outstanding`). Packet principal is never held as MUSD between transactions.
- **MUSD** only as savings yield (claimed by `withdraw` or `claimYield`), swept to the treasury by `sweepYield()`.
- **Native BTC** for unused gas kits (`dripPerShare + tipPerShare` per unclaimed share) and `pendingBTC` owed to recipients that refused a push.

Invariants (tested, including a fuzzed conservation test):

1. `sMUSD.balanceOf(hongbao) ≥ outstanding`.
2. For every packet, `sum(claims) + refund = net deposited`.
3. Native BTC held = sum over open packets of unused kits + sum of `pendingBTC`.

## Roles and powers

| Role | Can | Cannot |
|---|---|---|
| Sender | create, refund own packet any time | claim on behalf of others without the link |
| Link holder | sign a claim for any recipient address, once per address | change the payout after signing, reuse a signature for another recipient, packet, chain or contract |
| Attester (relayer backend, optional per packet) | co-sign one claim per person after device/IP limits | claim without the link key |
| Relayer (anyone) | submit claims and earn the per-share tip | alter recipient or payout (both are signed) |
| Guardian | pause new packets, set caps up to the immutable hard caps, hand over the role | move, freeze or redirect any funds; block claims or refunds |

There is no owner, no upgrade path and no admin withdrawal.

## Trust assumptions, stated plainly

- **Open links can be drained by one person using many addresses.** A packet link is a bearer secret: whoever has it can claim one share per address. Packets created with the attester enabled (the default in the app) limit claims per device and IP, which raises the cost of draining but is not proof of personhood: the device id comes from the browser, the IP limit is 5 claims per address (an IPv6 /64) per packet, and the counters are eventually consistent, so someone with a handful of IP addresses can still take most of a public packet. Senders choose who sees the link.
- **The relayer and attester are run by the Hongbao team.** They cannot take funds, but they can refuse service. For a packet without an attester, anyone else can then relay the same signed claim, or the recipient can submit it. A one-per-person packet needs the attester's co-signature, which only our relayer requests, so its claims wait until the service is back; the sender can refund at any time.
- **Mezo contracts are trusted.** The MUSD Savings Rate vault is upgradeable and owned by Mezo's multisig; the gauge can be killed by the voter. Hongbao falls back in kind: if the gauge is not alive or rejects the deposit, the recipient receives sMUSD; if the vault refuses a withdrawal, cash claims and refunds pay sMUSD.
- **BTC funding depends on the MUSD PriceFeed and the Tigris BTC/MUSD pool.** The swap must clear the oracle value minus at most 3%, and a stale oracle (>60 s) reverts the creation. The contract approves the router for exactly the swapped amount and resets the approval, because its native BTC balance also holds other packets' gas kits.

## Reviews

- 2026-11-12: three independent AI-assisted review passes (funds and accounting; authorization and adversarial actors; correctness against Mezo's verified sources), each finding re-checked by a separate skeptical reviewer. Findings and fixes: see below.
- 2026-11-13, after the mainnet deploy: an AI-assisted adversarial review of the live app, relayer and claim links. Result: someone watching the chain or the mempool cannot take a share. Fixed in 4c68c7c: Cloudflare could inject its analytics script into the page that holds the claim key (HTML is now served with `Cache-Control: no-transform`), and the send page could create a packet without a co-signer when one-per-person was on but the co-signer had not answered (now refused). Documented under trust assumptions: one-per-person is a speed bump, not proof of personhood.

| ID | Severity | Finding | Status |
|---|---|---|---|
| AUTH-M3 / FUNDS-1 | Medium | One sender could fill the global cap for ~1% and block new packets for up to 30 days; the guardian had no room to respond | Fixed: per-sender cap, soft caps below wider hard caps, 7-day max expiry |
| AUTH-M2 / FUNDS-6 | Medium (relayer) | Zero-tip packets could drain the relayer's gas | Fixed in the relayer: TipTooLow check, every packet rate-limited |
| AUTH-L1 / FUNDS-5 | Low | A copied claim transaction could take the relay tip | Fixed: `relayer` is part of the signed Claim; `WrongRelayer` otherwise |
| AUTH-L2 | Low | An attestation did not bind the payout, so another link holder could switch a victim from Stake to Cash | Fixed: Attest now includes payout |
| AUTH-L3 / FUNDS-3 | Low | A share sent to the Hongbao, sMUSD, gauge, MUSD or BTC contract would be stranded or swept | Fixed: `BadRecipient` |
| AUTH-L4 / FUNDS-4 | Low | Guardian and treasury defaulted to the relayer hot key; single-step guardian handover | Fixed: two-step handover; the mainnet guardian/treasury is a wallet separate from the relayer hot key |
| MEZO-1 | Low | `fetchPrice` was called as `view`; a Liquity-style PriceFeed upgrade would break BTC funding | Fixed: non-view call with a clear `OracleUnavailable` error |
| AUTH-I2 | Info | A recipient contract returning huge data made the relayer pay extra gas | Fixed: BTC send does not copy return data |
| AUTH-I5 | Info | Malformed signatures reverted with library errors | Fixed: `BadSignature` |
| FUNDS-10 | Info | Gas kits were not bounded by the MUSD caps | Reduced: max drip 0.00002 BTC, max tip 0.000005 BTC per share |
| AUTH-M1 | Info (by design) | Whoever holds an open-mode link can claim every share from many addresses | Documented; one-per-person mode is the app default |
| FUNDS-7 / MEZO-4 | Info | Savings yield on unclaimed money goes to the treasury; staked shares earn MEZO instead of savings interest | Documented in the app and README |

Every Mezo call was also simulated read-only against live testnet and mainnet state, and every funding path and payout has since run with real transactions on Mezo testnet (see [PROOF.md](PROOF.md)); the in-kind fallbacks and the stale-price revert are covered by Foundry tests and the Recovery Mode refusal by an app test, not by live transactions, including BTC funding through Mezo's BTC precompile, which a local fork cannot emulate.

No external audit yet. Mainnet runs as a capped beta (50 MUSD per packet, 100 MUSD open per sender, 500 MUSD open in total; guardian can raise them only up to 100 / 500 / 5,000) until one is done.
