#!/usr/bin/env bash
set -u
cd "${CODESPACE_VSCODE_FOLDER:-$(pwd)}"

pkill -f "node server.mjs" >/dev/null 2>&1 || true
nohup npm start > /tmp/mobile-codespace.log 2>&1 &

# Port 4173 intentionally remains private. GitHub's private Codespaces tunnel
# authenticates the owner before the browser can reach the bridge.
exit 0
