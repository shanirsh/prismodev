# AGENTS.md

## Context rules (Prismo)

- Start from `.prismo/architecture-summary.md`. For scoped work use `.prismo/backend-summary.md` or `.prismo/frontend-summary.md` instead of broad exploration.
- Follow `.prismo/context-firewall.md`. Do not read blocked context — `node_modules/`, `dist/`, `build/`, `coverage/`, `logs/`, lockfiles, or `.prismo/*.bak` — unless strictly required, and say why if you must.
- Never paste full test, build, or log output into the conversation. Run noisy commands through `npx getprismo shield -- <command>` and use the summary; search prior output with `npx getprismo shield search "<text>"`.
- If the same command fails twice, stop and change the approach instead of retrying it.
- When `.prismo/live-guardrails.md` exists, follow its current instructions during the session.
- Re-read a file only if it changed in this session; otherwise rely on what you already read.
- Split unrelated work into fresh sessions at task boundaries.

## Validation-week working agreement (until ~June 16, 2026)

This product is in a measurement window collecting real launch metrics. Rules for any change to this repo:

- **Feature freeze.** Bug fixes and paper cuts only. No new features, commands, or threshold/config changes — they would invalidate the week's numbers.
- **Do not modify** planner/auto-queue thresholds, enforce rules, `.prismo/` policy files, or `.claude/settings.json` hooks.
- **Tests before push:** `npm test` must be green (currently 127 passing).
- **Releases happen via tag only:** `npm version patch && git push && git push --tags` — CI tests and publishes. Never `npm publish` manually.
- **Commits:** author is the user only. Never add AI/Claude co-author trailers.
- Log observations or paper cuts you notice in `docs/validation-week.md` instead of fixing speculatively.

## Companion repo

The private SaaS lives at `../prismo-updated-code` (FastAPI + Next.js). Its `backend/app/modules/devtools/` defines the API contract this CLI talks to. It has its own AGENTS.md with deploy-safety rules — read it before touching that repo.
