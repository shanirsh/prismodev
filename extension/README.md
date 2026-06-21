# Prismo for VS Code & Cursor

See where your AI coding agents (Claude Code, Cursor, Codex) waste tokens and
money — right inside your editor. No terminal, no separate Node install.

## What it does

- Runs in the editor's built-in runtime — install from the marketplace and go.
- Watches your local agent sessions and syncs aggregate efficiency metrics to
  your Prismo dashboard.
- Shows a live status-bar summary of avoidable waste.

It connects to the same Prismo backend as the `getprismo` CLI, so the dashboard,
weekly report, and repair loop all work the same — this is just a one-click way
to start it from inside Cursor or VS Code.

## Status

Phase 1: scaffold — status bar, commands, secret-stored auth, sync timer.
Capture/sync (Phase 3) and browser sign-in (Phase 2) are in progress.

## Commands

- **Prismo: Sign in** — connect this editor to your Prismo account.
- **Prismo: Open dashboard** — open your Prismo workspace.
- **Prismo: Sync now** — push the latest agent telemetry.
- **Prismo: Sign out** — disconnect this editor.

## Privacy

The extension sends the same aggregate metrics the CLI does — no raw prompts,
code, or tool output. See the Prismo telemetry doc for the exact fields.
