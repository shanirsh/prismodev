# prismodev

[![npm version](https://img.shields.io/npm/v/getprismo.svg)](https://www.npmjs.com/package/getprismo)
[![npm downloads](https://img.shields.io/npm/dw/getprismo.svg)](https://www.npmjs.com/package/getprismo)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Agent control plane for AI coding.

Prismo watches local Codex, Claude Code, and Cursor sessions, finds wasted agent context, applies safe interventions, and verifies whether those interventions actually saved tokens and dollars in later sessions.

```bash
npx getprismo protect
```

That one command turns on the useful stack for a repo:

- safe ignore rules and compact context packs
- Claude Code runtime enforcement when hooks are available
- loop and context-waste protection
- connector-driven repair and verification when connected to Prismo Cloud

## Why

AI coding agents waste real money and time on context that does not help them ship:

- full test/build logs entering chat
- lockfiles, build output, coverage, and caches getting read
- the same files being opened again and again
- retry loops that keep running the same failing command
- long sessions carrying stale context across tasks

Prismo turns those patterns into controls, then measures the result.

## What Gets Measured

The launch report is built around proof, not vibes:

- **Verified saved**: tokens and dollars saved after later sessions prove waste dropped
- **Live prevented**: estimated tokens blocked before they entered context
- **Proactivity**: live detections, interventions, and loop stops while coding
- **Still measuring**: interventions waiting for enough later sessions to verify impact
- **Top cause**: the waste pattern causing the most damage

```bash
npx getprismo digest
```

Example output:

```text
Prismo controlled 21 AI coding session(s) over 7 day(s).
Verified saved: ~0 tokens / $0.00.
Live prevented: ~0 tokens / $0.00 estimated.
Proactivity: 2 live control event(s), 65 intervention(s) or loop stop(s).
Interventions: 65 completed, 0 verified improved, 3 still measuring.
Context observed: 620,000 tokens; pre-control opportunity: ~286,000 tokens.
Top cause: Tool-output floods (~286,000 tokens).
```

## Core Commands

```bash
npx getprismo doctor                 # diagnose and apply safe repo fixes
npx getprismo protect                # one-command protection for this repo
npx getprismo shield -- npm test     # keep noisy command output out of agent context
npx getprismo enforce install        # Claude Code runtime context/loop enforcement
npx getprismo agent --watch          # run the local repair/verification agent
npx getprismo digest                 # launch report with verified savings
```

Full command docs: [docs/manual.md](docs/manual.md).

## Cloud Connector

Local-only mode works without login:

```bash
npx getprismo doctor
npx getprismo protect
```

Connect when you want the dashboard, repair queue, live control feed, verified savings, and fleet learning:

```bash
npx getprismo connect --token <your Prismo API key>
npx getprismo connector install
```

The connector syncs aggregate session telemetry, claims safe repairs, publishes live control events, and verifies impact against future sessions.

## Privacy

PrismoDev does **not** upload raw prompts, source code, stdout, stderr, or full command logs.

It syncs metadata needed for the control plane:

- repo identity and branch
- tool name and session id
- token totals and risk scores
- top waste cause
- intervention status
- verified saved tokens/dollars

Detailed telemetry docs: [docs/privacy-telemetry.md](docs/privacy-telemetry.md).

## Runtime Enforcement

Claude Code can be hard-blocked through hooks:

```bash
npx getprismo enforce install
```

This can deny blocked-context reads and repeated command loops before they spend tokens. Codex and Cursor are visible and repairable through logs, MCP, shield, and guardrails; universal hard-blocking for those agents requires wrapper or deeper pre-tool hooks.

## Beta Test Loop

For the proof week:

```bash
npx getprismo protect
npx getprismo connector status
npx getprismo digest
```

Then code normally. Do not optimize for the demo. Let Prismo observe real sessions, intervene where it can, and verify the savings later.

At the end:

```bash
npx getprismo digest --days 7
```

Those lines are the launch post.

## Development

```bash
npm test
node bin/prismo.js protect --json
node bin/prismo.js digest --json
```

More docs: [docs/README.md](docs/README.md).
