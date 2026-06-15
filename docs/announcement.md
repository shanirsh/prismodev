# Launch drafts

Built on real numbers from a week of dogfooding (getprismo 0.1.52). Verified figures are measured against actual later sessions, never estimated — keep that distinction in every claim, it's the whole point.

Snapshot used below (one developer, ~1 week, single machine):
- **Verified saved: $22.81 (6,338,568 tokens)** — repairs whose savings were confirmed by a lower waste rate in later sessions.
- Observed: 141 sessions, 11.69M tokens, ~5.3M flagged avoidable.
- Per-developer annualized ≈ **$1,100/yr**; a 10-dev team ≈ **$11k/yr** — verified, not projected from a model.

---

## Show HN

**Title:** Show HN: Prismo – an AI-coding cost agent that verifies its own savings ($22/wk/dev)

**Body:**

AI coding agents (Claude Code, Codex, Cursor) quietly waste a big share of their tokens: re-reading the same file hundreds of times, dumping full test output into context, loading lockfiles and build artifacts, retrying a failing command over and over. Most tools here show you a dashboard of the damage and stop. I wanted one that *fixes* it and then *proves* the fix worked.

Prismo runs locally — `npx getprismo doctor`, no login, nothing leaves your machine — reads your agents' own session logs, and attributes waste to one of five causes. Connect it and it closes the loop:

- A local planner repairs the top cause automatically. Each cause gets a dedicated fix (ignore rules + context packs, shielded commands, a context firewall, scoped session restarts) — not one generic "optimize."
- After each repair it measures that cause's waste rate in your *later* sessions and stores a verdict: improved / no-change / regressed (14-day baseline, before/after rates, 1% epsilon — the math is in the repo).
- A repair that doesn't help escalates to a stronger tier; one that fails both tiers is held for human review instead of being retried forever.
- For Claude Code it goes past advice: a PreToolUse hook actually *denies* reads into blocked context and the 4th retry of an identical failing command (fail-open, removed with one command).
- Savings are reported in dollars, **verified against real usage, not estimated**, with a weekly digest you can paste into Slack.

I dogfooded it on my own machine for a week. It verified **$22.81 / 6.3M tokens saved** (≈ $1,100/yr/dev annualized) — and, more honestly, the week of dogfooding caught **six real bugs in Prismo itself**, including one where it silently dropped *all* Claude Code telemetry for any repo whose path contains a space (e.g. `~/Code Projects/...`), and a verification bug where mixing in Cursor (which can't report the signal) poisoned the baseline so nothing ever verified. Both are fixed; finding them this way is kind of the best argument for the verify-everything design.

MIT-licensed, the verification and enforcement logic is all in the open: https://github.com/shanirsh/prismodev — would love feedback on the enforcement model and the verdict thresholds.

---

## X / Twitter thread

1/ Every AI-coding-cost tool shows you a dashboard of waste. I built the one that fixes it — then proves the fix worked, in dollars, measured against your real later sessions.

2/ One week dogfooding on my own machine: **$22.81 / 6.3M tokens verified saved** (~$1,100/yr/dev). "Verified" = a repair ran, then later sessions showed a measurably lower waste rate. Not an estimate.

3/ How: it reads your Claude Code / Codex / Cursor logs locally, attributes waste to 5 causes, and repairs the top one — each cause gets its own fix, not a generic "optimize."

4/ The part nobody else does: after a repair it re-measures that cause in your NEXT sessions. Improved → stand down. No change → escalate to a stronger repair. Failed twice → stop and ask a human. A feedback controller, not a script.

5/ For Claude Code it's not advisory — a PreToolUse hook *denies* reads into node_modules/logs/build output and blocks the 4th retry of an identical failing command. Fail-open, one command to remove.

6/ Most honest part: a week of dogfooding caught 6 real bugs in Prismo itself — including one that silently hid ALL Claude Code data for any repo path with a space in it. Verifying everything is how you find that.

7/ `npx getprismo doctor` — 10 seconds, no login, local-only. MIT: github.com/shanirsh/prismodev

---

## Release notes (0.1.40 → 0.1.52)

- **Cause-specific repair executors** — targeted repairs per waste cause instead of generic doctor; `prismo repair <cause|auto>`.
- **Autonomous repair planner** — `agent --watch` self-repairs with thresholds, per-cause cooldowns, local before/after verdicts, and mild→aggressive escalation.
- **Runtime enforcement** — `prismo enforce install` adds Claude Code Pre/PostToolUse hooks that block blocked-context reads and failing-command loops; fail-open; outcome-aware.
- **Verified savings in dollars** — `prismo digest`; the dashboard leads with verified dollars, with live prevention and early signals labeled separately.
- **Fleet priors** — first repairs start at the tier the fleet's verified outcomes recommend (anonymized counts only; local verdicts always win).
- **Multi-repo capture** — one connector observes every repo on the machine, each session attributed to its own repo.
- **One-command protect** — `prismo protect` runs the full stack (safe fixes + context packs + enforcement + connector).
- **CI releases** — tag push runs tests and publishes.

### Bugs the dogfood week caught (and fixed)
1. Digest counted background auto-detect scans as interventions (186 fake vs 3 real).
2. Verification baseline poisoned by Cursor's blind zero-signals — now compares like-for-like across tools.
3. Claude Code telemetry silently dropped for repo paths containing a space or dot (folder-name encoding mismatch).
4. Connector was single-repo — now captures every repo.
5. `prismo protect` silently repointed a running connector (checked a field that never existed).
6. Dashboard polling (every 8s, loading a large unused column) blew past the DB egress quota — deferred the column, slowed/gated polling, windowed scans.
