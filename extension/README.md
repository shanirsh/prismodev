# Prismo for VS Code & Cursor

See where your AI coding agents (Claude Code, Cursor, Codex) waste tokens and
money — right inside your editor. No terminal, no separate Node install.

## How to use it

1. Open the **Prismo** panel from the activity bar (the pulse icon on the left),
   or click the **Prismo** item in the status bar.
2. Click **Sign in to Prismo** — your browser opens, you authorize, and it
   returns to the editor automatically.
3. Keep coding. Prismo measures your AI coding agents and shows your avoidable
   waste in the panel and the status bar.

It connects to the same Prismo backend as the `getprismo` CLI, so the dashboard,
weekly report, and repair loop all work the same — this is just a one-click way
to run it from inside Cursor or VS Code, with no terminal.

## Commands

- **Prismo: Sign in** — connect this editor to your Prismo account (browser).
- **Prismo: Sign in with API key** — paste a key instead (locked-down setups).
- **Prismo: Open dashboard** — open your Prismo workspace.
- **Prismo: Sync now** — push the latest agent telemetry.
- **Prismo: Upgrade** — open pricing for team metrics and verified savings.
- **Prismo: Sign out** — disconnect this editor.
- **Prismo: Show logs** — open the diagnostic log.

## Privacy

The extension sends the same aggregate metrics the CLI does — no raw prompts,
code, or tool output. See the Prismo telemetry doc for the exact fields.
