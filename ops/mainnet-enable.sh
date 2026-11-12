#!/usr/bin/env bash
# After the mainnet deploy (ops/MAINNET.md): check the contract, verify its source on the Mezo explorer, switch
# mainnet on in config/deployments.json, refresh the proof and snapshot, and redeploy the site.
#
#   ops/mainnet-enable.sh 0x<hongbao address> [--no-deploy]
#
# Read-only on chain: it never sends a transaction.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
HB="${1:?usage: ops/mainnet-enable.sh 0x<hongbao address> [--no-deploy]}"
CHAIN="${CHAIN:-31612}"   # CHAIN=31611 DRY=1 checks the script against the testnet contract without changing anything
if [ "$CHAIN" = 31611 ]; then RPC=https://rpc.test.mezo.org; EXPLORER_API=https://api.explorer.test.mezo.org; EXPECT_MUSD=0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503
else RPC=https://mainnet.mezo.public.validationcloud.io; EXPLORER_API=https://api.explorer.mezo.org; EXPECT_MUSD=0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186; fi

[ "$(cast chain-id --rpc-url $RPC)" = "$CHAIN" ] || { echo "RPC is not chain $CHAIN"; exit 1; }
CODE="$(cast code "$HB" --rpc-url $RPC)"; [ ${#CODE} -gt 4 ] || { echo "no contract at $HB on mainnet"; exit 1; }

echo "== wiring (check treasury and guardian are your own address)"
for f in musd smusd gauge priceFeed router btc poolFactory treasury guardian; do
  printf '  %-19s %s\n' "$f" "$(cast call "$HB" "$f()(address)" --rpc-url $RPC)"
done
for f in feeBps maxPerPacket maxPerSender maxOutstanding hardMaxPerPacket hardMaxPerSender hardMaxOutstanding packetCount; do
  printf '  %-19s %s\n' "$f" "$(cast call "$HB" "$f()(uint256)" --rpc-url $RPC | awk '{print $1}')"
done
GOT_MUSD="$(cast call "$HB" 'musd()(address)' --rpc-url $RPC)"
[ "$(echo "$GOT_MUSD" | tr A-F a-f)" = "$(echo "$EXPECT_MUSD" | tr A-F a-f)" ] || { echo "musd() is $GOT_MUSD, expected $EXPECT_MUSD (Mezo MUSD on chain $CHAIN)"; exit 1; }

echo "== deploy transaction and block"
RUN="$ROOT/contracts/broadcast/Deploy.s.sol/$CHAIN/run-latest.json"
TX=""
if [ -f "$RUN" ]; then
  TX="$(python3 -I -c "
import json,sys
d=json.load(open(sys.argv[1]))
for t in d['transactions']:
  if (t.get('contractAddress') or '').lower()==sys.argv[2].lower(): print(t['hash']); break" "$RUN" "$HB")"
fi
if [ -z "$TX" ]; then
  TX="$(curl -sf "$EXPLORER_API/api/v2/addresses/$HB" | python3 -I -c "import json,sys;d=json.load(sys.stdin);print(d.get('creation_transaction_hash') or d.get('creation_tx_hash') or '')" 2>/dev/null || true)"
fi
[ -n "$TX" ] || { echo "could not find the deploy transaction; pass DEPLOY_BLOCK=<n> to continue"; }
BLOCK="${DEPLOY_BLOCK:-$( [ -n "$TX" ] && cast receipt "$TX" blockNumber --rpc-url $RPC || echo "")}"
[ -n "$BLOCK" ] || { echo "no deploy block"; exit 1; }
echo "  tx $TX  block $BLOCK"
if [ -n "${DRY:-}" ]; then echo "DRY=1: stopping before verification and config changes"; exit 0; fi
[ "$CHAIN" = 31612 ] || { echo "only mainnet is enabled by this script"; exit 1; }

echo "== verify source on explorer.mezo.org"
( cd "$ROOT/contracts" && forge verify-contract "$HB" src/Hongbao.sol:Hongbao --chain-id 31612 \
    --verifier blockscout --verifier-url "$EXPLORER_API/api/" --guess-constructor-args --rpc-url $RPC --watch 2>&1 | tail -4 ) \
  || echo "verification did not finish; re-run this script or check https://explorer.mezo.org/address/$HB"

echo "== config/deployments.json"
python3 -I - "$ROOT/config/deployments.json" "$HB" "$BLOCK" <<'EOF'
import json, sys
p, addr, block = sys.argv[1], sys.argv[2], int(sys.argv[3])
d = json.load(open(p))
d["31612"].update({"hongbao": addr, "deployBlock": block, "enabled": True})
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
print("  31612 enabled at", addr, "from block", block)
EOF

echo "== relayer gas"
RELAYER="$(python3 -I -c "import json,sys;print([w['address'] for w in json.load(open(sys.argv[1]))['wallets'] if w['label']=='mainnet relayer'][0])" "$ROOT/config/team-wallets.json")"
echo "  mainnet relayer $RELAYER holds $(cast from-wei "$(cast balance "$RELAYER" --rpc-url $RPC)") BTC (needs about 0.00002)"

echo "== proof"
node "$ROOT/ops/proof.mjs" | tail -2
if [ "${2:-}" != "--no-deploy" ]; then
  echo "== site"
  bash "$ROOT/ops/deploy-site.sh" 2>&1 | grep -E "Deployment complete|rror" || true
  sleep 5
  curl -s https://hongbao-mezo.pages.dev/api/config | python3 -I -c "import json,sys;c=json.load(sys.stdin)['chains']['31612'];print('  live config 31612:', c['hongbao'], 'enabled' if c['enabled'] else 'DISABLED')"
fi
