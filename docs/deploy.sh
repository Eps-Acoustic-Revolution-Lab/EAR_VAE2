#!/usr/bin/env bash
# Deploy demo/ to GitHub Pages via a gh-pages branch.
#
#   ./deploy.sh              # push to the "origin" remote
#   ./deploy.sh <remote>     # push to a named remote or a full URL
#
# The script stages a clean copy (dev-only files excluded), commits it onto
# a fresh gh-pages branch inside a temp dir, and force-pushes that branch.
# GitHub Pages then serves it: Settings → Pages → Deploy from branch → gh-pages.
set -euo pipefail

REMOTE="${1:-origin}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo ">> staging from $ROOT"
rsync -a --delete \
  --exclude 'serve.py' \
  --exclude 'deploy.sh' \
  --exclude 'README.md' \
  --exclude '.DS_Store' \
  "$ROOT/" "$STAGE/"
touch "$STAGE/.nojekyll"

echo ">> publishing to remote: $REMOTE"
cd "$STAGE"
git init -q
git checkout -q -b gh-pages
git add -A
git -c user.name="demo-deploy" -c user.email="demo-deploy@localhost" \
  commit -q -m "demo page deploy $(date '+%Y-%m-%d %H:%M')"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi
git push -f origin gh-pages

echo ">> done. If this is the first deploy: repo Settings → Pages → Deploy from branch → gh-pages (root)."
