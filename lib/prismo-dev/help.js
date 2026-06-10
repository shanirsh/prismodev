const MAIN_HELP = `Prismo CLI

Usage:
  prismo --version
  prismo dev [path]
  prismo init [--json] [--dry-run] [path]
  prismo doctor [--json] [--dry-run] [--apply-ignores-only] [--apply-suggestions] [--no-context-packs] [--limit N] [path]
  prismo firewall [task] [--json] [--dry-run] [path]
  prismo benchmark [session] [--json] [--limit N] [path] [-- <command ...>]
  prismo shield [--json] [path] -- <command ...>
  prismo shield last [--json] [--limit N] [path]
  prismo shield search <query> [--json] [--limit N] [path]
  prismo mcp [path]
  prismo mcp doctor [--json] [path]
  prismo connect [--json] [--token TOKEN] [--api-url URL] [--org ORG] [--user USER] [--device NAME]
  prismo connector [status|install|start|stop|uninstall] [--json] [--interval N] [--sync-interval N] [--mode observe|suggest|autopilot] [path]
  prismo sync [--json] [--dry-run] [--watch] [--interval N] [--limit N] [--tool all|codex|claude|cursor] [path]
  prismo status [--json]
  prismo disconnect [--json]
  prismo agent [--json] [--once] [--watch] [--interval N] [--sync-interval N] [--limit N] [--mode MODE] [path]
  prismo setup [--json] [--proxy-url URL] [path]
  prismo scan [--fix] [--ci] [--json] [--usage] [--optimizer-fit] [--report-card] [--simple] [--no-report] [path]
  prismo optimize [scope] [--json] [path]
  prismo context [scope] [--json] [path]
  prismo cc [list|last N|all|timeline] [--json] [--limit N] [--firewall] [--task TASK] [path]
  prismo cursor [list|authorship|timeline|files|all] [--json] [--limit N] [path]
  prismo receipt [codex|claude|cursor|all] [--json] [--limit N] [path]
  prismo instructions audit [--json] [--limit N] [path]
  prismo instructions ablate --dry-run [--json] [--limit N] [--samples N] [path]
  prismo instructions apply [--dry-run] [--json] [--limit N] [path]
  prismo timeline [codex|claude|cursor|all] [--json] [--last N] [path]
  prismo replay [codex|claude|cursor|all] [--json] [--limit N] [path]
  prismo boundaries [codex|claude|cursor|all] [--json] [--limit N] [path]
  prismo usage [codex|claude|cursor|all] [--json] [--limit N] [path]
  prismo guard [codex|claude|cursor|all] [--json] [--watch] [--once] [--no-sync] [--dry-run] [--limit N] [--budget N] [--interval N] [path]
  prismo repair <cause|auto> [--json] [--dry-run] [--tier mild|aggressive] [--limit N] [--budget N] [--scope SCOPE] [path] [-- <command ...>]
  prismo watch [codex|claude|cursor|all] [--json] [--once] [--agents] [--report] [--rescue] [--guardrails] [--throttle] [--events] [--no-events] [--auto] [--budget N] [--redact-paths] [--interval N] [path]
  prismo demo

Commands:
  dev         Guided flow: scan, optimize, and print a paste-ready context prompt.
  init        Add local PrismoDev helper docs and npm scripts when package.json exists.
  doctor      Diagnose, safely optimize, re-scan, and show before/after payoff.
  firewall    Generate allowed/blocked context policy files for an AI coding task.
  benchmark   Measure command-output savings or recent session round-trip context.
  shield      Run a noisy command, store full output locally, and return a compact summary.
  mcp         Start a local MCP server exposing Prismo tools over stdio.
  connect     Store a PrismoDev cloud connection for seamless dashboard sync.
  connector   Install or manage the background Prismo Workspace connector.
  sync        Send safe aggregate local agent telemetry to Prismo; use --watch for background-style sync.
  status      Show local PrismoDev connection and last sync state.
  disconnect  Remove the local PrismoDev cloud connection.
  agent       Claim and execute safe workspace actions queued from Prismo Cloud.
  scan        Run PrismoDev for Claude Code, Codex, Cursor, and AI coding workflows.
  optimize    Generate lightweight AI-readable project context files in .prismo/.
  context     Print a copy-pasteable compact context prompt for AI coding tools.
  cc          Show Claude Code token cost, cache cost, and all-time totals.
  cursor      Show Cursor session data, AI authorship, and AI-generated file tracking.
  receipt     Generate a run receipt for reads, repeats, output, artifacts, and next-run scope.
  instructions Audit or ablate CLAUDE.md / AGENTS.md rule ROI, violations, partial compliance, duplicates, and influence-unknown rules.
  timeline    Show recurring context-waste patterns across recent sessions.
  replay      Reconstruct why a session went sideways and print a recovery prompt.
  boundaries  Check whether parallel agents are isolated or overlapping.
  usage       Read local Codex/Claude Code/Cursor session logs and summarize token usage.
  guard       Run proactive local guardrails and sync prevention events to Prismo.
  repair      Run the cause-specific repair for a detected waste cause; "auto" lets the planner pick.
  watch       Refresh local session usage in the terminal.
  demo        Show sample output without needing a messy repo.
  setup       Detect coding tools, tracking modes, local logs, and Prismo proxy readiness.

Options:
  --fix       Safely create .claudeignore if missing and generate the report.
  --ci        Fail with exit code 1 when token-risk gates fail.
  --json      Output valid JSON only for CI or future dashboard ingestion.
  --usage     Include real local Codex/Claude Code session usage in scan diagnostics.
  --optimizer-fit Recommend the right optimization path for this repo/session.
  --report-card Print a short plain-English optimization report card.
  --simple    Print a plain-English scan summary for first-time or non-technical users.
  --no-report Do not write .prismo/prismo-dev-report.md.
  --limit N   Number of recent local sessions to show.
  --firewall Generate cc timeline-derived firewall suggestion files.
  --task TASK Name the task for timeline-derived firewall suggestions.
  --interval N Refresh interval in seconds for watch mode.
  --sync-interval N Telemetry sync interval in seconds for the background connector.
  --dry-run  Preview doctor/fix actions without writing files.
  --apply-ignores-only Only create/suggest AI ignore files in doctor mode.
  --apply-suggestions Append missing recommended ignore rules with backups.
  --no-context-packs Skip .prismo context-pack generation in doctor mode.
  --report   Write .prismo/watch-report.md in watch mode.
  --agents   Show multi-agent coordination view for parallel local sessions.
  --rescue   Print a paste-ready live-session rescue prompt in watch mode.
  --guardrails Write/update .prismo/live-guardrails.md and .prismo/live-rescue-prompt.md.
  --throttle Write/update .prismo/live-context-throttle.md in watch mode.
  --events   Append changed live warnings to .prismo/watch-events.jsonl.
  --no-events Disable watch --auto event history writes.
  --auto     Opinionated live protection: guardrails + throttle + events + default 600k budget.
  --no-sync  Keep guard events local and skip dashboard sync.
  --budget N Live token budget for watch mode, e.g. 600000, 600k, or 1.2m.
  --redact-paths Redact absolute/local paths in watch output and reports.
  --proxy-url URL Prismo proxy URL to check during setup.
  --token TOKEN PrismoDev device token for connect mode.
  --api-url URL Prismo app/API URL for connect or sync mode.
  --org ORG Organization identifier for connect mode.
  --user USER User email or identifier for connect mode.
  --device NAME Local device name for connect mode.
  --no-agent  Connect without installing the background workspace connector.
  --tool TOOL Tool filter for sync mode: all, codex, claude, or cursor.
  --watch     Keep sync running and send updates on an interval.
  --once      Run watch mode once, useful for tests and scripts.
  --help      Show this help.
`;

const COMMAND_HELP = {
  scan: `PrismoDev

Usage:
  prismo scan [--fix] [--ci] [--json] [--usage] [--optimizer-fit] [--report-card] [--simple] [--no-report] [--limit N] [path]

Examples:
  prismo scan
  prismo scan --usage
  prismo scan --optimizer-fit
  prismo scan --report-card
  prismo scan --simple
  prismo scan --fix
  prismo scan --ci
  prismo scan --usage --json --no-report
  prismo scan --optimizer-fit --json

Notes:
  --usage reads local Codex/Claude Code logs when present.
  --optimizer-fit explains whether ignore cleanup, output sandboxing, code indexing, repo packing, instruction trimming, or session splitting fits this repo best.
  --report-card prints the shortest decision-layer summary.
  --simple keeps the output short and does not write a report unless combined with --fix.
  --fix creates safe recommendation files and never overwrites CLAUDE.md or AGENTS.md.`,
  optimize: `Prismo Optimize

Usage:
  prismo optimize [auth|frontend|backend] [--json] [path]

Examples:
  prismo optimize
  prismo optimize frontend

Output:
  Generates compact AI context files in .prismo/.`,
  context: `Prismo Context

Usage:
  prismo context [auth|frontend|backend] [--json] [path]

Examples:
  prismo context
  prismo context frontend

Output:
  Prints a paste-ready prompt for Codex, Claude Code, Cursor, and similar tools.`,
  cc: `Prismo Claude Code Cost

Usage:
  prismo cc [--json] [path]
  prismo cc timeline [--json] [--firewall] [--task TASK] [path]
  prismo cc list [--json] [--limit N] [path]
  prismo cc last N [--json] [path]
  prismo cc all [--json] [path]

Examples:
  prismo cc
  prismo cc timeline
  prismo cc timeline --firewall --task auth-bug
  prismo cc list
  prismo cc last 5
  prismo cc all --json

  Output:
  Reads ~/.claude/projects session logs and estimates Claude API token cost from input, output, cache write, and cache read tokens.
  Adds Prismo diagnosis: cost drivers, estimated avoidable spend, and context-optimization next actions.
  timeline shows context spikes, repeated commands, artifact leaks, and tool-output pressure for the latest session.
  --firewall writes .prismo/timeline-firewall-suggestions.md and suggested allow/block files from timeline evidence.
  Without a path, cc commands read all Claude Code projects. Passing a path filters to that project.`,
  cursor: `Prismo Cursor Sessions

Usage:
  prismo cursor [--json] [--limit N] [path]
  prismo cursor list [--json] [--limit N] [path]
  prismo cursor authorship [--json] [--limit N] [path]
  prismo cursor timeline [--json] [--limit N] [path]
  prismo cursor files [--json] [--limit N] [path]
  prismo cursor all [--json] [--limit N] [path]

Examples:
  prismo cursor
  prismo cursor authorship
  prismo cursor list --limit 20
  prismo cursor timeline --json
  prismo cursor files

Output:
  Reads ~/.cursor/ai-tracking/ai-code-tracking.db and Cursor workspace state databases.
  Shows Cursor composer sessions, AI authorship percentages from scored commits, AI-generated file tracking, and churn analysis.
  Requires sqlite3 to be installed on the system.`,
  receipt: `Prismo Run Receipt

Usage:
  prismo receipt [codex|claude|cursor|all] [--json] [--limit N] [path]

Examples:
  prismo receipt
  prismo receipt codex --json
  prismo receipt claude --limit 3

Output:
  Generates a session receipt: what repeated, what output dominated, what artifacts leaked, what likely influenced the run, and what to scope differently next time.`,
  instructions: `Prismo Instruction ROI Audit

Usage:
  prismo instructions audit [--json] [--limit N] [path]
  prismo instructions ablate --dry-run [--json] [--limit N] [--samples N] [path]
  prismo instructions apply [--dry-run] [--json] [--limit N] [path]

Examples:
  prismo instructions audit
  prismo instructions audit --json
  prismo instructions ablate --dry-run
  prismo instructions ablate --dry-run --json
  prismo instructions apply --dry-run
  prismo instructions apply

Output:
  Scores persistent instruction rules from CLAUDE.md, AGENTS.md, and Codex/OpenAI instruction files.
  Highlights useful guardrails, duplicates, partial compliance, influence-unknown lines, and conservative ablation candidates.
  Ablation mode is dry-run only: it produces a protocol and candidate list without editing files.
  Apply mode only removes exact duplicate instruction lines and writes backups before changing files.`,
  timeline: `Prismo Multi-Session Timeline

Usage:
  prismo timeline [codex|claude|cursor|all] [--json] [--last N] [path]

Examples:
  prismo timeline
  prismo timeline codex --last 20
  prismo timeline --json

Output:
  Aggregates recurring context-waste patterns across recent sessions: artifact leaks, repeated reads, repeated commands, tool-output floods, loops, and high-context sessions.`,
  replay: `Prismo Incident Replay

Usage:
  prismo replay [codex|claude|cursor|all] [--json] [--limit N] [path]

Examples:
  prismo replay
  prismo replay codex --json

Output:
  Reconstructs the most likely incident pattern from recent sessions and prints a paste-ready recovery prompt for the next agent run.`,
  boundaries: `Prismo Agent Boundary Check

Usage:
  prismo boundaries [codex|claude|cursor|all] [--json] [--limit N] [path]

Examples:
  prismo boundaries
  prismo boundaries codex --json

Output:
  Checks whether visible parallel agents are isolated enough, including shared repeated files, shared artifacts, noisy agents, and high-pressure sessions.`,
  usage: `Prismo Usage

Usage:
  prismo usage [codex|claude|cursor|all] [--json] [--limit N] [path]

Examples:
  prismo usage
  prismo usage codex --json
  prismo usage cursor
  prismo usage claude --limit 3`,
  guard: `PrismoDev Guard

Usage:
  prismo guard [codex|claude|cursor|all] [--json] [--watch] [--once] [--no-sync] [--dry-run] [--limit N] [--budget N] [--interval N] [path]

Examples:
  prismo guard
  prismo guard --json
  prismo guard --watch --interval 60
  prismo guard codex --budget 600k
  prismo guard --no-sync

Output:
  Runs proactive local protection on top of Prismo watch: live guardrails, rescue prompt, context throttle, context firewall, guard event log, and dashboard-ready prevention events.
  Guard never uploads prompts, source code, file contents, stdout, stderr, or full command logs.`,
  repair: `PrismoDev Repair

Usage:
  prismo repair <cause|auto> [--json] [--dry-run] [--tier mild|aggressive] [--limit N] [--budget N] [--scope SCOPE] [path] [-- <command ...>]

Causes:
  repeated-file-reads   Refresh ignore rules and context packs, and map hot files into .prismo/hot-files.md.
  tool-output-flood     Stage noisy commands behind shield in .prismo/noisy-commands.md; run a safe command shielded when passed after --.
  generated-artifacts   Append ignore rules for scan-detected build output plus artifact paths seen in recent sessions.
  context-loop          Run a tightened guard snapshot and write loop-breaking rules to .prismo/loop-breaker.md.
  long-session-buildup  Generate scoped context packs and a fresh-session restart routine in .prismo/session-restart.md.
  auto                  Let the planner score recent sessions, pick the top cause, and run its repair.

Examples:
  prismo repair auto
  prismo repair auto --dry-run
  prismo repair repeated-file-reads
  prismo repair tool-output-flood -- npm test
  prismo repair generated-artifacts --json
  prismo repair context-loop --budget 400k
  prismo repair long-session-buildup --scope frontend

Output:
  Runs the targeted repair for one waste cause instead of the generic doctor flow.
  These are the same executors the workspace agent uses when a queued action carries a targetCause.
  "auto" applies cooldowns and verdict feedback from .prismo/repair-state.json: a repair that came back
  no-change or regressed escalates to an aggressive tier (adds a context firewall policy and tighter budgets);
  a cause that already failed both tiers is held for review instead of being retried forever.
  --dry-run with auto prints the planner decision without executing.
  --tier aggressive forces the stronger repair; cloud-queued actions carry it automatically after a no-change/regressed verdict.
  Repairs only write .prismo/ files and append ignore rules with backups; they never overwrite CLAUDE.md, AGENTS.md, .gitignore, or source code.`,
  watch: `Prismo Watch

Usage:
  prismo watch [codex|claude|cursor|all] [--json] [--once] [--agents] [--report] [--rescue] [--guardrails] [--throttle] [--events] [--no-events] [--auto] [--budget N] [--redact-paths] [--interval N] [path]

Examples:
  prismo watch codex
  prismo watch cursor --once --json
  prismo watch claude --once --json
  prismo watch --agents --once
  prismo watch --once --report
  prismo watch --once --redact-paths
  prismo watch --rescue
  prismo watch --guardrails
  prismo watch --throttle --budget 600k
  prismo watch --events
  prismo watch --auto --no-events
  prismo watch --auto

Output:
  Shows context pressure, recent growth, likely context leaks, repeated reads/commands, loop suspicion, one suggested action, and live intervention steps.
  --agents shows all visible local sessions for this repo and coordination warnings.
  --rescue prints a paste-ready prompt to recover a noisy or looping active session.
  --guardrails continuously updates .prismo/live-guardrails.md and .prismo/live-rescue-prompt.md for the active session.
  --throttle writes a stricter live context budget file for the current agent session.
  --events appends changed live warnings to .prismo/watch-events.jsonl.
  --no-events disables event history when using --auto.
  --auto enables guardrails, throttle, events, and a 600k default budget.`,
  dev: `PrismoDev

Usage:
  prismo dev [--json] [--limit N] [path]

Flow:
  1. Scan repo and local usage.
  2. Generate .prismo/ optimized context files.
  3. Print a paste-ready prompt.`,
  init: `Prismo Init

Usage:
  prismo init [--json] [--dry-run] [path]

Output:
  Creates .prismo/README.md and adds ai:doctor, ai:watch, ai:context, and ai:scan scripts to package.json when available.`,
  doctor: `PrismoDev Doctor

Usage:
  prismo doctor [--json] [--dry-run] [--apply-ignores-only] [--apply-suggestions] [--no-context-packs] [--limit N] [path]

Flow:
  1. Scan repo and local usage.
  2. Apply safe AI-context fixes.
  3. Generate .prismo/ optimized context files.
  4. Re-scan and show before/after score.

Notes:
  Doctor creates safe recommendation/context files by default.
  --apply-suggestions appends missing .claudeignore/.cursorignore rules with backups.
  Doctor does not overwrite CLAUDE.md, AGENTS.md, .gitignore, or source code.`,
  firewall: `Prismo Context Firewall

Usage:
  prismo firewall [task] [--json] [--dry-run] [path]

Examples:
  prismo firewall
  prismo firewall auth-bug
  prismo firewall frontend
  prismo firewall auth-bug --json

Output:
  Writes .prismo/context-firewall.md, .prismo/allowed-context.txt, .prismo/blocked-context.txt, and .prismo/firewall-prompt.md.
  The firewall is a local policy file for the agent to follow before reading files; it does not enforce filesystem access by itself.`,
  shield: `Prismo Shield

Usage:
  prismo shield [--json] [path] -- <command ...>
  prismo shield last [--json] [--limit N] [path]
  prismo shield search <query> [--json] [--limit N] [path]

Examples:
  prismo shield -- npm test
  prismo shield -- pytest -q
  prismo shield --json -- npm run build
  prismo shield last
  prismo shield search "auth failure"

Output:
  Runs the command locally, stores full stdout/stderr under .prismo/shield/runs/, indexes output in SQLite FTS5 when available, and prints only a compact summary plus useful error lines.
  Search and last retrieve prior shield runs without re-feeding full output into agent context.`,
  mcp: `Prismo MCP Server

Usage:
  prismo mcp [path]
  prismo mcp doctor [--json] [path]

Examples:
  prismo mcp
  prismo mcp /path/to/repo
  prismo mcp doctor
  prismo mcp doctor --json

Tools exposed:
  prismo_scan
  prismo_doctor_dry_run
  prismo_watch_snapshot
  prismo_shield_run
  prismo_shield_search
  prismo_shield_last
  prismo_context_pack
  prismo_firewall
  prismo_cc_timeline
  prismo_cursor_sessions

Output:
  Starts a local JSON-RPC MCP server over stdio. Use it from MCP-compatible clients so agents can scan context waste, search shielded command output, and request scoped context without loading huge logs into chat.

  prismo mcp doctor validates the local MCP tool surface and prints a ready-to-use client config snippet.`,
  connect: `PrismoDev Connect

Usage:
  prismo connect [--json] [--token TOKEN] [--api-url URL] [--org ORG] [--user USER] [--device NAME]
  prismo connector [status|install|start|stop|uninstall] [--json] [--interval N] [--sync-interval N] [--mode observe|suggest|autopilot] [path]
  prismo sync [--json] [--dry-run] [--watch] [--interval N] [--limit N] [--tool all|codex|claude|cursor] [path]
  prismo status [--json]
  prismo disconnect [--json]

Examples:
  prismo connect --token <token>
  prismo connect --token <token> --api-url https://api.getprismo.dev
  prismo connect --token <token> --no-agent
  prismo connector status
  prismo connector install
  prismo connector install --sync-interval 120
  prismo sync --dry-run
  prismo sync
  prismo sync --watch --interval 60
  prismo status
  prismo disconnect

Output:
  connect stores a local PrismoDev device connection in ~/.prismo/config.json and starts the background workspace connector by default.
  connector keeps Prismo Workspace online so repairs queued in the dashboard run locally without copy/paste commands, and continuously syncs aggregate telemetry on a controlled interval.
  sync reads local Codex, Claude Code, and Cursor session logs, builds aggregate agent-efficiency telemetry, and sends it to Prismo.
  sync --watch keeps running so a local service manager can keep the Waste Scanner dashboard fresh.
  Sync does not upload prompts, source code, file contents, stdout, stderr, or full command logs.`,
  connector: `PrismoDev Connector

Usage:
  prismo connector status [--json]
  prismo connector install [--json] [--interval N] [--sync-interval N] [--mode observe|suggest|autopilot] [path]
  prismo connector start [--json]
  prismo connector stop [--json]
  prismo connector uninstall [--json]

Modes:
  observe    Keep the workspace connected but do not execute queued repairs.
  suggest    Stage repairs as pending approval.
  autopilot  Execute safe queued repairs automatically. (default)

Examples:
  prismo connector status
  prismo connector install
  prismo connector install --mode suggest --interval 30
  prismo connector install --sync-interval 120
  prismo connector stop
  prismo connector uninstall

Output:
  Installs and manages the local Prismo Workspace connector.
  On macOS this creates a LaunchAgent so Prismo stays online after the terminal closes.
  The connector claims safe repairs queued from Prismo Cloud, runs them locally, continuously syncs aggregate telemetry, and reports status back.
  It does not upload prompts, source code, file contents, stdout, stderr, or full command logs.`,
  sync: `PrismoDev Sync

Usage:
  prismo sync [--json] [--dry-run] [--watch] [--interval N] [--limit N] [--tool all|codex|claude|cursor] [path]

Examples:
  prismo sync --dry-run
  prismo sync --json --dry-run
  prismo sync --tool codex --limit 20
  prismo sync --watch --interval 60

Output:
  Builds safe aggregate telemetry for the Waste Scanner dashboard: repo identity, tool, session totals, context risk, likely wasted tokens, top waste causes, repeated reads, artifact mentions, and loop signals.
  It does not send raw prompts, code, file contents, stdout, stderr, or full command logs.`,
  status: `PrismoDev Status

Usage:
  prismo status [--json]

Output:
  Shows whether this machine is connected to PrismoDev cloud sync and when it last synced.`,
  disconnect: `PrismoDev Disconnect

Usage:
  prismo disconnect [--json]

Output:
  Removes the local PrismoDev device token and sync state from ~/.prismo/.`,
  agent: `PrismoDev Agent

Usage:
  prismo agent [--json] [--once] [--watch] [--open] [--no-detect] [--no-planner] [--no-sync] [--interval N] [--sync-interval N] [--planner-interval N] [--limit N] [--mode MODE] [path]

Modes:
  observe    Watch and report actions without executing. No changes made.
  suggest    Recommend actions and wait for approval in the workspace.
  autopilot  Execute safe actions automatically. (default)

Examples:
  prismo agent --once
  prismo agent --watch --interval 15
  prismo agent --watch --sync-interval 120
  prismo agent --watch --mode observe
  prismo agent --watch --mode suggest
  prismo agent --watch --open
  prismo agent --json --once --no-detect

Options:
  --open        Open the Prismo workspace in the browser on start.
  --no-detect   Skip the initial auto-detect scan on first poll.
  --no-planner  Disable the self-repair planner (cause scoring, cooldowns, tier escalation).
  --planner-interval N  Seconds between self-repair planner runs in watch mode (default 600).
  --no-sync     Keep watch mode from continuously syncing aggregate telemetry.

Output:
  On first poll, the agent proactively runs doctor to detect context issues.
  In autopilot mode it auto-fixes safe issues. In suggest mode it reports them as pending_approval in the workspace.
  Claims safe workspace actions queued from Prismo Cloud, runs them locally, and reports status back.
  Sends heartbeat to Prismo Cloud on each poll and syncs aggregate telemetry on a controlled interval so the dashboard stays fresh.
  Handles SIGINT/SIGTERM gracefully and marks the agent offline before exiting.
  Supported actions are doctor, sync, guard, context/optimize, and shield with a conservative command allowlist.
  Actions queued with a targetCause run cause-specific repair executors instead of the generic command; see prismo repair --help.
  In autopilot the self-repair planner also runs on its own interval: it scores waste causes from local sessions,
  repairs the top cause above threshold, judges the result against later sessions, and escalates or backs off accordingly.
  In observe/suggest modes the planner only reports what it would repair.
  Agent does not upload prompts, source code, file contents, stdout, stderr, or full command logs.`,
  ci: `Prismo CI

Usage:
  prismo scan --ci [--json] [--no-report] [path]

Examples:
  prismo scan --ci --no-report
  prismo scan --ci --json --no-report

Exit codes:
  0 when token-risk gates pass.
  1 when score/risk/ignore/artifact gates fail.`,
  setup: `PrismoDev Setup

Usage:
  prismo setup [--json] [--proxy-url URL] [--limit N] [path]

Examples:
  prismo setup
  prismo setup --json
  prismo setup --proxy-url http://localhost:8000

Output:
  Detects Claude Code, Codex, Cursor, local logs, optimization stack, and Prismo proxy readiness.
  This command is read-only and does not modify coding-tool config.`,
  demo: `Prismo Demo

Usage:
  prismo demo

Shows sample PrismoDev output without reading local files.
Good first command for people who want to see the value before scanning a repo.`,
};

function printHelp() {
  console.log(MAIN_HELP);
}

function printCommandHelp(command) {
  console.log(COMMAND_HELP[command] || "Unknown command. Try: prismo --help");
}

module.exports = { printHelp, printCommandHelp, MAIN_HELP, COMMAND_HELP };
