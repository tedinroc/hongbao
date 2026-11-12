#!/usr/bin/env bash
# Build the web app and deploy it to the Cloudflare Pages project "hongbao-mezo".
# Account settings come from private/cf.env (not committed): HB_CF_CONFIG_DIR (wrangler OAuth
# config dir), HB_NPM_CACHE, CLOUDFLARE_ACCOUNT_ID and HB_CF_EXPECT_EMAIL (the login that must be active).
# Usage: ops/deploy-site.sh            (production, branch main)
#        BRANCH=preview ops/deploy-site.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
set -a; source "$ROOT/private/cf.env"; set +a
SCR="${TMPDIR:-/tmp}/hongbao-cfhome"; mkdir -p "$SCR"
export HOME="$SCR" XDG_CONFIG_HOME="$HB_CF_CONFIG_DIR" npm_config_cache="$HB_NPM_CACHE" CLOUDFLARE_ACCOUNT_ID
cd "$ROOT/web"
WHO="$(npx wrangler whoami 2>&1 || true)"
grep -q "$HB_CF_EXPECT_EMAIL" <<<"$WHO" || { echo "wrong Cloudflare account"; exit 1; }
node "$ROOT/ops/snapshot.mjs" || echo "snapshot refresh skipped"
npm run build
npx wrangler pages deploy dist --project-name hongbao-mezo --branch "${BRANCH:-main}" --commit-dirty=true
