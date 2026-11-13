#!/usr/bin/env bash
# Mezo TESTNET only: create a public red packet from the team testnet wallet and write its claim link to
# private/TESTER-LINKS.md (the link carries the claim key, so it is never printed or committed).
#
#   ops/new-packet.sh <shares> <musd_total> <hours_open> "<message>" [open]
#
# Default is one-per-person mode (the relayer's attester co-signs each claim after device/IP limits); pass `open`
# as the fifth argument for a packet anyone with the link can claim from many addresses.
# Example (judges' packet on submission day, the 7-day maximum):
#   ops/new-packet.sh 30 60 168 "恭喜發財! Hongbao for Mezo Buildathon judges"   (168 h is trimmed to 7 days minus 15 min)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
SHARES="${1:?shares}"; TOTAL="${2:?musd total}"; HOURS="${3:?hours open}"; MSG="${4:?message}"; MODE="${5:-one-per-person}"
RPC=https://rpc.test.mezo.org
MUSD=0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503
HB="$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['31611']['hongbao'])" "$ROOT/config/deployments.json")"
ATTESTER="$(curl -sf https://hongbao.trytry.net/api/config | python3 -I -c "import json,sys;print(json.load(sys.stdin)['chains']['31611']['attester'])")"
[ "$MODE" = open ] && ATTESTER=0x0000000000000000000000000000000000000000
key() { python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));d=d.get('data',d);d=d[0] if isinstance(d,list) else d;print(d['private_key'])" "$1"; }
PK="$(key "$ROOT/.secrets/testnet-deployer.json")"
# fresh claim key for the link
LINK_JSON="$(cast wallet new --json)"
LK_ADDR="$(python3 -I -c "import json,sys;d=json.loads(sys.argv[1]);d=d.get('data',d);d=d[0] if isinstance(d,list) else d;print(d['address'])" "$LINK_JSON")"
LK_PK="$(python3 -I -c "import json,sys;d=json.loads(sys.argv[1]);d=d.get('data',d);d=d[0] if isinstance(d,list) else d;print(d['private_key'])" "$LINK_JSON")"
unset LINK_JSON
DRIP=3000000000000; TIP=1000000000000          # the app's defaults (web/src/lib/sendPlan.ts)
# MAX_DURATION is 7 days from the including block; keep the app's 15 minutes of slack (web/src/pages/Send.tsx)
SECS=$(( HOURS * 3600 )); [ "$SECS" -gt $(( 7 * 86400 - 900 )) ] && SECS=$(( 7 * 86400 - 900 ))
EXP=$(( $(date +%s) + SECS ))
AMT="$(cast to-wei "$TOTAL")"
ALLOW="$(cast call $MUSD 'allowance(address,address)(uint256)' "$(cast wallet address --private-key "$PK")" "$HB" --rpc-url $RPC | awk '{print $1}')"
if python3 -c "import sys;sys.exit(0 if int('$ALLOW') < int('$AMT') else 1)"; then
  cast send $MUSD 'approve(address,uint256)' "$HB" "$AMT" --rpc-url $RPC --private-key "$PK" >/dev/null
fi
TX="$(cast send "$HB" 'create(uint256,(uint32,uint64,address,address,uint96,uint96,string))' "$AMT" \
  "($SHARES,$EXP,$LK_ADDR,$ATTESTER,$DRIP,$TIP,\"$MSG\")" --value $(( SHARES * (DRIP + TIP) )) \
  --rpc-url $RPC --private-key "$PK" --json | python3 -I -c "import json,sys;r=json.load(sys.stdin);r=r.get('data',r);print(r['transactionHash'] if r.get('status') in ('0x1',1,True) else 'FAILED')")"
unset PK
[ "$TX" = FAILED ] && { echo "create failed"; exit 1; }
ID="$(cast call "$HB" 'packetCount()(uint256)' --rpc-url $RPC | awk '{print $1}')"
LINK="https://hongbao.trytry.net/c/31611/$ID#k=$LK_PK&c=$HB"
unset LK_PK
mkdir -p "$ROOT/private"
printf -- '- %s packet %s (testnet, %s × ~%s MUSD, %s, open %sh, "%s", tx %s): %s\n' "$(TZ=Asia/Taipei date '+%F %H:%M')" "$ID" "$SHARES" \
  "$(python3 -c "print(round($TOTAL*0.99/$SHARES,2))")" "$MODE" "$HOURS" "$MSG" "$TX" "$LINK" >> "$ROOT/private/TESTER-LINKS.md"
echo "packet #$ID created (tx $TX); claim link written to private/TESTER-LINKS.md"
