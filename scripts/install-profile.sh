#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm run check

CODE_BIN=""
for candidate in code code-insiders; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CODE_BIN="$candidate"
    break
  fi
done

if [[ -z "$CODE_BIN" ]]; then
  echo "VS Code CLI is not available yet. Re-run: bash scripts/install-profile.sh"
  exit 0
fi

mkdir -p dist
(
  cd extension
  npx --yes @vscode/vsce@latest package --out ../dist/mobile-codespace-profile.vsix
)

"$CODE_BIN" --install-extension "$ROOT/dist/mobile-codespace-profile.vsix" --force

echo "Mobile Codespace Shell installed/refreshed."
echo "If the bottom navigation is not visible yet, run: Developer: Reload Window"
