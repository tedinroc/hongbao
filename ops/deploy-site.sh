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
npx wrangler whoami 2>/dev/null | grep -q "$HB_CF_EXPECT_EMAIL" || { echo "wrong Cloudflare account"; exit 1; }
npm run build
npx wrangler pages deploy dist --project-name hongbao-mezo --branch "${BRANCH:-main}" --commit-dirty=true
