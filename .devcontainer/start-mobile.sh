#!/usr/bin/env bash
set -u
cd "${CODESPACE_VSCODE_FOLDER:-$(pwd)}"

pkill -f "node server.mjs" >/dev/null 2>&1 || true
nohup npm start > /tmp/mobile-codespace.log 2>&1 &

# Public forwarding is required for the GitHub Pages UI to reach Safari reliably.
# The backend itself still requires a GitHub token that is verified against this exact Codespace.
if command -v gh >/dev/null 2>&1 && [ -n "${CODESPACE_NAME:-}" ]; then
  (
    sleep 4
    gh codespace ports visibility 4173:public -c "$CODESPACE_NAME" >/tmp/mobile-codespace-port.log 2>&1 || true
  ) &
fi

exit 0
