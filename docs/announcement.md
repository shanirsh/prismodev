# Announcement drafts

Working drafts for the autonomous-loop release (getprismo 0.1.42). Edit freely; numbers in brackets should be replaced with real figures from the dashboard once a week of verdicts has accumulated.

---

## Show HN

**Title:** Show HN: Prismo — an autonomous cost agent for AI coding that verifies its own fixes

**Body:**

AI coding agents (Claude Code, Codex, Cursor) waste a surprising share of their tokens: re-reading the same file hundreds of times, dumping full test output into context, loading lockfiles and build artifacts, retrying the same failing command. Most tools in this space show you a dashboard of the damage and stop there.

Prismo closes the loop. It runs locally (`npx getprismo doctor` to try it — no login, nothing leaves your machine), reads your agents' own session logs, and attributes waste to one of five causes. Then, if you connect it:

- a local planner repairs the top cause automatically — each cause has a dedicated fix, not a generic one
- after every repair, it measures the waste rate for that cause in your *later* sessions and stores a verdict: improved, no-change, or regressed
- failed repairs escalate to a stronger tier (context firewall, tighter budgets); a cause that fails both tiers is held for human review instead of being retried forever
- for Claude Code it goes further than advice: a PreToolUse hook actually denies reads into blocked context and the fourth retry of an identical command (fail-open, removable with one command)
- savings are reported in dollars, verified against real usage — not estimated — with a weekly digest you can paste into Slack
- and the planner learns from the fleet: anonymized repair verdicts (counts only) aggregate into priors, so your first repair starts at the tier that's known to work

In our own dogfooding it [verified ~$X saved across N sessions in the first week].

The CLI is MIT-licensed: https://github.com/shanirsh/prismodev — the verification loop math is in the repo (14-day baseline, before/after waste rates, 1% epsilon). Would love feedback on the enforcement design and the verdict thresholds.

---

## X / Twitter thread

1/ Every AI-coding-cost tool shows you a dashboard of waste. We built the thing that fixes it — and then proves the fix worked, in dollars.

2/ Prismo watches your Claude Code / Codex / Cursor sessions locally, attributes waste to 5 causes, and repairs the top one automatically. Ignore rules, shielded commands, context firewalls, scoped restarts — each cause gets its own fix.

3/ The part nobody else does: after a repair, it measures that cause's waste rate in your NEXT sessions. Improved → stand down. No change → escalate to a stronger repair. Failed twice → stop and ask a human. It's a feedback controller, not a script.

4/ For Claude Code it's not advisory. `prismo enforce install` wires a hook that *denies* reads into node_modules/logs/build output and blocks the 4th retry of an identical failing command. Fail-open, one command to remove.

5/ And it learns across every install: anonymized repair verdicts roll up into fleet priors, so your first repair starts at the tier the fleet already knows works. The more users, the smarter every agent gets.

6/ Monday morning: `prismo digest` → "Prismo saved you ~$X this week — verified against your sessions." Paste it in Slack. The product re-justifies itself weekly.

7/ Try it in 10 seconds, no login, local-only: `npx getprismo doctor` — MIT licensed → github.com/shanirsh/prismodev

---

## Release notes (0.1.40 → 0.1.42)

- **Cause-specific repair executors** — workspace actions with a `targetCause` run a targeted repair (repeated-file-reads, tool-output-flood, generated-artifacts, context-loop, long-session-buildup) instead of generic doctor; `prismo repair <cause>` runs them standalone.
- **Autonomous repair planner** — `agent --watch` self-repairs on an interval with thresholds, per-cause cooldowns, local before/after verdicts, and mild→aggressive escalation; `prismo repair auto [--dry-run]`.
- **Runtime enforcement** — `prismo enforce install` adds a Claude Code PreToolUse hook denying blocked-context reads and identical-command loops; fails open; `enforce uninstall` reverts.
- **Verified savings in dollars** — `prismo digest [--days N]` prints the weekly verified-savings summary; the dashboard leads with dollars.
- **Fleet priors** — first repairs start at the tier the fleet's verified outcomes recommend (anonymized counts only; local verdicts always win).
- **Cloud escalation + dedupe** — auto-queued repairs escalate after failed verdicts; duplicate actions are deduped at creation and claim.
- **CI releases** — tag push runs tests and publishes.
