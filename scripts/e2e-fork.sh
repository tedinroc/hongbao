#!/usr/bin/env bash
# End-to-end test of Hongbao (relayer/attester + web app) on a local anvil fork of Mezo testnet.
#
#   scripts/e2e-fork.sh                 # all suites below
#   SKIP_WRANGLER=1 scripts/e2e-fork.sh # no wrangler pages dev (suites 1 and 3 only)
#   SKIP_WEB=1 scripts/e2e-fork.sh      # relayer suites only (no vitest, dummy dist)
#   KEEP_WORK=1 scripts/e2e-fork.sh     # keep logs and build output in the temp dir
#
# Suites: 1 relayer handlers in Node; 2 the web app's vitest fork suites (src/e2e +
# integration/: the front end's own client code against the handlers); 3 the relayer
# suite over HTTP from `wrangler pages dev` serving the real web/dist, 3b its SPA
# routes; 4 integration/claim-relay.test.ts over HTTP against that wrangler.
#
# Spends no real funds and publishes nothing: anvil forks https://rpc.test.mezo.org
# (reads only), the explorer API is read to find a MUSD holder to impersonate, and
# every transaction lands on the local fork. Accounts come from anvil's default
# mnemonic (public test keys): #0 deploys, #1 sends packets, #2 relays, #3 attests.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
FORK_URL="${FORK_URL:-https://rpc.test.mezo.org}"
MNEMONIC="test test test test test test test test test test test junk"
DEPLOYER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" # anvil #0

for bin in anvil forge cast node; do
  command -v "$bin" >/dev/null || { echo "missing $bin" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hongbao-e2e.XXXXXX")"
ANVIL_PID=""
WRANGLER_PID=""
cleanup() {
  [ -n "$WRANGLER_PID" ] && kill "$WRANGLER_PID" 2>/dev/null || true
  [ -n "$WRANGLER_PID" ] && pkill -P "$WRANGLER_PID" 2>/dev/null || true
  [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true
  if [ -z "${KEEP_WORK:-}" ]; then rm -rf "$WORK"; else echo "work dir kept: $WORK"; fi
}
trap cleanup EXIT INT TERM

free_port() {
  node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
}

wait_for() { # url-check-command, seconds
  local i
  for i in $(seq 1 "$2"); do
    if eval "$1" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------- anvil fork
PORT="$(free_port)"
RPC="http://127.0.0.1:$PORT"
echo "== starting anvil fork of $FORK_URL on $RPC"
# Gas price: --disable-min-priority-fee makes eth_gasPrice report the fork's base fee
# (~1e2 wei, like real Mezo testnet's 146 wei), which the relayer's TipTooLow check
# (tip >= estimated gas x gas price x 1.2) reads. eth_maxPriorityFeePerGas still
# suggests 1 gwei (real Mezo: ~16 wei testnet, ~1.6e5 wei mainnet), so the relayer
# pays more than on Mezo and the tests raise its MAX_FEE_PER_GAS_WEI cap to 5 gwei.
anvil --fork-url "$FORK_URL" --chain-id 31611 --host 127.0.0.1 --port "$PORT" \
  --mnemonic "$MNEMONIC" --disable-min-priority-fee --silent >"$WORK/anvil.log" 2>&1 &
ANVIL_PID=$!
wait_for "cast chain-id --rpc-url $RPC" 90 || { echo "anvil did not start"; cat "$WORK/anvil.log"; exit 1; }
echo "   fork block $(cast block-number --rpc-url "$RPC"), chain id $(cast chain-id --rpc-url "$RPC")"

# ---------------------------------------------------------------- deploy Hongbao
echo "== deploying Hongbao with contracts/script/Deploy.s.sol (anvil #0, unlocked)"
(
  cd "$ROOT/contracts"
  FOUNDRY_OUT="$WORK/out" FOUNDRY_CACHE_PATH="$WORK/cache" FOUNDRY_BROADCAST="$WORK/broadcast" \
    forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --unlocked --sender "$DEPLOYER" \
    >"$WORK/deploy.log" 2>&1
) || { echo "deploy failed"; tail -40 "$WORK/deploy.log"; exit 1; }
read -r HONGBAO DEPLOY_BLOCK < <(node -e '
  const d = require(process.argv[1]);
  const tx = d.transactions.find((t) => t.transactionType === "CREATE" && t.contractName === "Hongbao");
  const rc = d.receipts.find((r) => r.contractAddress && r.contractAddress.toLowerCase() === tx.contractAddress.toLowerCase());
  console.log(tx.contractAddress, parseInt(rc.blockNumber, 16));
' "$WORK/broadcast/Deploy.s.sol/31611/run-latest.json")
echo "   Hongbao $HONGBAO at block $DEPLOY_BLOCK"

# ---------------------------------------------------------------- suite 1: handlers called directly
STATUS=0
echo "== suite 1: Pages Functions handlers invoked directly (Node)"
E2E_MODE=direct E2E_RPC="$RPC" E2E_HONGBAO="$HONGBAO" E2E_DEPLOY_BLOCK="$DEPLOY_BLOCK" \
  node "$ROOT/scripts/lib/run-ts.mjs" "$ROOT/scripts/e2e/fork-e2e.ts" || STATUS=1

# ---------------------------------------------------------------- suite 2: web app vitest on the fork
if [ -z "${SKIP_WEB:-}" ]; then
  echo "== suite 2: web app fork suites (vitest: src/e2e + integration, API handlers in-process)"
  (
    cd "$ROOT/web"
    VITE_FORK_RPC="$RPC" VITE_FORK_HONGBAO="$HONGBAO" VITE_FORK_FROM_BLOCK="$DEPLOY_BLOCK" \
      ./node_modules/.bin/vitest run src/e2e integration >"$WORK/vitest-direct.log" 2>&1
  ) && echo "   $(grep -E '^ +Tests ' "$WORK/vitest-direct.log" | tr -s ' ')" \
    || { echo "   vitest FAILED"; tail -60 "$WORK/vitest-direct.log"; STATUS=1; }
fi

# ---------------------------------------------------------------- suite 3: wrangler pages dev
if [ -z "${SKIP_WRANGLER:-}" ]; then
  echo "== suite 3: same functions served by wrangler pages dev (workerd + local KV)"
  WPORT="$(free_port)"
  if [ -z "${SKIP_WEB:-}" ]; then
    # Serve the real build so the SPA fallback (_redirects) and /api routing are tested together.
    if [ ! -f "$ROOT/web/dist/index.html" ]; then
      (cd "$ROOT/web" && npm run build >"$WORK/build.log" 2>&1) || { echo "web build failed"; tail -30 "$WORK/build.log"; exit 1; }
    fi
    cp -R "$ROOT/web/dist" "$WORK/dist"
  else
    mkdir -p "$WORK/dist"
    printf '<!doctype html><title>hongbao e2e</title>\n' >"$WORK/dist/index.html"
  fi
  RELAYER_KEY="$(cast wallet private-key "$MNEMONIC" 2)"
  ATTESTER_KEY="$(cast wallet private-key "$MNEMONIC" 3)"
  (
    cd "$ROOT/web"
    WRANGLER_SEND_METRICS=false exec ./node_modules/.bin/wrangler pages dev "$WORK/dist" \
      --ip 127.0.0.1 --port "$WPORT" --compatibility-date=2026-11-01 \
      --kv HB_LIMITS --persist-to "$WORK/wrangler-state" \
      --binding "RELAYER_PRIVATE_KEY=$RELAYER_KEY" --binding "ATTESTER_PRIVATE_KEY=$ATTESTER_KEY" \
      --binding "RPC_31611=$RPC" --binding "HONGBAO_31611=$HONGBAO" --binding "DEPLOY_BLOCK_31611=$DEPLOY_BLOCK" \
      --binding "MAX_FEE_PER_GAS_WEI=5000000000" \
      >"$WORK/wrangler.log" 2>&1
  ) &
  WRANGLER_PID=$!
  unset RELAYER_KEY ATTESTER_KEY
  if wait_for "curl -sf http://127.0.0.1:$WPORT/api/config" 120; then
    E2E_MODE=http E2E_BASE="http://127.0.0.1:$WPORT" E2E_RPC="$RPC" E2E_HONGBAO="$HONGBAO" E2E_DEPLOY_BLOCK="$DEPLOY_BLOCK" \
      node "$ROOT/scripts/lib/run-ts.mjs" "$ROOT/scripts/e2e/fork-e2e.ts" || STATUS=1
    if [ -z "${SKIP_WEB:-}" ]; then
      echo "== suite 3b: SPA pages from web/dist next to the functions"
      for path in / /c/31611/1 /send /me /ledger; do
        out="$(curl -s -w '\n%{http_code} %{content_type}' "http://127.0.0.1:$WPORT$path")"
        if printf '%s' "$out" | grep -q '<div id="root"></div>' && printf '%s' "$out" | tail -1 | grep -q '^200 text/html'; then
          echo "  PASS GET $path → index.html"
        else
          echo "  FAIL GET $path → $(printf '%s' "$out" | tail -1)"; STATUS=1
        fi
      done
      out="$(curl -s -w '\n%{http_code}' "http://127.0.0.1:$WPORT/api/claim")"
      if printf '%s' "$out" | grep -q '"MethodNotAllowed"' && printf '%s' "$out" | tail -1 | grep -q '^405'; then
        echo "  PASS GET /api/claim → JSON 405 (not the SPA page)"
      else
        echo "  FAIL GET /api/claim → $(printf '%s' "$out" | tail -1)"; STATUS=1
      fi
      echo "== suite 4: integration/claim-relay.test.ts over HTTP (front-end client → workerd → fork)"
      (
        cd "$ROOT/web"
        VITE_API_BASE="http://127.0.0.1:$WPORT" VITE_FORK_RPC="$RPC" VITE_FORK_HONGBAO="$HONGBAO" VITE_FORK_FROM_BLOCK="$DEPLOY_BLOCK" \
          ./node_modules/.bin/vitest run integration/claim-relay >"$WORK/vitest-http.log" 2>&1
      ) && echo "   $(grep -E '^ +Tests ' "$WORK/vitest-http.log" | tr -s ' ')" \
        || { echo "   vitest FAILED"; tail -60 "$WORK/vitest-http.log"; STATUS=1; }
    fi
  else
    echo "wrangler pages dev did not come up"; grep -v -i "private_key" "$WORK/wrangler.log" | tail -40; STATUS=1
  fi
fi

if [ "$STATUS" -eq 0 ]; then echo "== e2e PASSED"; else echo "== e2e FAILED"; fi
exit "$STATUS"
