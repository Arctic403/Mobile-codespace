#!/usr/bin/env bash
set -u
cd "${CODESPACE_VSCODE_FOLDER:-$(pwd)}"

pkill -f "node server.mjs" >/dev/null 2>&1 || true
nohup npm start > /tmp/mobile-codespace.log 2>&1 &

# GitHub Codespaces forwards ports as private by default and public visibility can
# reset after a restart. Re-apply public visibility after the port exists.
if command -v gh >/dev/null 2>&1 && [ -n "${CODESPACE_NAME:-}" ]; then
  (
    for _ in $(seq 1 30); do
      if gh codespace ports visibility 4173:public -c "$CODESPACE_NAME" >/tmp/mobile-codespace-port.log 2>&1; then
        exit 0
      fi
      sleep 2
    done
    exit 0
  ) &
fi

exit 0
