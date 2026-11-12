#!/usr/bin/env bash
# Deploy Hongbao to Mezo testnet, verify it on the Mezo explorer, and swap some
# test BTC into test MUSD for demo packets. Uses the testnet-only key in .secrets/.
# Usage: ops/testnet-bootstrap.sh [btc_to_swap_in_ether_units, default 0.004]
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC=https://rpc.test.mezo.org
CHAIN=31611
BTC=0x7b7C000000000000000000000000000000000000
MUSD=0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503
ROUTER=0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9
FACTORY=0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A
SWAP_BTC="${1:-0.004}"

PK="$(python3 -I -c "import json;d=json.load(open('$ROOT/.secrets/testnet-deployer.json'))['data'];d=d[0] if isinstance(d,list) else d;print(d['private_key'])")"
ME="$(cast wallet address --private-key "$PK")"
echo "deployer $ME  balance $(cast balance "$ME" --rpc-url $RPC --ether) BTC"

cd "$ROOT/contracts"
if [[ -z "${HONGBAO:-}" ]]; then
  forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --private-key "$PK" --slow 2>&1 | tee /tmp/hb-deploy.log | grep -E "deployed at|Error|error" || true
  HONGBAO="$(grep -Eo 'deployed at 0x[0-9a-fA-F]{40}' /tmp/hb-deploy.log | awk '{print $3}' | tail -1)"
fi
echo "Hongbao: $HONGBAO"
BLOCK="$(cast receipt "$(jq -r '.transactions[0].hash' broadcast/Deploy.s.sol/$CHAIN/run-latest.json)" blockNumber --rpc-url $RPC 2>/dev/null || echo null)"

echo "verifying on the Mezo testnet explorer..."
ARGS="$(cast abi-encode 'f((address,address,address,address,address,address,address,address,address,uint256,uint256,uint256))' \
  "($MUSD,0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16,0xA6972f35550717280f2538EA77638B29073e3F07,0x86bCF0841622a5dAC14A313a15f96A95421b9366,$ROUTER,$BTC,$FACTORY,$ME,$ME,100,1000000000000000000000,20000000000000000000000)")"
forge verify-contract "$HONGBAO" src/Hongbao.sol:Hongbao --chain-id $CHAIN \
  --verifier blockscout --verifier-url https://api.explorer.test.mezo.org/api/ \
  --constructor-args "$ARGS" --watch 2>&1 | tail -3 || echo "verification needs a retry"

echo "swapping $SWAP_BTC test BTC -> MUSD on the Tigris pool..."
AMT="$(cast to-wei "$SWAP_BTC")"
cast send $BTC "approve(address,uint256)" $ROUTER "$AMT" --rpc-url $RPC --private-key "$PK" >/dev/null
DEADLINE=$(( $(date +%s) + 600 ))
cast send $ROUTER "swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)" \
  "$AMT" 0 "[($BTC,$MUSD,false,$FACTORY)]" "$ME" $DEADLINE --rpc-url $RPC --private-key "$PK" >/dev/null
echo "MUSD balance: $(cast call $MUSD 'balanceOf(address)(uint256)' "$ME" --rpc-url $RPC)"

python3 -I - "$ROOT/config/deployments.json" "$HONGBAO" "$BLOCK" <<'EOF'
import json, sys
p, addr, block = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(p))
d["31611"]["hongbao"] = addr
d["31611"]["deployBlock"] = None if block in ("", "null") else int(block)
json.dump(d, open(p, "w"), indent=2)
print("config/deployments.json updated")
EOF
