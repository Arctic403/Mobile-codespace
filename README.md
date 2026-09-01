# Mobile Codespace Overlay

A **full phone-first workbench overlay** that runs inside the real GitHub Codespaces / VS Code session.

Codespaces still provides the Linux machine, repository, authentication, filesystem, Git, networking and Codex CLI. The extension replaces the day-to-day visible workflow with one mobile webview instead of forcing the desktop VS Code layout onto a phone.

## What is inside the overlay

The shell auto-opens when the Codespace attaches and contains:

- **Home** — touch dashboard and workspace/Git summary.
- **Files** — browse folders, create files/folders, open, rename and delete.
- **Editor** — edit and save text files directly inside the overlay, with a Native Editor escape hatch.
- **Search** — full-workspace text search with tap-to-open results.
- **Git** — branch/status, changed files, stage, unstage, fetch, pull, push and commit.
- **Terminal** — streaming shell commands inside the overlay, including workspace-safe `cd`, input forwarding, clear and stop.
- **Codex** — run `codex exec` against the actual Codespace workspace and stream the result into the overlay.
- **More** — fullscreen, zoom, VS Code settings, reload, and Exit Mobile Shell.

The overlay has its own top bar and persistent bottom navigation:

**Home · Files · Search · Git · Terminal · Codex**

## Native VS Code chrome

The profile hides the desktop Activity Bar, Status Bar, editor tab strip, Command Center, layout controls, minimap and other desktop-first chrome. On startup the extension also closes the native sidebar, bottom panel and auxiliary bar so the mobile shell gets essentially the entire editor surface.

This stays inside supported VS Code extension APIs. It does **not** inject JavaScript into VS Code's internal DOM, so a future VS Code update is much less likely to destroy the layout.

## Fresh Codespace test

The clean test path is:

1. Delete the old `Mobile-codespace` Codespace.
2. Create a fresh Codespace from `Arctic403/Mobile-codespace`.
3. Let the devcontainer finish installing Codex and validating the profile.
4. When VS Code attaches, `scripts/install-profile.sh` packages and force-installs the local overlay extension.
5. If the overlay does not appear on the very first attach, run **Developer: Reload Window** once.

After that, the Mobile Codespace Overlay should auto-open.

## Reusing it in another repo

Copy these pieces into the target repository:

- `.vscode/settings.json`
- `extension/`
- `scripts/install-profile.sh`
- the relevant VS Code customizations and `postAttachCommand` from `.devcontainer/devcontainer.json`

If the target repo already has a devcontainer, merge the customization/install hook into it instead of replacing its build environment.
