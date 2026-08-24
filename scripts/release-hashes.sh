#!/usr/bin/env bash
# Ein Befehl: Hashes headed recapturen, gegen den Shop prüfen, nach main pushen.
# Danach optional Pin+Rebuild auf asus (homelab-config/scripts/galaxus-mcp-sync-ref.sh).
#
# Braucht ein sichtbares Display (nicht headless, nicht GitHub-Runner).
# Arch/Distrobox: einmal `pacman -S --needed nspr nss` plus Chrome-Libs, siehe README.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -d node_modules ]]; then
  npm ci
fi

set +e
npm run refresh-hashes
set -e

npm run build
npm run check-hashes

if git diff --quiet -- src/operations.json; then
  echo "operations.json unverändert — nichts zu pushen."
else
  git add src/operations.json
  git commit -m "chore: refresh Galaxus persisted query hashes"
  git push git@github.com:zurchpet/galaxus-mcp.git HEAD:main
fi

if [[ "${SKIP_HOMELAB:-}" == "1" ]]; then
  exit 0
fi

SYNC='cd /home/zurchpet/homelab-config && ./scripts/galaxus-mcp-sync-ref.sh --apply'
if ssh -o BatchMode=yes -o ConnectTimeout=8 asus "test -x /home/zurchpet/homelab-config/scripts/galaxus-mcp-sync-ref.sh"; then
  ssh -o BatchMode=yes asus "${SYNC}"
else
  echo "Hinweis: nach dem Merge von homelab-config/scripts/galaxus-mcp-sync-ref.sh auf asus:"
  echo "  ${SYNC}"
fi
