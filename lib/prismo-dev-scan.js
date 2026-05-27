const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { version: PACKAGE_VERSION } = require("../package.json");

const {
  HIGH_RISK_DIRS,
  HIGH_RISK_FILE_NAMES,
  BINARY_EXTENSIONS,
  SOURCE_EXTENSIONS,
  INSTRUCTION_FILES,
  DEFAULT_CLAUDEIGNORE,
  NPX_COMMAND,
  DEFAULT_PRISMO_PROXY_URL,
  CLAUDE_PRICING,
  DEFAULT_CLAUDE_PRICING_KEY,
  GENERATED_ARTIFACT_PATTERNS,
} = require("./prismo-dev/constants");

const {
  color,
  estimateTokens,
  printStep,
  readIfText,
  safeReadJson,
  severityColor,
  severityIcon,
} = require("./prismo-dev/utils");

let scanRepo;

const {
  createOptimizeContext,
  detectFrameworks,
  getContextFileForScope,
  renderContextCommand,
  renderOptimizeTerminal,
  renderStarterPrompt,
  runOptimize,
} = require("./prismo-dev/context-optimize")({
  fs,
  path,
  NPX_COMMAND,
  scanRepo: (...args) => scanRepo(...args),
  safeReadJson,
  readIfText,
  formatBytes: (...args) => formatBytes(...args),
  color,
  writeGeneratedFile: (...args) => writeGeneratedFile(...args),
});

const {
  analyzeSessionFile,
  analyzeCursorSessions,
  buildCursorDiagnosis,
  buildCursorSessionTimeline,
  buildMultiAgentView,
  calculateClaudeCost,
  compactUsageSummary,
  formatMoney,
  formatTokenCount,
  getClaudeCodeCostSummary,
  getClaudeSessionFiles,
  getCodexSessionFiles,
  getCursorSessionSummary,
  getUsageSummary,
  getPositionals,
  parsePositiveInt,
  parseScopeAndTarget,
  renderClaudeCostTerminal,
  renderCursorTerminal,
  renderUsageTerminal,
  renderContextThrottle,
  renderRescuePrompt,
  renderLiveGuardrails,
  renderWatchReport,
  renderWatchTerminal,
  toWatchJsonPayload,
  watchUsage,
  writeContextThrottle,
  writeLiveGuardrails,
  writeWatchEvent,
  writeWatchReport,
} = require("./prismo-dev/usage-watch")({
  fs,
  os,
  path,
  NPX_COMMAND,
  CLAUDE_PRICING,
  DEFAULT_CLAUDE_PRICING_KEY,
  GENERATED_ARTIFACT_PATTERNS,
  readIfText,
  estimateTokens,
  color,
  writeGeneratedFile: (...args) => writeGeneratedFile(...args),
});

const scanApi = require("./prismo-dev/scan")({
  fs,
  http,
  https,
  os,
  path,
  HIGH_RISK_DIRS,
  HIGH_RISK_FILE_NAMES,
  BINARY_EXTENSIONS,
  SOURCE_EXTENSIONS,
  INSTRUCTION_FILES,
  DEFAULT_CLAUDEIGNORE,
  NPX_COMMAND,
  estimateTokens,
  readIfText,
  detectFrameworks,
  getUsageSummary,
  getClaudeSessionFiles,
  getCodexSessionFiles,
  compactUsageSummary,
  formatTokenCount,
  color,
});

({ scanRepo } = scanApi);
const {
  calculateReductionPercent,
  chooseRecommendedScope,
  estimateExposedContextTokens,
  formatBytes,
  getNextCommands,
  getTopTokenLeaks,
  renderSetupTerminal,
  runSetup,
  toJsonPayload,
} = scanApi;

const {
  backupIfExists,
  evaluateCi,
  renderCiReport,
  renderMarkdownReport,
  renderOptimizerFitTerminal,
  renderReportCardTerminal,
  renderSimpleScanReport,
  renderTerminalReport,
  writeReport,
} = require("./prismo-dev/report")({
  fs,
  path,
  NPX_COMMAND,
  color,
  severityIcon,
  severityColor,
  estimateTokens,
  formatBytes,
  formatTokenCount,
  getNextCommands,
});

const { appendIgnoreSuggestions, applyFixes } = require("./prismo-dev/fixes")({
  fs,
  path,
  backupIfExists,
  writeReport,
});

function writeGeneratedFile(root, relPath, contents) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const backupPath = backupIfExists(fullPath);
  fs.writeFileSync(fullPath, contents, "utf8");
  return { path: relPath, backupPath };
}

const {
  renderDemoTerminal,
  renderDevTerminal,
  renderDoctorTerminal,
  renderInitTerminal,
  runDevFlow,
  runDoctor,
  runInit,
  toDoctorJsonPayload,
} = require("./prismo-dev/doctor")({
  fs,
  path,
  NPX_COMMAND,
  color,
  applyFixes,
  appendIgnoreSuggestions,
  calculateReductionPercent,
  chooseRecommendedScope,
  createOptimizeContext,
  estimateExposedContextTokens,
  formatTokenCount,
  getContextFileForScope,
  getNextCommands,
  getTopTokenLeaks,
  renderContextCommand,
  renderStarterPrompt,
  runOptimize,
  safeReadJson,
  scanRepo: (...args) => scanRepo(...args),
  writeGeneratedFile,
  backupIfExists,
  printStep,
});

const {
  renderFirewallTerminal,
  runFirewall,
  runTimelineFirewallSuggestions,
} = require("./prismo-dev/firewall")({
  fs,
  path,
  NPX_COMMAND,
  createOptimizeContext,
  writeGeneratedFile,
});

const {
  renderShieldLastTerminal,
  renderShieldSearchTerminal,
  renderShieldTerminal,
  runShieldLast,
  runShieldSearch,
  runShield,
} = require("./prismo-dev/shield")({
  fs,
  path,
  estimateTokens,
  formatBytes: (...args) => formatBytes(...args),
  color,
});

const {
  renderBenchmarkTerminal,
  runBenchmark,
} = require("./prismo-dev/benchmark")({
  NPX_COMMAND,
  estimateTokens,
  formatTokenCount,
  getUsageSummary,
  runShield,
  scanRepo: (...args) => scanRepo(...args),
  color,
});

const {
  buildReceipt,
  renderReceiptTerminal,
} = require("./prismo-dev/receipt")({
  fs,
  path,
  GENERATED_ARTIFACT_PATTERNS,
  NPX_COMMAND,
  formatTokenCount,
  getUsageSummary,
  readIfText,
});

const {
  buildInstructionsAblationPlan,
  buildInstructionsAudit,
  renderInstructionsAblationTerminal,
  renderInstructionsAuditTerminal,
} = require("./prismo-dev/instructions")({
  fs,
  path,
  INSTRUCTION_FILES,
  NPX_COMMAND,
  estimateTokens,
  formatTokenCount,
  getUsageSummary,
  readIfText,
});

const {
  buildMultiSessionTimeline,
  renderMultiSessionTimelineTerminal,
} = require("./prismo-dev/timeline")({
  fs,
  path,
  GENERATED_ARTIFACT_PATTERNS,
  NPX_COMMAND,
  formatTokenCount,
  getUsageSummary,
  readIfText,
});

const {
  buildReplay,
  renderReplayTerminal,
} = require("./prismo-dev/replay")({
  NPX_COMMAND,
  buildMultiSessionTimeline,
  buildReceipt,
  formatTokenCount,
});

const {
  buildBoundaryCheck,
  renderBoundaryTerminal,
} = require("./prismo-dev/boundaries")({
  NPX_COMMAND,
  buildMultiAgentView,
  getUsageSummary,
});

const {
  renderMcpDoctorTerminal,
  runMcpDoctor,
  runMcpServer,
} = require("./prismo-dev/mcp");

function printHelp() {
  console.log(`Prismo CLI

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
  prismo setup [--json] [--proxy-url URL] [path]
  prismo scan [--fix] [--ci] [--json] [--usage] [--optimizer-fit] [--report-card] [--simple] [--no-report] [path]
  prismo optimize [scope] [--json] [path]
  prismo context [scope] [--json] [path]
  prismo cc [list|last N|all|timeline] [--json] [--limit N] [--firewall] [--task TASK] [path]
  prismo cursor [list|authorship|timeline|files|all] [--json] [--limit N] [path]
  prismo receipt [codex|claude|cursor|all] [--json] [--limit N] [path]
  prismo instructions audit [--json] [--limit N] [path]
  prismo instructions ablate --dry-run [--json] [--limit N] [--samples N] [path]
  prismo timeline [codex|claude|cursor|all] [--json] [--last N] [path]
  prismo replay [codex|claude|cursor|all] [--json] [--limit N] [path]
  prismo boundaries [codex|claude|cursor|all] [--json] [--limit N] [path]
  prismo usage [codex|claude|cursor|all] [--json] [--limit N] [path]
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
  --budget N Live token budget for watch mode, e.g. 600000, 600k, or 1.2m.
  --redact-paths Redact absolute/local paths in watch output and reports.
  --proxy-url URL Prismo proxy URL to check during setup.
  --once      Run watch mode once, useful for tests and scripts.
  --help      Show this help.
`);
}

function parseTokenBudget(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  const multiplier = match[2] === "m" ? 1000000 : match[2] === "k" ? 1000 : 1;
  const parsed = Math.round(amount * multiplier);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function printCommandHelp(command) {
  const help = {
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

Examples:
  prismo instructions audit
  prismo instructions audit --json
  prismo instructions ablate --dry-run
  prismo instructions ablate --dry-run --json

Output:
  Scores persistent instruction rules from CLAUDE.md, AGENTS.md, and Codex/OpenAI instruction files.
  Highlights useful guardrails, duplicates, partial compliance, influence-unknown lines, and conservative ablation candidates.
  Ablation mode is dry-run only: it produces a protocol and candidate list without editing files.`,
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
  console.log(help[command] || "Unknown command. Try: prismo --help");
}

async function runCli(argv) {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(PACKAGE_VERSION);
    return;
  }
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    printCommandHelp(command);
    return;
  }
  if (!["dev", "init", "doctor", "firewall", "benchmark", "shield", "mcp", "setup", "scan", "optimize", "context", "cc", "cursor", "receipt", "instructions", "timeline", "replay", "boundaries", "usage", "watch", "demo"].includes(command)) {
    throw new Error(`Unknown command: ${command}. Try: prismo doctor, prismo watch, prismo receipt, prismo benchmark, prismo shield, prismo mcp, prismo firewall, prismo init, prismo scan, prismo optimize, prismo context, prismo cc, prismo cursor, or prismo usage`);
  }

  if (command === "demo") {
    console.log(renderDemoTerminal());
    return;
  }

  if (command === "dev") {
    const json = rest.includes("--json");
    const limitIndex = rest.indexOf("--limit");
    const target = getPositionals(rest, new Set(["--limit"]))[0] || process.cwd();
    const result = runDevFlow(target, {
      json,
      limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 3),
    });
    if (json) {
      console.log(JSON.stringify({
        score: result.scan.score,
        riskLevel: result.scan.risk,
        tokenLeaks: result.scan.issues.length,
        realUsage: result.scan.realUsage,
        generatedFiles: result.optimize.generatedFiles,
        nextCommands: result.nextCommands,
        prompt: renderStarterPrompt(createOptimizeContext(result.optimize.root, result.scope), result.scope),
        scannedPath: result.scan.root,
        generatedAt: result.scan.generatedAt,
      }, null, 2));
      return;
    }
    console.log(renderDevTerminal(result));
    return;
  }

  if (command === "init") {
    const json = rest.includes("--json");
    const target = getPositionals(rest)[0] || process.cwd();
    const result = runInit(target, { dryRun: rest.includes("--dry-run") });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(renderInitTerminal(result));
    return;
  }

  if (command === "doctor") {
    const json = rest.includes("--json");
    const limitIndex = rest.indexOf("--limit");
    const { scope, target } = parseScopeAndTarget(rest, new Set(["--limit"]));
    const result = runDoctor(target, {
      json,
      limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 3),
      scope,
      dryRun: rest.includes("--dry-run"),
      applyIgnoresOnly: rest.includes("--apply-ignores-only"),
      applySuggestions: rest.includes("--apply-suggestions"),
      noContextPacks: rest.includes("--no-context-packs"),
    });
    if (json) {
      console.log(JSON.stringify(toDoctorJsonPayload(result), null, 2));
      return;
    }
    console.log(renderDoctorTerminal(result));
    return;
  }

  if (command === "firewall") {
    const json = rest.includes("--json");
    const { scope, target } = parseScopeAndTarget(rest);
    const result = runFirewall(target, {
      task: scope || "general",
      scope,
      dryRun: rest.includes("--dry-run"),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(renderFirewallTerminal(result));
    return;
  }

  if (command === "benchmark") {
    const json = rest.includes("--json");
    const limitIndex = rest.indexOf("--limit");
    const separatorIndex = rest.indexOf("--");
    const beforeSeparator = separatorIndex >= 0 ? rest.slice(0, separatorIndex) : rest;
    const commandArgs = separatorIndex >= 0 ? rest.slice(separatorIndex + 1) : [];
    const positional = getPositionals(beforeSeparator, new Set(["--limit"]));
    const sessionOnly = positional[0] === "session" || commandArgs.length === 0;
    const target = positional[0] === "session" ? positional[1] || process.cwd() : positional[0] || process.cwd();
    const result = runBenchmark(target, commandArgs, {
      sessionOnly,
      limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5),
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(renderBenchmarkTerminal(result));
    if (result.mode === "command") process.exitCode = result.exitCode;
    return;
  }

  if (command === "shield") {
    const json = rest.includes("--json");
    const limitIndex = rest.indexOf("--limit");
    const limit = parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5);
    const positional = getPositionals(rest, new Set(["--limit"]));
    if (positional[0] === "last") {
      const target = positional[1] || process.cwd();
      const result = runShieldLast(target, { limit });
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(renderShieldLastTerminal(result));
      return;
    }
    if (positional[0] === "search") {
      const query = positional[1];
      const target = positional[2] || process.cwd();
      const result = runShieldSearch(target, query, { limit });
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(renderShieldSearchTerminal(result));
      return;
    }
    const separatorIndex = rest.indexOf("--");
    const beforeSeparator = separatorIndex >= 0 ? rest.slice(0, separatorIndex) : [];
    const commandArgs = separatorIndex >= 0 ? rest.slice(separatorIndex + 1) : getPositionals(rest);
    const target = getPositionals(beforeSeparator)[0] || process.cwd();
    const result = runShield(target, commandArgs);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderShieldTerminal(result));
    }
    process.exitCode = result.exitCode;
    return;
  }

  if (command === "mcp") {
    const json = rest.includes("--json");
    const positional = getPositionals(rest);
    const subcommand = positional[0] === "doctor" ? "doctor" : "server";
    const target = subcommand === "doctor" ? positional[1] || process.cwd() : positional[0] || process.cwd();
    const mcpDeps = {
      rootDir: path.resolve(target),
      packageVersion: PACKAGE_VERSION,
      scanRepo,
      toJsonPayload,
      runDoctor,
      toDoctorJsonPayload,
      getUsageSummary,
      getClaudeCodeCostSummary,
      getCursorSessionSummary,
      buildBoundaryCheck,
      buildInstructionsAblationPlan,
      buildInstructionsAudit,
      buildMultiSessionTimeline,
      buildReceipt,
      buildReplay,
      runOptimize,
      createOptimizeContext,
      renderStarterPrompt,
      runFirewall,
      runShield,
      runShieldLast,
      runShieldSearch,
    };
    if (subcommand === "doctor") {
      const result = await runMcpDoctor(mcpDeps);
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(renderMcpDoctorTerminal(result));
      return;
    }
    runMcpServer(mcpDeps);
    return;
  }

  if (command === "setup") {
    const json = rest.includes("--json");
    const limitIndex = rest.indexOf("--limit");
    const proxyIndex = rest.indexOf("--proxy-url");
    const target = getPositionals(rest, new Set(["--limit", "--proxy-url"]))[0] || process.cwd();
    const result = await runSetup(target, {
      limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 3),
      proxyUrl: proxyIndex >= 0 ? rest[proxyIndex + 1] : DEFAULT_PRISMO_PROXY_URL,
      skipProxyCheck: rest.includes("--skip-proxy-check"),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(renderSetupTerminal(result));
    return;
  }

  if (command === "cc") {
    const json = rest.includes("--json");
    const limitIndex = rest.indexOf("--limit");
    const firewall = rest.includes("--firewall");
    const taskIndex = rest.indexOf("--task");
    const firewallTask = taskIndex >= 0 && rest[taskIndex + 1] && !rest[taskIndex + 1].startsWith("-")
      ? rest[taskIndex + 1]
      : "timeline-followup";
    const ccArgs = rest.filter((_, index) => {
      if (index === rest.indexOf("--firewall")) return false;
      if (taskIndex >= 0 && (index === taskIndex || index === taskIndex + 1)) return false;
      return true;
    });
    const positional = getPositionals(ccArgs, new Set(["--limit"]));
    const subcommand = positional[0] && ["list", "last", "all", "timeline"].includes(positional[0].toLowerCase()) ? positional[0].toLowerCase() : "latest";
    const lastCount = subcommand === "last" ? parsePositiveInt(positional[1], 5) : null;
    const limit = subcommand === "list"
      ? parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 10)
      : subcommand === "last"
        ? lastCount
        : 1;
    const targetIndex = subcommand === "last" ? 2 : subcommand === "latest" ? 0 : 1;
    const hasTarget = Boolean(positional[targetIndex]);
    const target = hasTarget ? positional[targetIndex] : process.cwd();
    const summary = getClaudeCodeCostSummary({
      cwd: path.resolve(target),
      limit,
      all: subcommand === "all",
      allProjects: !hasTarget,
      mode: subcommand,
    });
    if (json) {
      if (subcommand === "timeline") {
        const latest = summary.sessions[0] || null;
        const firewallSuggestions = firewall && latest
          ? runTimelineFirewallSuggestions(path.resolve(target), latest, { task: firewallTask, dryRun: false })
          : null;
        console.log(JSON.stringify({
          schemaVersion: 1,
          generatedAt: summary.generatedAt,
          scannedPath: summary.scannedPath,
          command: "cc timeline",
          session: latest
            ? {
                sessionId: latest.sessionId,
                model: latest.model || latest.cost?.model || null,
                updatedAt: latest.updatedAt,
                risk: latest.contextRisk,
                turns: latest.turns,
                toolCalls: latest.toolCalls,
              }
            : null,
          timeline: latest ? latest.timeline || [] : [],
          firewallSuggestions,
          suggestedAction: latest?.prismo?.recommendations?.[0] || `${NPX_COMMAND} doctor`,
        }, null, 2));
        return;
      }
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    const output = [renderClaudeCostTerminal(summary)];
    if (subcommand === "timeline" && firewall) {
      const latest = summary.sessions[0] || null;
      if (latest) {
        const suggestions = runTimelineFirewallSuggestions(path.resolve(target), latest, { task: firewallTask, dryRun: false });
        output.push("");
        output.push("Timeline Firewall Suggestions");
        output.push(`Wrote: ${suggestions.generatedFiles.join(", ")}`);
        output.push(`Session-derived allowed: ${suggestions.sessionAllowed.length}`);
        output.push(`Session-derived blocked: ${suggestions.sessionBlocked.length}`);
        output.push("Tell your agent: Use .prismo/context-firewall.suggested.md for the next scoped session.");
      }
    }
    console.log(output.join("\n"));
    return;
  }

  if (command === "cursor") {
    const json = rest.includes("--json");
    const limitIndex = rest.indexOf("--limit");
    const positional = getPositionals(rest, new Set(["--limit"]));
    const subcommand = positional[0] && ["list", "authorship", "timeline", "files", "all"].includes(positional[0].toLowerCase())
      ? positional[0].toLowerCase()
      : "latest";
    const target = (subcommand !== "latest" ? positional[1] : positional[0]) || process.cwd();
    const limit = parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, subcommand === "all" ? 200 : 20);
    const summary = getCursorSessionSummary({
      cwd: path.resolve(target),
      limit,
      mode: subcommand,
    });
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(renderCursorTerminal(summary, subcommand));
    return;
  }

  if (command === "receipt") {
    const json = rest.includes("--json");
    const knownTools = new Set(["codex", "claude", "cursor", "all"]);
    const positional = getPositionals(rest, new Set(["--limit"]));
    const explicitTool = positional[0] && knownTools.has(positional[0].toLowerCase());
    const tool = explicitTool ? positional[0].toLowerCase() : "all";
    const target = explicitTool ? positional[1] || process.cwd() : positional[0] || process.cwd();
    const limitIndex = rest.indexOf("--limit");
    const receipt = buildReceipt({
      cwd: path.resolve(target),
      tool,
      limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5),
    });
    if (json) {
      console.log(JSON.stringify(receipt, null, 2));
      return;
    }
    console.log(renderReceiptTerminal(receipt));
    return;
  }

  if (command === "instructions") {
    const json = rest.includes("--json");
    const limitIndex = rest.indexOf("--limit");
    const samplesIndex = rest.indexOf("--samples");
    const positional = getPositionals(rest, new Set(["--limit", "--samples"]));
    const subcommand = ["audit", "ablate"].includes(positional[0]?.toLowerCase()) ? positional[0].toLowerCase() : "audit";
    const target = ["audit", "ablate"].includes(positional[0]?.toLowerCase())
      ? positional[1] || process.cwd()
      : positional[0] || process.cwd();
    if (subcommand === "ablate") {
      const plan = buildInstructionsAblationPlan({
        cwd: path.resolve(target),
        limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 20),
        samples: parsePositiveInt(samplesIndex >= 0 ? rest[samplesIndex + 1] : null, 10),
      });
      if (json) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
      console.log(renderInstructionsAblationTerminal(plan));
      return;
    }
    const audit = buildInstructionsAudit({
      cwd: path.resolve(target),
      limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 20),
    });
    if (json) {
      console.log(JSON.stringify(audit, null, 2));
      return;
    }
    console.log(renderInstructionsAuditTerminal(audit));
    return;
  }

  if (command === "timeline") {
    const json = rest.includes("--json");
    const knownTools = new Set(["codex", "claude", "cursor", "all"]);
    const positional = getPositionals(rest, new Set(["--last", "--limit"]));
    const explicitTool = positional[0] && knownTools.has(positional[0].toLowerCase());
    const tool = explicitTool ? positional[0].toLowerCase() : "all";
    const target = explicitTool ? positional[1] || process.cwd() : positional[0] || process.cwd();
    const lastIndex = rest.indexOf("--last");
    const limitIndex = rest.indexOf("--limit");
    const limitValue = lastIndex >= 0 ? rest[lastIndex + 1] : limitIndex >= 0 ? rest[limitIndex + 1] : null;
    const timeline = buildMultiSessionTimeline({
      cwd: path.resolve(target),
      tool,
      limit: parsePositiveInt(limitValue, 20),
    });
    if (json) {
      console.log(JSON.stringify(timeline, null, 2));
      return;
    }
    console.log(renderMultiSessionTimelineTerminal(timeline));
    return;
  }

  if (command === "replay") {
    const json = rest.includes("--json");
    const knownTools = new Set(["codex", "claude", "cursor", "all"]);
    const positional = getPositionals(rest, new Set(["--limit"]));
    const explicitTool = positional[0] && knownTools.has(positional[0].toLowerCase());
    const tool = explicitTool ? positional[0].toLowerCase() : "all";
    const target = explicitTool ? positional[1] || process.cwd() : positional[0] || process.cwd();
    const limitIndex = rest.indexOf("--limit");
    const replay = buildReplay({
      cwd: path.resolve(target),
      tool,
      limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5),
    });
    if (json) {
      console.log(JSON.stringify(replay, null, 2));
      return;
    }
    console.log(renderReplayTerminal(replay));
    return;
  }

  if (command === "boundaries") {
    const json = rest.includes("--json");
    const knownTools = new Set(["codex", "claude", "cursor", "all"]);
    const positional = getPositionals(rest, new Set(["--limit"]));
    const explicitTool = positional[0] && knownTools.has(positional[0].toLowerCase());
    const tool = explicitTool ? positional[0].toLowerCase() : "all";
    const target = explicitTool ? positional[1] || process.cwd() : positional[0] || process.cwd();
    const limitIndex = rest.indexOf("--limit");
    const check = buildBoundaryCheck({
      cwd: path.resolve(target),
      tool,
      limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 10),
    });
    if (json) {
      console.log(JSON.stringify(check, null, 2));
      return;
    }
    console.log(renderBoundaryTerminal(check));
    return;
  }

  if (command === "usage" || command === "watch") {
    const json = rest.includes("--json");
    const knownTools = new Set(["codex", "claude", "cursor", "all"]);
    const positional = getPositionals(rest, new Set(["--limit", "--interval", "--budget"]));
    const explicitTool = positional[0] && knownTools.has(positional[0].toLowerCase());
    const tool = explicitTool ? positional[0].toLowerCase() : "all";
    const target = explicitTool ? positional[1] || process.cwd() : positional[0] || process.cwd();
    const limitIndex = rest.indexOf("--limit");
    const intervalIndex = rest.indexOf("--interval");
    const budgetIndex = rest.indexOf("--budget");
    const auto = rest.includes("--auto");
    const noEvents = rest.includes("--no-events");
    const limit = parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5);
    const intervalMs = parsePositiveInt(intervalIndex >= 0 ? rest[intervalIndex + 1] : null, 3) * 1000;
    const tokenBudget = parseTokenBudget(budgetIndex >= 0 ? rest[budgetIndex + 1] : null) || (auto ? 600000 : null);
    const usageOptions = {
      tool,
      cwd: path.resolve(target),
      limit,
      tokenBudget,
      auto,
      agents: rest.includes("--agents"),
      json,
      once: rest.includes("--once"),
      report: rest.includes("--report"),
      rescue: rest.includes("--rescue"),
      guardrails: auto || rest.includes("--guardrails"),
      throttle: auto || rest.includes("--throttle"),
      events: (auto && !noEvents) || rest.includes("--events"),
      noEvents,
      updateFirewall: auto ? (summary) => {
        const live = summary.live;
        if (!live || live.liveAction.cause === "healthy" || live.liveAction.cause === "no-active-session") return null;
        return runFirewall(summary.scannedPath || target, {
          task: live.liveAction.cause,
          dryRun: false,
          live: true,
        });
      } : null,
      redactPaths: rest.includes("--redact-paths"),
      intervalMs,
    };

    if (command === "watch") {
      await watchUsage(usageOptions);
      return;
    }

    const summary = getUsageSummary(usageOptions);
    if (json) {
      console.log(JSON.stringify(compactUsageSummary(summary), null, 2));
      return;
    }
    console.log(renderUsageTerminal(summary));
    return;
  }

  if (command === "context") {
    const json = rest.includes("--json");
    const { scope, target } = parseScopeAndTarget(rest);
    const ctx = createOptimizeContext(target, scope);
    const prompt = renderStarterPrompt(ctx, scope);
    const output = renderContextCommand(ctx, scope);
    if (json) {
      console.log(JSON.stringify({
        scope,
        prompt,
        contextFile: getContextFileForScope(ctx, scope),
        supportingFiles: [
          !scope && ctx.backendDetected ? ".prismo/backend-summary.md" : null,
          !scope && ctx.frontendDetected ? ".prismo/frontend-summary.md" : null,
          scope === "frontend" ? ".prismo/frontend-summary.md" : null,
          scope === "backend" ? ".prismo/backend-summary.md" : null,
        ].filter(Boolean),
        scannedPath: ctx.root,
        generatedAt: ctx.generatedAt,
      }, null, 2));
      return;
    }
    console.log(output);
    return;
  }

  if (command === "optimize") {
    const json = rest.includes("--json");
    const { scope, target } = parseScopeAndTarget(rest);
    const result = runOptimize(target, { scope });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(renderOptimizeTerminal(result));
    return;
  }

  const fix = rest.includes("--fix");
  const noReport = rest.includes("--no-report");
  const json = rest.includes("--json");
  const simple = rest.includes("--simple");
  const optimizerFit = rest.includes("--optimizer-fit");
  const reportCard = rest.includes("--report-card");
  const ciMode = rest.includes("--ci");
  const includeUsage = rest.includes("--usage") || optimizerFit || reportCard;
  const limitIndex = rest.indexOf("--limit");
  const usageToolIndex = rest.indexOf("--usage-tool");
  const target = getPositionals(rest, new Set(["--limit", "--usage-tool"]))[0] || process.cwd();
  const scanDone = printStep(includeUsage ? "Scanning repo and local usage" : "Scanning repo", json || simple || optimizerFit || reportCard);
  const result = scanRepo(target, {
    includeUsage,
    usageLimit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5),
    usageTool: usageToolIndex >= 0 ? rest[usageToolIndex + 1] : "all",
  });
  scanDone();

  if (json) {
    let fixActions = [];
    let report = null;
    if (fix) {
      fixActions = applyFixes(result);
    } else if (!noReport && !optimizerFit) {
      report = writeReport(result);
    }
    const payload = toJsonPayload(result);
    if (ciMode) {
      payload.ci = evaluateCi(result);
      if (!payload.ci.passed) process.exitCode = 1;
    }
    if (optimizerFit || reportCard) {
      console.log(JSON.stringify({
        schemaVersion: 1,
        scannedPath: result.root,
        score: result.score,
        riskLevel: result.risk,
        optimizerFit: result.optimizerFit,
        reportCard: reportCard ? {
          biggestWaste: result.optimizerFit.summary,
          startWith: result.optimizerFit.recommendedStack[0]?.command || null,
          then: result.optimizerFit.recommendedStack[1]?.command || null,
          roundTripRisk: result.optimizerFit.roundTripContext.level,
        } : undefined,
        generatedAt: result.generatedAt,
      }, null, 2));
      return;
    }
    if (fixActions.length) payload.fixActions = fixActions;
    if (report) payload.reportPath = report.reportPath;
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (reportCard) {
    console.log(renderReportCardTerminal(result));
  } else if (optimizerFit) {
    console.log(renderOptimizerFitTerminal(result));
  } else if (simple) {
    console.log(renderSimpleScanReport(result));
  } else if (ciMode) {
    const ci = evaluateCi(result);
    console.log(renderCiReport(result, ci));
    if (!ci.passed) process.exitCode = 1;
  } else {
    console.log(renderTerminalReport(result, { reportEnabled: !noReport || fix }));
  }

  if (fix) {
    const actions = applyFixes(result);
    console.log("\nFix Mode:");
    actions.forEach((action) => console.log(`- ${action}`));
  } else if (!noReport && !simple && !optimizerFit && !reportCard) {
    const report = writeReport(result);
    if (report.backupPath) {
      console.log(`\nExisting report backed up to ${path.basename(report.backupPath)}.`);
    }
  }
}

module.exports = {
  applyFixes,
  estimateTokens,
  renderMarkdownReport,
  renderBoundaryTerminal,
  renderSimpleScanReport,
  renderClaudeCostTerminal,
  renderCursorTerminal,
  renderInstructionsAblationTerminal,
  renderInstructionsAuditTerminal,
  renderMultiSessionTimelineTerminal,
  renderReceiptTerminal,
  renderReplayTerminal,
  renderUsageTerminal,
  renderContextThrottle,
  renderRescuePrompt,
  renderLiveGuardrails,
  renderWatchTerminal,
  renderWatchReport,
  renderTerminalReport,
  renderOptimizerFitTerminal,
  renderReportCardTerminal,
  renderDoctorTerminal,
  renderInitTerminal,
  runSetup,
  runOptimize,
  runBenchmark,
  runDoctor,
  runInit,
  runCli,
  scanRepo,
  getClaudeCodeCostSummary,
  getCursorSessionSummary,
  buildBoundaryCheck,
  buildInstructionsAblationPlan,
  buildReceipt,
  buildInstructionsAudit,
  buildMultiSessionTimeline,
  buildReplay,
  getUsageSummary,
  analyzeCursorSessions,
  analyzeSessionFile,
  calculateClaudeCost,
  toDoctorJsonPayload,
  toJsonPayload,
  toWatchJsonPayload,
  watchUsage,
  writeWatchReport,
  writeReport,
};
