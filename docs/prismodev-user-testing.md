# PrismoDev User Testing Playbook

Use this playbook to validate the CLI-first PrismoDev wedge with developers who use Codex, Claude Code, Cursor, or similar AI coding tools.

## Goal

Prove whether developers understand and value local AI coding-workflow visibility before building dashboard persistence, hooks, MCP interception, or live compression.

Core positioning:

> PrismoDev finds and monitors token waste in local AI coding workflows, while Prismo core tracks exact API usage through the proxy.

## Who To Test With

Recruit 5-10 developers who actively use at least one of:

- Codex
- Claude Code
- Cursor
- OpenAI-compatible coding tools
- AI-heavy terminal workflows

Prefer developers with real repos, long sessions, local logs, generated files, large test output, or MCP/tooling configs.

## Exact Commands To Send

Ask each tester to run these from a real project root:

```bash
npx getprismo@0.1.5 scan --usage --no-report
npx getprismo@0.1.5 setup
npx getprismo@0.1.5 watch --once
```

Optional follow-up if they find useful issues:

```bash
npx getprismo@0.1.5 scan --fix
npx getprismo@0.1.5 optimize
npx getprismo@0.1.5 context frontend
```

## Outreach Message

```text
Hey, I’m testing a small local CLI feature for Prismo called PrismoDev.

It scans a repo and local Codex/Claude Code logs to find token waste from context bloat, tool output, oversized instruction files, missing ignore files, and long AI coding sessions.

No API keys, no prompt interception, no subscription proxying.

Could you run these three commands from a real repo and send me a screenshot or notes on what was useful/confusing?

npx getprismo@0.1.5 scan --usage --no-report
npx getprismo@0.1.5 setup
npx getprismo@0.1.5 watch --once

I’m mainly trying to learn whether the output is useful enough for developers who use Codex, Claude Code, or Cursor.
```

## What To Collect

For each tester, record:

- Tool used: Codex, Claude Code, Cursor, other
- OS: macOS, Linux, Windows/WSL
- Did all three commands run without help?
- Did local logs show up?
- Did `watch --once` show a useful active session?
- Did they understand exact proxy tracking vs local session estimates?
- Most surprising/useful output
- Most confusing output
- Would they run `scan --fix`?
- Would they run `optimize`?
- What did they expect PrismoDev to do next?
- Did they ask for live reduction, dashboard/team reporting, or exact proxy setup?

## Feedback Form

```text
Name:
Repo type:
Coding tool:
OS:

Commands completed:
- scan --usage --no-report: yes/no
- setup: yes/no
- watch --once: yes/no

Were local logs found?

Did any output surprise you?

What was confusing?

Do you understand this distinction?
- Local scan = heuristic repo/context risk
- Local logs = exact only when logs expose token fields
- Prismo proxy = exact when traffic uses Prismo base URL

Would you run scan --fix or optimize?

What should PrismoDev do next?
- better CLI visibility
- dashboard/team reports
- exact Codex/Cursor proxy setup
- live waste reduction
- other

Screenshot/output notes:
```

## Success Criteria

Treat the first test loop as successful if:

- 5+ developers run the commands.
- At least 4 can explain PrismoDev in one sentence.
- At least 3 find one output useful or surprising.
- At least 2 ask for one of: live reduction, team dashboarding, exact proxy setup.
- No more than 1 person gets blocked by install/run friction.

## Decision Rules

After 5-10 user runs, choose the next product bet:

1. If users love CLI visibility: improve `watch` and add local scan history.
2. If users ask for teams/reporting: update the Prismo Dev dashboard to import new JSON fields.
3. If users ask for exact tracking: build guided API/base-url setup for Codex/Cursor-compatible tools.
4. If users ask for reducing waste live: start optional live reduction design.

Default if feedback is mixed:

```bash
npx getprismo@0.1.5 setup codex
```

This should generate safe instructions for routing API-mode Codex traffic through Prismo. It should not auto-edit user config.

## Scope Guardrails

Do not build these until user validation points there:

- Claude Code hooks
- MCP interception
- prompt rewriting
- shell-output compression
- dashboard persistence
- team reporting
- live reduction

Keep claims honest:

- Exact usage/cost only when traffic flows through Prismo.
- Local logs are visibility signals, not guaranteed provider billing records.
- Subscription coding sessions are local-log/heuristic unless the tool supports routed base URL traffic.
