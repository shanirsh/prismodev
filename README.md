# PrismoDev

Open-source local CLI for finding token waste in AI coding workflows.

PrismoDev finds and monitors token waste in local AI coding workflows, while Prismo core tracks exact API usage through the proxy.

```bash
npx getprismo scan --usage
npx getprismo setup
npx getprismo watch
```

## Open Source Scope

This repository contains the PrismoDev local CLI only:

- repo scanning and token-waste diagnostics
- local Codex and Claude Code usage-log summaries when logs expose token fields
- generated `.prismo/` context packs and ignore-file recommendations
- offline demo, setup, watch, scan, and optimize commands

It does not include the hosted Prismo SaaS app, managed proxy, dashboard,
billing, auth, provider vault, team features, or customer infrastructure.

PrismoDev is licensed under the MIT License. See [LICENSE](LICENSE).

## For Non-Builders

If you do not have developer tools installed yet, install **Node.js LTS** from [nodejs.org](https://nodejs.org), open a new terminal, and check:

```bash
node -v
npm -v
npx -v
```

Then open your project folder in the terminal and run:

```bash
npx getprismo demo
npx getprismo scan --simple
```

`demo` shows what PrismoDev does without reading your files. `scan --simple` gives a plain-English repo check with no API keys, no account login, and no file changes.

## What It Does

- Scans your repo for token-waste risks before a coding-agent session.
- Reads local Codex and Claude Code logs when available to show real session usage.
- Generates compact `.prismo/` context files for Claude Code, Codex, Cursor, and similar tools.
- Recommends safer `.claudeignore`, `CLAUDE.md`, and `AGENTS.md` patterns.
- Works offline and does not connect to OpenAI, Anthropic, Cursor, or billing accounts.

## Tracking Modes

```text
Local scan: no API keys, heuristic repo/context risk
Local logs: exact when Codex/Claude logs expose token fields
Prismo proxy: exact usage/cost when traffic uses Prismo base URL
```

PrismoDev does not claim exact billing for hidden subscription coding-agent sessions. When provider traffic does not flow through Prismo, local usage is based on available session logs and deterministic estimates.

## Quick Start

```bash
npx getprismo scan --usage
npx getprismo setup
npx getprismo watch --once
```

Use this flow to see value immediately:

1. `scan --usage` finds repo/context risks and reads local Codex/Claude Code usage logs when available.
2. `setup` shows which tracking modes are possible, including Prismo proxy readiness.
3. `watch --once` shows the current live local session view with warnings and next action.

For a guided scan + context generation flow, run:

```bash
npx getprismo dev
```

## Common Commands

```bash
npx getprismo scan --usage
npx getprismo scan --simple
npx getprismo setup
npx getprismo watch
npx getprismo scan --fix
npx getprismo optimize
npx getprismo context frontend
npx getprismo usage codex
npx getprismo usage claude
```

## Example Output

```text
PrismoDev

Score: 72/100  |  Risk: Medium  |  Token leaks: 5
Estimated avoidable waste: 20-40%

Top Token Leaks
1. Missing .claudeignore
2. Recent local AI sessions used 2.40M tokens
3. Large exposed file detected
4. Tool output/context contributed about 95k tokens
5. CLAUDE.md is ~1,900 tokens

Top Fix
Run: npx getprismo scan --fix
Then: npx getprismo optimize
Then: npx getprismo context frontend
```

## Setup And Live Watch

```bash
npx getprismo setup
```

Setup is read-only. It detects Claude Code, Codex, Cursor, local logs, MCP/tool config, and whether the Prismo proxy is reachable for exact API tracking.

```bash
npx getprismo watch
```

Watch is the local live session view. It shows active session tokens, context risk, tool/output token spikes, largest context sources, top tools, warnings, and the next recommended action.

For machine-readable output:

```bash
npx getprismo setup --json
npx getprismo watch --once --json
```

## Local Usage Tracking

Prismo can show real token usage when local tool logs expose token fields.

- Codex: reads local `~/.codex/sessions/**/*.jsonl`
- Claude Code: reads local `~/.claude/projects/**/*.jsonl`

If exact usage fields are present, Prismo marks the result as `exact-local-log`. If not, it falls back to local text-size estimates.

No API keys are required. Prismo does not proxy Claude Code subscription traffic or intercept prompts.

## Generated Files

`npx getprismo optimize` creates recommendation files in `.prismo/`:

- `.prismo/architecture-summary.md`
- `.prismo/backend-summary.md`
- `.prismo/frontend-summary.md`
- `.prismo/recommended-CLAUDE.md`
- `.prismo/recommended-AGENTS.md`
- `.prismo/recommended-.claudeignore`
- `.prismo/optimize-report.md`

These files are templates and context packs. Prismo does not overwrite your real `CLAUDE.md`, `AGENTS.md`, `.gitignore`, or `.claudeignore` during optimize.

## Safe Fix Mode

```bash
npx getprismo scan --fix
```

Fix mode can create:

- `.claudeignore` if missing
- `.claudeignore.prismo-suggested` if `.claudeignore` already exists
- `prismo-dev-report.md`
- `prismo-optimized-CLAUDE.template.md`
- `prismo-AGENTS-recommendations.md`

Existing reports and suggestion files are backed up before replacement.

## Help

```bash
npx getprismo --help
npx getprismo scan --help
npx getprismo demo
npx getprismo setup --help
npx getprismo watch --help
npx getprismo optimize --help
npx getprismo usage --help
```
