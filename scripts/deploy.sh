#!/usr/bin/env bash
# Deploy to Cloudflare, then commit any changes and push to GitHub.
# Usage: npm run deploy [-- "what changed"]
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ Applying database migrations…"
npx wrangler d1 migrations apply trackers-db --remote

echo "▶ Deploying to Cloudflare…"
npx wrangler deploy

echo "▶ Saving to GitHub…"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "${1:-Deploy $(date '+%Y-%m-%d %H:%M')}"
  echo "  committed: $(git log -1 --format='%h %s')"
else
  echo "  no file changes to commit"
fi

git push -q origin main
# master is the repo's default branch on GitHub; keep it in sync while it exists.
if git ls-remote --exit-code --heads origin master >/dev/null 2>&1; then
  git push -q origin main:master
fi
echo "✅ Live and pushed to GitHub"
