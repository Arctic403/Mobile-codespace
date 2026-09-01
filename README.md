# Mobile Codespace Shell

A phone-first layout for **native GitHub Codespaces / VS Code**. This project does not replace Codespaces, proxy it through another server, or require a separate web app. It reshapes the real Codespaces UI for a small touch screen.

## What the mobile shell changes

- Desktop Activity Bar hidden.
- Editor tab strip removed.
- Command Center and layout chrome removed.
- Terminal opens as a maximized mobile screen.
- Explorer/Search/Git become focused native screens.
- Minimap, breadcrumbs, sticky scroll, folding gutter and other desktop clutter are removed.
- Larger editor/terminal text and touch-friendly padding.
- Auto-save enabled for phone editing.
- Codex CLI installed in the Codespace.
- A local VS Code extension adds persistent bottom navigation.

## Bottom navigation

The extension adds six always-available native status-bar buttons:

**Home · Files · Search · Git · Terminal · Codex**

The active section is bracket-highlighted. These buttons only call native VS Code commands; they do not duplicate the file system, terminal, Git integration, authentication, or editor.

## Mobile Home

When no file is open, the shell launches a touch dashboard with large controls for Files, Search, Git, Terminal, Codex, Editor Focus, Zen Mode, Full Screen, and zoom.

## Fresh Codespace setup

The cleanest test is to create a new Codespace from this repository. The devcontainer will:

1. Apply the phone-first VS Code settings.
2. Install Codex CLI.
3. Validate the profile.
4. Package and install the local Mobile Codespace Shell extension when VS Code attaches.

If the bottom navigation does not appear immediately after the first install, run **Developer: Reload Window** once.

## Reusing it in another repo

Copy these pieces into the target repository:

- `.vscode/settings.json`
- `extension/`
- `scripts/install-profile.sh`
- the relevant `customizations.vscode.settings` and `postAttachCommand` from `.devcontainer/devcontainer.json`

That keeps the target project's real devcontainer/build stack while applying the phone UI on top.
