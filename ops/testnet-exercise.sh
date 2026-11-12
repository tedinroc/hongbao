#!/usr/bin/env bash
# Exercise every Hongbao path on Mezo testnet with team wallets and log the tx hashes.
# Paths: create (MUSD), createWithBTC, claim Stake/Save/Cash (self-submitted, relayer = 0),
# recipient follow-ups (gauge getReward, gauge withdraw, sMUSD withdraw), refund, sweepYield.
# Recipients are fresh testnet-only keys in .secrets/testnet-recipients.json and are added to
# config/team-wallets.json so the public ledger never counts them as outside users.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC=https://rpc.test.mezo.org
HB="$(jq -r '."31611".hongbao' "$ROOT/config/deployments.json")"
MUSD=0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503
SMUSD=0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16
GAUGE=0xA6972f35550717280f2538EA77638B29073e3F07
BTC=0x7b7C000000000000000000000000000000000000
ROUTER=0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9
LOG="$ROOT/ops/testnet-exercise.log"
key() { python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]))['data'];d=d[0] if isinstance(d,list) else d;print(d[sys.argv[2]])" "$1" "$2"; }
PK="$(key "$ROOT/.secrets/testnet-deployer.json" private_key)"; ME="$(cast wallet address --private-key "$PK")"

REC="$ROOT/.secrets/testnet-recipients.json"
if [[ ! -f "$REC" ]]; then
  python3 -I - "$REC" <<'EOF'
import json, subprocess, sys, os
out = []
for label in ["link-key-A", "link-key-B", "recipient-stake", "recipient-save", "recipient-cash"]:
    d = json.loads(subprocess.check_output([os.path.expanduser("~/.foundry/bin/cast"), "wallet", "new", "--json"]))["data"]
    d = d[0] if isinstance(d, list) else d
    out.append({"label": label, "address": d["address"], "private_key": d["private_key"]})
json.dump(out, open(sys.argv[1], "w"), indent=1)
os.chmod(sys.argv[1], 0o600)
EOF
fi
R() { python3 -I -c "import json,sys;print([x for x in json.load(open(sys.argv[1])) if x['label']==sys.argv[2]][0][sys.argv[3]])" "$REC" "$1" "$2"; }
KA_PK="$(R link-key-A private_key)"; KA="$(R link-key-A address)"
KB_PK="$(R link-key-B private_key)"; KB="$(R link-key-B address)"
RS="$(R recipient-stake address)"; RS_PK="$(R recipient-stake private_key)"
RV="$(R recipient-save address)"; RC="$(R recipient-cash address)"; RC_PK="$(R recipient-cash private_key)"

python3 -I - "$ROOT/config/team-wallets.json" "$RS" "$RV" "$RC" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
have = {w["address"].lower() for w in d["wallets"]}
for a, l in zip(sys.argv[2:], ["test recipient (stake)", "test recipient (save)", "test recipient (cash)"]):
    if a.lower() not in have:
        d["wallets"].append({"address": a, "label": l})
json.dump(d, open(p, "w"), indent=2)
EOF

send() { local label="$1"; shift; local h; h="$(cast send "$@" --rpc-url $RPC --json | jq -r .transactionHash)"; echo "$label $h" | tee -a "$LOG"; }
NOW=$(date +%s); EXP=$((NOW + 86400)); DRIP=3000000000000; TIP=1000000000000
echo "# $(date -u +%FT%TZ) Hongbao $HB" >> "$LOG"

# 1. MUSD packet A: 30 MUSD, 3 shares, open mode (no attester)
cast send $MUSD "approve(address,uint256)" "$HB" 1000000000000000000000 --rpc-url $RPC --private-key "$PK" >/dev/null
send "create-musd" "$HB" "create(uint256,(uint32,uint64,address,address,uint96,uint96,string))" 30000000000000000000 \
  "(3,$EXP,$KA,0x0000000000000000000000000000000000000000,$DRIP,$TIP,\"恭喜發財 · testnet path check\")" \
  --value $((3 * (DRIP + TIP))) --private-key "$PK"
IDA="$(cast call "$HB" "packetCount()(uint256)" --rpc-url $RPC)"

# 2. BTC packet B: 0.0002 BTC, 2 shares
KITS_BEFORE="$(cast balance "$HB" --rpc-url $RPC)"
send "create-btc" "$HB" "createWithBTC(uint256,uint256,uint256,(uint32,uint64,address,address,uint96,uint96,string))" \
  200000000000000 0 150 "(2,$EXP,$KB,0x0000000000000000000000000000000000000000,$DRIP,$TIP,\"BTC-funded path check\")" \
  --value $((200000000000000 + 2 * (DRIP + TIP))) --private-key "$PK"
IDB="$(cast call "$HB" "packetCount()(uint256)" --rpc-url $RPC)"
echo "native BTC held: before $KITS_BEFORE after $(cast balance "$HB" --rpc-url $RPC) (expect +$((2 * (DRIP + TIP))))" | tee -a "$LOG"
echo "BTC allowance hb->router: $(cast call $BTC 'allowance(address,address)(uint256)' "$HB" $ROUTER --rpc-url $RPC)" | tee -a "$LOG"

# 3. Claims on packet A, signed by link key A, submitted by the deployer (relayer = 0)
claim() { local id="$1" to="$2" payout="$3" kpk="$4" d sig
  d="$(cast call "$HB" "claimDigest(uint256,address,uint8,address)(bytes32)" "$id" "$to" "$payout" 0x0000000000000000000000000000000000000000 --rpc-url $RPC)"
  sig="$(cast wallet sign --no-hash "$d" --private-key "$kpk")"
  send "claim-$id-payout$payout" "$HB" "claim(uint256,address,uint8,address,bytes,uint256,bytes)" "$id" "$to" "$payout" \
    0x0000000000000000000000000000000000000000 "$sig" 0 0x --private-key "$PK"; }
claim "$IDA" "$RS" 0 "$KA_PK"
claim "$IDA" "$RV" 1 "$KA_PK"
claim "$IDA" "$RC" 2 "$KA_PK"
echo "stake recipient gauge balance: $(cast call $GAUGE 'balanceOf(address)(uint256)' "$RS" --rpc-url $RPC)" | tee -a "$LOG"
echo "save recipient sMUSD: $(cast call $SMUSD 'balanceOf(address)(uint256)' "$RV" --rpc-url $RPC)" | tee -a "$LOG"
echo "cash recipient MUSD: $(cast call $MUSD 'balanceOf(address)(uint256)' "$RC" --rpc-url $RPC)" | tee -a "$LOG"
echo "drip at stake recipient: $(cast balance "$RS" --rpc-url $RPC)" | tee -a "$LOG"

# 4. One claim on the BTC packet
claim "$IDB" "$RS" 0 "$KB_PK"

# 5. Recipient follow-ups, paid with the dripped BTC
sleep 20
send "recipient-getReward" $GAUGE "getReward(address)" "$RS" --private-key "$RS_PK"
echo "MEZO at stake recipient: $(cast call 0x7B7c000000000000000000000000000000000001 'balanceOf(address)(uint256)' "$RS" --rpc-url $RPC)" | tee -a "$LOG"
ST="$(cast call $GAUGE 'balanceOf(address)(uint256)' "$RS" --rpc-url $RPC | awk '{print $1}')"
send "recipient-gauge-withdraw" $GAUGE "withdraw(uint256)" "$ST" --private-key "$RS_PK"
send "recipient-smusd-withdraw" $SMUSD "withdraw(uint256)" "$ST" --private-key "$RS_PK"
echo "stake recipient MUSD after cash-out: $(cast call $MUSD 'balanceOf(address)(uint256)' "$RS" --rpc-url $RPC)" | tee -a "$LOG"

# 6. Sender refunds what is left of the BTC packet, then the treasury sweeps savings yield
send "refund-btc-packet" "$HB" "refund(uint256)" "$IDB" --private-key "$PK"
send "sweepYield" "$HB" "sweepYield()" --private-key "$PK"
echo "hb native BTC now: $(cast balance "$HB" --rpc-url $RPC); outstanding: $(cast call "$HB" 'outstanding()(uint256)' --rpc-url $RPC)" | tee -a "$LOG"
