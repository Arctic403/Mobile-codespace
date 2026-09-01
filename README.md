# Mobile Codespace Profile

A mobile-first configuration for **native GitHub Codespaces / VS Code for the Web**.

This repo no longer replaces Codespaces with a second IDE. It customizes the real VS Code workbench so iPhone/Safari gets the same terminal, Git, extensions, forwarded ports, authentication, and Codex access with a much cleaner layout.

## What changes

- Activity Bar moves to the bottom so the main views act more like mobile navigation.
- Editor tabs collapse to a single compact tab.
- Minimap, breadcrumbs, sticky scroll, and other desktop-only clutter are removed.
- Preview tabs are disabled so files behave predictably on touch.
- Terminal tabs are simplified.
- A tiny local **Mobile Codespace Profile** extension adds one `Mobile` status-bar button with layout actions:
  - Files + Editor
  - Editor Only
  - Terminal
  - Source Control
  - Search
  - Codex CLI
  - Zen Mode
  - Full Screen
  - Zoom controls

The extension does not replace VS Code. It only calls native VS Code commands.

## First run

1. Create a Codespace from this repo.
2. If the Codespace already existed before this profile was added, run **Codespaces: Rebuild Container** once.
3. When VS Code attaches, `scripts/install-profile.sh` packages and installs the local layout extension automatically.
4. If the `Mobile` button does not appear, run:

```bash
bash scripts/install-profile.sh
```

Then run **Developer: Reload Window** from the Command Palette.

## Codex

The devcontainer installs the current Codex CLI. The `Mobile` menu has a **Codex CLI** action that opens a dedicated integrated terminal and starts `codex`. If you also use the Codex IDE extension, it remains available normally; this profile does not interfere with it.

## Use this in another repo

Copy these pieces into the target repo:

```text
.devcontainer/devcontainer.json
.vscode/settings.json
extension/
scripts/install-profile.sh
scripts/validate-json.mjs
```

Then merge any existing devcontainer settings rather than blindly replacing them.

## Philosophy

Keep GitHub Codespaces as the computer. Keep VS Code as the IDE. Only change the layout and touch workflow.
