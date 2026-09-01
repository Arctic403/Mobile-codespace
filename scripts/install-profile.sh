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

EXT_ID="arctic403.mobile-codespace-profile"
if "$CODE_BIN" --list-extensions 2>/dev/null | grep -Fxqi "$EXT_ID"; then
  echo "Mobile Codespace Profile extension is already installed."
  exit 0
fi

mkdir -p dist
(
  cd extension
  npx --yes @vscode/vsce@latest package --out ../dist/mobile-codespace-profile.vsix
)

"$CODE_BIN" --install-extension "$ROOT/dist/mobile-codespace-profile.vsix" --force
echo "Mobile Codespace Profile installed. Reload the VS Code window if the Mobile button is not visible yet."
