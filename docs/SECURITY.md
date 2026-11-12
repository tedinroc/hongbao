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
| Guardian | pause new packets, lower caps below immutable hard caps, hand over the role | move, freeze or redirect any funds; block claims or refunds |

There is no owner, no upgrade path and no admin withdrawal.

## Trust assumptions, stated plainly

- **Open links can be drained by one person using many addresses.** A packet link is a bearer secret: whoever has it can claim one share per address. Packets created with the attester enabled (the default in the app) limit claims per device and IP, which raises the cost of draining but is not proof of personhood. Senders choose who sees the link.
- **The relayer and attester are run by the Hongbao team.** They can refuse service (then anyone else can relay the same signed claim, or the recipient can submit it), but they cannot take funds.
- **Mezo contracts are trusted.** The MUSD Savings Rate vault is upgradeable and owned by Mezo's multisig; the gauge can be killed by the voter. Hongbao falls back in kind: if the gauge is not alive or rejects the deposit, the recipient receives sMUSD; if the vault refuses a withdrawal, cash claims and refunds pay sMUSD.
- **BTC funding depends on the MUSD PriceFeed and the Tigris BTC/MUSD pool.** The swap must clear the oracle value minus at most 3%, and a stale oracle (>60 s) reverts the creation. The contract approves the router for exactly the swapped amount and resets the approval, because its native BTC balance also holds other packets' gas kits.

## Reviews

- 2026-11-12: three independent AI-assisted review passes (funds and accounting; authorization and adversarial actors; correctness against Mezo's verified sources), each finding re-checked by a separate skeptical reviewer. Findings and fixes: see below.

| ID | Severity | Finding | Status |
|---|---|---|---|
| _filled after review_ | | | |

No external audit yet. Mainnet runs as a capped beta (50 MUSD per packet, 500 MUSD outstanding) until one is done.
