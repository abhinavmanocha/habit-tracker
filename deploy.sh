#!/usr/bin/env bash
# Deploy the habit tracker to Cloudflare Pages.
# Auth: a Pages:Edit API token in ./.cf-token (never committed) or CLOUDFLARE_API_TOKEN.
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="${PROJECT:-habit-tracker}"
BRANCH="${BRANCH:-main}"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if [ -f .cf-token ]; then
    CLOUDFLARE_API_TOKEN="$(tr -d '[:space:]' < .cf-token)"
    export CLOUDFLARE_API_TOKEN
  else
    echo "Missing token: put a Pages:Edit API token in .cf-token or export CLOUDFLARE_API_TOKEN" >&2
    exit 1
  fi
fi

echo "Deploying $(pwd) -> project '$PROJECT' (branch $BRANCH)"
npx --yes wrangler@4 pages deploy . --project-name "$PROJECT" --branch "$BRANCH"
