# Mobile Codespace

A clean, mobile-first control surface for a GitHub Codespace, designed around **iPhone Safari** instead of desktop VS Code.

## First build

- Touch-friendly file browser
- Built-in text/code editor with save + dirty-state protection
- Codespace command runner / terminal panel
- Git status, stage-all, commit, pull, and push controls
- Codex task panel with `read-only` and sandboxed `workspace-write` modes
- Forwarded-port preview launcher for apps running inside the Codespace
- iOS safe-area support, `100dvh`, large touch targets, and bottom navigation
- PWA/standalone metadata for Add to Home Screen
- Zero runtime npm dependencies

## iPhone / Safari setup

1. Open this repository on GitHub.
2. Choose **Code → Codespaces → Create codespace on main**.
3. The devcontainer installs the latest OpenAI Codex CLI, checks the project, and starts Mobile Codespace automatically.
4. Port **4173** is forwarded and configured to open in the browser instead of the VS Code preview pane.
5. In Safari, use **Share → Add to Home Screen** if you want it to behave more like an app.

If the browser does not open automatically, open the Codespace **Ports** list and open port `4173`.

## Manual start

```bash
npm start
```

The server listens on port `4173` by default.

## Codex

The Codespace installs `@openai/codex` during first creation. The app checks whether `codex` is available and exposes it through the Codex tab.

If Codex still needs authentication, run this from the Terminal tab:

```bash
codex login
```

The Codex panel uses non-interactive `codex exec` with `--ask-for-approval never` and either `read-only` or `workspace-write` sandboxing. It does **not** use the unrestricted approval/sandbox bypass mode.

## Workspace root

By default the app controls the current Codespace workspace. Override it with:

```bash
MOBILE_WORKSPACE_ROOT=/workspaces/your-repo npm start
```

## Current terminal model

The first build uses a command runner rather than a persistent PTY. Git, npm, tests, builds, scripts, and normal shell commands work. A streaming PTY can be added later without changing the mobile UI architecture.
