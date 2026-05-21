# prismodev

local ai coding cost control. one command to diagnose token waste, fix it, and prove the improvement.

```bash
npx getprismo doctor
```

that's it. run it on any repo. no api keys, no login, no data leaves your machine.

---

## the problem

ai coding agents (claude code, codex, cursor) burn tokens on things that don't help you ship. lockfiles get read into context. old logs get loaded. generated artifacts leak in. sessions balloon to millions of tokens because nothing tells the agent what to ignore.

most developers don't realize this is happening until the bill arrives or the agent starts looping.

prismodev catches it before, during, and after.

---

## the loop

prismodev is three commands that cover an entire coding session:

```
before you code     npx getprismo doctor
while you code      npx getprismo watch
after you code      npx getprismo cc timeline
```

**doctor** diagnoses the repo, applies safe fixes, and shows the before/after score.
**watch** monitors context pressure live and warns when things go wrong.
**cc timeline** reconstructs what happened in the session so you learn from it.
**shield** runs noisy commands without dumping full output back into the agent context.

---

## what prismodev catches

- missing `.claudeignore` / `.cursorignore` (the biggest single fix for most repos)
- lockfiles entering context (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`)
- generated artifacts leaking in (`__pycache__`, `dist/`, `coverage/`, `.next/`)
- operational source-stream dumps leaking in (`events/`, `source-streams/`, inbox/calendar/GitHub JSONL exports)
- oversized instruction files (`CLAUDE.md` or `AGENTS.md` over 500 tokens)
- tool output dominating sessions (repeated reads, large command output)
- long-running sessions with stale context accumulation
- repeated file reads (same file loaded 100+ times in one session)
- repeated commands (agent running the same command in a loop)
- high context risk sessions that should have been split at task boundaries

---

## real output: doctor

run `npx getprismo doctor` on any repo. here's what it looks like on a real project:

```
PrismoDev Doctor

Before: 79/100 - Medium risk - 5 token leaks
After:  91/100 - Low risk - 3 token leaks (+12)
Local usage: 976k tokens across 3 recent session(s)
Estimated exposed context reduction: 100%
Payoff: repo is 12 points cleaner for AI coding sessions

Fixed:
- Created .claudeignore
- Created .cursorignore
- Generated prismo-dev-report.md
- Generated .prismo/architecture-summary.md
- Generated .prismo/recommended-CLAUDE.boilerplate.md
- Generated .prismo/recommended-AGENTS.boilerplate.md
- Generated .prismo/recommended-.claudeignore
- Generated .prismo/recommended-.cursorignore
- Generated .prismo/recommended-.gitignore-additions
- Generated .prismo/backend-summary.md
- Generated .prismo/frontend-summary.md

Still Risky:
- Tool output/context contributed about 319k tokens
- 1 recent session reached high context risk

Recommended starting context:
.prismo/frontend-context.md

Next:
1. npx getprismo context frontend
2. npx getprismo watch --once
3. npx getprismo cc
```

doctor went from 79 to 91 in one run. the repo now has proper ignore files, compact context packs, and a clear starting point for the next coding session.

---

## real output: watch

run `npx getprismo watch` during a coding session. it monitors context pressure in real time:

```
Prismo Watch

Context Pressure: HIGH
Session Size: 707k tokens (exact-local-log)
Recent Growth: +0 tokens
Tool Output: 237k tokens
Turns: 102  |  Tool calls: 774
Model: gpt-5.5

Warnings
- Context risk is high; consider starting a fresh session.
- Tool/output tokens are dominating this session.
- lib/prismo-dev-scan.js appears repeatedly in context (286x).
- node bin/prismo.js appears repeatedly in context (85x).
- lockfiles likely entered active context (60 mentions).

Do This Now
Cause: tool-output-flood (high confidence)
Tool/output tokens are dominating this session (237k tokens).
1. Stop loading full logs or broad command output.
2. Rerun failing commands with tight filters or short ranges.
3. Ask the agent to summarize current errors before reading more files.
Rescue: npx getprismo watch --rescue

Signals
- Repeated file: lib/prismo-dev-scan.js (286x)
- Repeated file: node bin/prismo.js (85x)
- Generated artifacts: lockfiles (60 mentions)
- Generated artifacts: __pycache__ (47 mentions)

Suggested Action
Run: npx getprismo doctor
```

watch caught lockfiles entering context, a file being read 286 times, and tool output dominating the session. without this, you'd never know.

---

## new: context shield

if you know a command may dump huge output, run it through prismo:

```bash
npx getprismo shield -- npm test
npx getprismo shield -- pytest -q
npx getprismo shield -- npm run build
```

shield executes the command locally, stores full stdout/stderr under `.prismo/shield/runs/`, indexes the output in `.prismo/shield/shield.sqlite` using SQLite FTS5 when available, and prints only a compact summary plus useful error lines.

this is the lightweight context-sandbox layer: the full output stays on disk until you explicitly inspect it, instead of being pasted into the model context and re-sent every turn.

example:

```text
Prismo Shield

Command: npm test
Exit: 1
Captured: 186 KB (~46,500 tokens kept out of chat)

Full Output Stored:
- .prismo/shield/runs/2026-05-20T.../stdout.txt
- .prismo/shield/runs/2026-05-20T.../stderr.txt
- .prismo/shield/shield.sqlite

Summary Returned To Context:
- ERROR: auth.test.ts expected 200 received 401
- FAIL src/auth/session.test.ts
```

search previous shield output without reloading whole logs:

```bash
npx getprismo shield last
npx getprismo shield search "auth expected 200"
npx getprismo shield search "AUTH_FAILURE" --json
```

this is intentionally not magic interception yet. it is a safe local-first primitive you can tell agents to use for noisy commands.

---

## new: live guardrails mode

the easiest proactive mode is:

```bash
npx getprismo watch --auto
```

`--auto` turns on live guardrails, live context throttling, event logging, and a default 600k session budget. it writes:

```text
.prismo/live-guardrails.md
.prismo/live-context-throttle.md
.prismo/live-rescue-prompt.md
.prismo/watch-events.jsonl
```

if you want prismodev to keep updating instructions while the session runs, use:

```bash
npx getprismo watch --guardrails
```

this writes and continuously updates:

```text
.prismo/live-guardrails.md
.prismo/live-rescue-prompt.md
```

the idea is simple: tell your coding agent once at the start of the session:

```text
follow .prismo/live-guardrails.md during this session.
```

then keep `watch --guardrails` running. when prismodev detects tool-output floods, artifact leaks, repeated reads, loops, or context spikes, it updates the guardrails file with the current issue and the exact behavior the agent should follow next.

example guardrails:

```md
# Prismo Live Guardrails

Context pressure: High
Current issue: tool-output-flood
Confidence: high

## Effective Immediately

- Stop loading full logs or broad command output.
- Rerun failing commands with tight filters or short ranges.
- Ask the agent to summarize current errors before reading more files.
- Do not read generated artifacts, lockfiles, caches, build output, coverage, or logs unless explicitly required.
```

this does not secretly control claude code or codex internals. it gives the agent a live-updating instruction file to follow, which is the safest local-first way to reduce token waste without requiring an IDE extension or agent plugin.

---

## new: live rescue mode

when `watch` detects a session going sideways, run:

```bash
npx getprismo watch --rescue
```

it prints a paste-ready rescue prompt for the current ai coding session:

```text
Prismo Rescue Prompt

Paste this into the current AI coding session:

We are in a high-context AI coding session. Stop broad exploration and recover state before doing more work.

Current Prismo signal: tool-output-flood (high confidence).
Summary: Tool/output tokens are dominating this session (264k tokens).
Context pressure: High. Session size: 1.11M tokens. Tool output: 264k tokens.

Do this now:
1. Stop loading full logs or broad command output.
2. Rerun failing commands with tight filters or short ranges.
3. Ask the agent to summarize current errors before reading more files.

Before reading or editing anything else, summarize:
- files changed so far
- exact failing command or error
- current hypothesis
- next smallest file/test to inspect

Do not re-read these files unless they changed.
Do not read generated/noisy artifacts unless explicitly required.
```

`watch --rescue --json` includes the same prompt as `rescuePrompt`, plus the structured live action:

```json
{
  "live": {
    "contextPressure": "High",
    "liveAction": {
      "cause": "tool-output-flood",
      "confidence": "high",
      "summary": "Tool/output tokens are dominating this session.",
      "rescueAvailable": true
    }
  }
}
```

live action causes include:

- `tool-output-flood`
- `artifact-leak`
- `possible-loop`
- `repeated-file-read`
- `context-spike`
- `high-context-pressure`

this is the proactive part of prismodev: it does not just tell you something is expensive. it tells you what to do **right now** while the session is still recoverable.

use `--guardrails` when you want files to update automatically during the session. use `--rescue` when you want a one-shot prompt to paste immediately.

---

## new: live context throttle

if you want prismodev to enforce a session budget while you work, run:

```bash
npx getprismo watch --throttle --budget 600k
```

this writes:

```text
.prismo/live-context-throttle.md
```

when the active session gets near or crosses the budget, watch turns that into a live action:

```text
Cause: token-budget-exceeded
Stop broad exploration.
Summarize current state before more file reads.
Start a fresh scoped session at the next task boundary.
```

use it with guardrails for the most proactive setup:

```bash
npx getprismo watch --auto
```

that gives the agent a live instruction file, a rescue prompt, and a stricter context throttle file that updates as the session changes.

`watch --auto` also appends changed live warnings to `.prismo/watch-events.jsonl`, so expensive-session events can be reused later in postmortems.

Use `--no-events` when you want live protection without writing session event history:

```bash
npx getprismo watch --auto --no-events
```

---

## new: context firewall

generate a scoped context policy before a task:

```bash
npx getprismo firewall auth-bug
```

this writes:

```text
.prismo/context-firewall.md
.prismo/allowed-context.txt
.prismo/blocked-context.txt
.prismo/firewall-prompt.md
```

the firewall tells the agent what it should read first and what it should avoid unless it explains why. this is the prevention layer: instead of only warning after context bloat happens, prismodev gives the agent a smaller context boundary up front.

example:

```text
Allowed first:
- .prismo/architecture-summary.md
- .prismo/backend-summary.md
- backend/app/*/auth/*

Blocked unless justified:
- node_modules/**
- .next/**
- dist/**
- coverage/**
- package-lock.json
```

`watch --auto` also updates `.prismo/context-firewall.md` when it detects live waste, so the active session gets a tighter context policy as pressure rises.

---

## real output: cc timeline

run `npx getprismo cc timeline` after a session to understand what happened:

```
Prismo Claude Code Cost

Session: 7689982e-42a3-44fb-9734-2588e5e01145
Model: claude-opus-4-6

Timeline
05:24 PM  Generated artifact likely entered context  package-lock.json (2x)
05:24 PM  Generated artifact likely entered context  logs/debug-output.json (1x)
05:24 PM  Repeated file/path context  CLAUDE.md (8x)
05:24 PM  Repeated file/path context  AGENTS.md (8x)
05:24 PM  Repeated file/path context  node bin/prismo.js (6x)

Suggested Action
Run npx getprismo optimize, then start from .prismo/architecture-summary.md.
```

timeline shows exactly what leaked, what repeated, and what to do differently next time.

---

## how doctor improves a repo

doctor does four things in sequence:

1. **scans** the repo and reads local codex/claude code session logs
2. **applies safe fixes** — creates `.claudeignore`, `.cursorignore`, generates recommendation templates
3. **generates context packs** — compact `.prismo/` files that give agents focused context instead of reading everything
4. **re-scans** and shows the before/after score

what doctor creates:

```
.claudeignore                              blocks waste from claude code
.cursorignore                              blocks waste from cursor
.prismo/architecture-summary.md            compact project overview for agents
.prismo/backend-summary.md                 backend-specific context
.prismo/frontend-summary.md                frontend-specific context
.prismo/recommended-CLAUDE.boilerplate.md              CLAUDE.md boilerplate reference; do not overwrite curated files
.prismo/recommended-AGENTS.boilerplate.md              AGENTS.md boilerplate reference; do not overwrite curated files
.prismo/recommended-.claudeignore          full recommended ignore list
.prismo/recommended-.cursorignore          full recommended ignore list
.prismo/recommended-.gitignore-additions   things your gitignore might be missing
prismo-dev-report.md                       full diagnostic report
```

if an existing `.claudeignore` or `.cursorignore` already covers prismo's recommendations, doctor skips the suggested ignore file instead of creating redundant noise. the default recommendations include common project state, local db, export, credential, and token patterns such as `*_state.json`, `*_tokens.json`, `*_export.json`, `*.sqlite`, `models/`, and `state-backups/`.

backend and frontend summaries include load-bearing candidates ranked by import references, text-reference signals, recent git touches when available, and file size, not just directory listings.

prismo also flags source-stream dumps separately from normal build artifacts. large inbox/calendar/github/event payload files are treated as operational noise because they often get summarized once, written near the repo, and then accidentally re-read by later coding sessions.

what doctor never touches:

- your real `CLAUDE.md`
- your real `AGENTS.md`
- your `.gitignore`
- any source code
- any config files

it only creates new files and recommendations. you decide what to apply.

---

## how watch catches waste live

watch reads local session logs from codex and claude code. it detects:

| signal | what it means |
|--------|--------------|
| context pressure HIGH | session is consuming too many tokens |
| repeated file 286x | agent keeps re-reading the same file |
| lockfiles entered context | `package-lock.json` got loaded (pure waste) |
| tool output dominating | agent output is larger than actual code context |
| loop suspicion | agent may be stuck in a command loop |
| recent growth +380k | context just spiked by 380k tokens |

watch tells you the single most useful action to take right now. usually: start a fresh session, or switch to a scoped context pack.

`watch --rescue` prints a paste-ready prompt for the active coding session. use it when the agent is looping, reading too many files, or flooding context with logs:

```bash
npx getprismo watch --rescue
```

the rescue prompt tells the agent to stop broad exploration, summarize changed files and current failures, avoid noisy artifacts, and continue from the next smallest useful file/test.

watch is tuned for large repos:

- ignores absolute paths outside the target repo
- keeps generated artifacts out of repeated-source-file actions
- groups lockfiles, `__pycache__`, `node_modules`, and hashed build assets separately
- only treats repeated non-generated files as actionable when they exist inside the target repo

this keeps large-repo output focused on real source context instead of path noise from old logs or unrelated projects.

---

## quick start

```bash
# see what prismodev does without touching anything
npx getprismo demo

# simple plain-english check
npx getprismo scan --simple

# the full workflow
npx getprismo doctor
npx getprismo watch --once
npx getprismo cc timeline
```

if you don't have node installed, get it from [nodejs.org](https://nodejs.org) (LTS). then:

```bash
node -v   # should print 18+
npx getprismo doctor
```

no install needed. npx runs it directly.

---

## all commands

| command | what it does |
|---------|-------------|
| `doctor` | diagnose, fix, optimize, show before/after |
| `watch` | live session monitoring with warnings |
| `cc` | claude code cost breakdown |
| `cc timeline` | session reconstruction with events |
| `scan --usage` | full repo scan with local usage data |
| `scan --simple` | plain-english summary |
| `scan --fix` | create safe fix files |
| `scan --ci` | fail CI when token-risk gates fail |
| `optimize` | generate `.prismo/` context packs |
| `context` | print paste-ready prompt for agents |
| `shield` | run noisy commands while keeping full output out of chat |
| `setup` | detect tools, logs, proxy readiness |
| `usage` | show raw session token usage |
| `init` | add npm scripts and .prismo/README.md |
| `demo` | sample output without reading your repo |

---

## doctor modes

```bash
npx getprismo doctor                     # full run
npx getprismo firewall auth-bug          # generate scoped context firewall
npx getprismo doctor --dry-run           # preview without writing files
npx getprismo doctor --apply-ignores-only # only create ignore files
npx getprismo doctor --no-context-packs  # skip .prismo/ generation
npx getprismo doctor frontend            # scope to frontend
npx getprismo doctor --json              # machine-readable output
```

---

## watch modes

```bash
npx getprismo watch                      # live refresh
npx getprismo watch --once               # single snapshot
npx getprismo watch --once --report      # write .prismo/watch-report.md
npx getprismo watch --once --json        # machine-readable
npx getprismo watch --auto               # guardrails + throttle + 600k budget
npx getprismo watch --auto --no-events   # live protection without event history
npx getprismo watch --guardrails         # update .prismo/live-guardrails.md continuously
npx getprismo watch --guardrails --json  # include guardrailsPath and rescuePath
npx getprismo watch --throttle --budget 600k # enforce a live context budget
npx getprismo watch --events             # append changed warnings to .prismo/watch-events.jsonl
npx getprismo watch --rescue             # paste-ready live-session rescue prompt
npx getprismo watch --rescue --json      # include rescuePrompt in JSON
npx getprismo watch --once --redact-paths # hide local paths
npx getprismo watch codex                # only codex sessions
npx getprismo watch claude               # only claude code sessions
```

### shield mode

```bash
npx getprismo shield -- npm test
npx getprismo shield -- pytest -q
npx getprismo shield --json -- npm run build
npx getprismo shield last
npx getprismo shield search "auth failure"
```

---

## cc modes

```bash
npx getprismo cc                         # latest session cost
npx getprismo cc timeline                # event timeline for latest session
npx getprismo cc list                    # list recent sessions
npx getprismo cc last 5                  # last 5 sessions
npx getprismo cc all                     # everything
npx getprismo cc timeline --json         # machine-readable timeline
```

---

## ci integration

```bash
npx getprismo scan --ci --no-report
```

exits non-zero when:
- score is below threshold
- risk is too high
- ai ignore files are missing
- generated artifacts are exposed
- large files are exposed

add to your ci:

```json
{
  "scripts": {
    "ai:ci": "prismo scan --ci --no-report"
  }
}
```

---

## scoped context packs

prismodev generates context packs scoped to different areas of your codebase:

```bash
npx getprismo optimize frontend
npx getprismo optimize backend
npx getprismo optimize auth
npx getprismo context frontend          # prints a paste-ready prompt
npx getprismo context backend
```

use these as the starting point for coding sessions instead of letting agents explore the whole repo.

---

## tracking modes

```
local scan        heuristic repo/context risk, no keys needed
local logs        exact when codex/claude session logs expose token fields
prismo proxy      exact usage/cost when traffic routes through prismo base url
```

prismodev reads local session logs from:
- codex: `~/.codex/sessions/**/*.jsonl`
- claude code: `~/.claude/projects/**/*.jsonl`

no api keys. no intercepted prompts. no data uploaded.

---

## what gets generated

```
.prismo/
├── architecture-summary.md
├── backend-summary.md
├── frontend-summary.md
├── frontend-context.md
├── backend-context.md
├── recommended-CLAUDE.boilerplate.md
├── recommended-AGENTS.boilerplate.md
├── recommended-.claudeignore
├── recommended-.cursorignore
├── recommended-.gitignore-additions
├── optimize-report.md
└── watch-report.md (when using --report)
```

all recommendation files. nothing is overwritten. you decide what to use.

---

## init (npm project setup)

```bash
npx getprismo init
```

adds to your `package.json`:

```json
{
  "scripts": {
    "ai:doctor": "prismo doctor",
    "ai:watch": "prismo watch",
    "ai:context": "prismo context",
    "ai:scan": "prismo scan --usage"
  }
}
```

then your team can run `npm run ai:doctor` without remembering the full command.

---

## philosophy

- local first. nothing leaves your machine.
- safe by default. doctor never overwrites your real config files.
- exact when possible. reads real session logs when agents expose them.
- honest about limits. uses "likely" and "estimate" language when visibility is limited.
- one suggested action. every output ends with the single best thing to do next.

---

## works with

- claude code (subscription and api modes)
- openai codex
- cursor
- any tool that respects `.claudeignore` or `.cursorignore`
- any repo (node, python, go, rust, vue, svelte, astro, monorepos, whatever)

---

## internal layout

```
lib/prismo-dev-scan.js           cli entry and command dispatch
lib/prismo-dev/constants.js      shared defaults, pricing, patterns
lib/prismo-dev/context-optimize.js  context packs, scoped prompts
lib/prismo-dev/doctor.js         doctor/dev/init orchestration
lib/prismo-dev/fixes.js          safe ignore/template generation
lib/prismo-dev/report.js         terminal, markdown, ci reports
lib/prismo-dev/scan.js           repo scanning, scoring, readiness
lib/prismo-dev/usage-watch.js    local logs, watch, cost, timeline
```

---

## help

```bash
npx getprismo --help
npx getprismo doctor --help
npx getprismo watch --help
npx getprismo cc --help
npx getprismo scan --help
```
