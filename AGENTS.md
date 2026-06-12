# AGENTS.md

## Context rules (Prismo)

- Start from `.prismo/architecture-summary.md`. For scoped work use `.prismo/backend-summary.md` or `.prismo/frontend-summary.md` instead of broad exploration.
- Follow `.prismo/context-firewall.md`. Do not read blocked context — `node_modules/`, `dist/`, `build/`, `coverage/`, `logs/`, lockfiles, or `.prismo/*.bak` — unless strictly required, and say why if you must.
- Never paste full test, build, or log output into the conversation. Run noisy commands through `npx getprismo shield -- <command>` and use the summary; search prior output with `npx getprismo shield search "<text>"`.
- If the same command fails twice, stop and change the approach instead of retrying it.
- When `.prismo/live-guardrails.md` exists, follow its current instructions during the session.
- Re-read a file only if it changed in this session; otherwise rely on what you already read.
- Split unrelated work into fresh sessions at task boundaries.
