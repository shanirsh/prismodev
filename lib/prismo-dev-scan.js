const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

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

function shouldUseColor() {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

const colorCodes = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

function color(text, tone, enabled = shouldUseColor()) {
  if (!enabled || !colorCodes[tone]) return text;
  return `${colorCodes[tone]}${text}${colorCodes.reset}`;
}

function severityIcon(severity) {
  if (severity === "critical") return "[critical]";
  if (severity === "high") return "[high]";
  if (severity === "medium") return "[medium]";
  return "[low]";
}

function severityColor(severity) {
  if (severity === "critical" || severity === "high") return "red";
  if (severity === "medium") return "yellow";
  return "cyan";
}

function printStep(label, json = false) {
  if (json) return () => {};
  process.stderr.write(`${color("...", "cyan")} ${label}`);
  return (status = "done") => {
    process.stderr.write(` ${color(`[${status}]`, status === "done" ? "green" : "yellow")}\n`);
  };
}

function estimateTokens(textOrBytes) {
  const length = typeof textOrBytes === "string" ? textOrBytes.length : Number(textOrBytes || 0);
  return Math.ceil(length / 4);
}

function readIfText(filePath, maxBytes = 2 * 1024 * 1024) {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return null;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > maxBytes) return null;

  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}


function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

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
  calculateClaudeCost,
  compactUsageSummary,
  formatMoney,
  formatTokenCount,
  getClaudeCodeCostSummary,
  getClaudeSessionFiles,
  getCodexSessionFiles,
  getUsageSummary,
  getPositionals,
  parsePositiveInt,
  parseScopeAndTarget,
  renderClaudeCostTerminal,
  renderUsageTerminal,
  renderRescuePrompt,
  renderLiveGuardrails,
  renderWatchReport,
  renderWatchTerminal,
  toWatchJsonPayload,
  watchUsage,
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

const { applyFixes } = require("./prismo-dev/fixes")({
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

function printHelp() {
  console.log(`Prismo CLI

Usage:
  prismo dev [path]
  prismo init [--json] [--dry-run] [path]
  prismo doctor [--json] [--dry-run] [--apply-ignores-only] [--no-context-packs] [--limit N] [path]
  prismo setup [--json] [--proxy-url URL] [path]
  prismo scan [--fix] [--ci] [--json] [--usage] [--simple] [--no-report] [path]
  prismo optimize [scope] [--json] [path]
  prismo context [scope] [--json] [path]
  prismo cc [list|last N|all] [--json] [--limit N] [path]
  prismo usage [codex|claude|all] [--json] [--limit N] [path]
  prismo watch [codex|claude|all] [--json] [--once] [--report] [--rescue] [--guardrails] [--redact-paths] [--interval N] [path]
  prismo demo

Commands:
  dev         Guided flow: scan, optimize, and print a paste-ready context prompt.
  init        Add local PrismoDev helper docs and npm scripts when package.json exists.
  doctor      Diagnose, safely optimize, re-scan, and show before/after payoff.
  scan        Run PrismoDev for Claude Code, Codex, Cursor, and AI coding workflows.
  optimize    Generate lightweight AI-readable project context files in .prismo/.
  context     Print a copy-pasteable compact context prompt for AI coding tools.
  cc          Show Claude Code token cost, cache cost, and all-time totals.
  usage       Read local Codex/Claude Code session logs and summarize token usage.
  watch       Refresh local session usage in the terminal.
  demo        Show sample output without needing a messy repo.
  setup       Detect coding tools, tracking modes, local logs, and Prismo proxy readiness.

Options:
  --fix       Safely create .claudeignore if missing and generate the report.
  --ci        Fail with exit code 1 when token-risk gates fail.
  --json      Output valid JSON only for CI or future dashboard ingestion.
  --usage     Include real local Codex/Claude Code session usage in scan diagnostics.
  --simple    Print a plain-English scan summary for first-time or non-technical users.
  --no-report Do not write prismo-dev-report.md.
  --limit N   Number of recent local sessions to show.
  --interval N Refresh interval in seconds for watch mode.
  --dry-run  Preview doctor/fix actions without writing files.
  --apply-ignores-only Only create/suggest AI ignore files in doctor mode.
  --no-context-packs Skip .prismo context-pack generation in doctor mode.
  --report   Write .prismo/watch-report.md in watch mode.
  --rescue   Print a paste-ready live-session rescue prompt in watch mode.
  --guardrails Write/update .prismo/live-guardrails.md and .prismo/live-rescue-prompt.md.
  --redact-paths Redact absolute/local paths in watch output and reports.
  --proxy-url URL Prismo proxy URL to check during setup.
  --once      Run watch mode once, useful for tests and scripts.
  --help      Show this help.
`);
}

function printCommandHelp(command) {
  const help = {
    scan: `PrismoDev

Usage:
  prismo scan [--fix] [--ci] [--json] [--usage] [--simple] [--no-report] [--limit N] [path]

Examples:
  prismo scan
  prismo scan --usage
  prismo scan --simple
  prismo scan --fix
  prismo scan --ci
  prismo scan --usage --json --no-report

Notes:
  --usage reads local Codex/Claude Code logs when present.
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
  prismo cc timeline [--json] [path]
  prismo cc list [--json] [--limit N] [path]
  prismo cc last N [--json] [path]
  prismo cc all [--json] [path]

Examples:
  prismo cc
  prismo cc timeline
  prismo cc list
  prismo cc last 5
  prismo cc all --json

  Output:
  Reads ~/.claude/projects session logs and estimates Claude API token cost from input, output, cache write, and cache read tokens.
  Adds Prismo diagnosis: cost drivers, estimated avoidable spend, and context-optimization next actions.
  timeline shows context spikes, repeated commands, artifact leaks, and tool-output pressure for the latest session.
  Without a path, cc commands read all Claude Code projects. Passing a path filters to that project.`,
    usage: `Prismo Usage

Usage:
  prismo usage [codex|claude|all] [--json] [--limit N] [path]

Examples:
  prismo usage
  prismo usage codex --json
  prismo usage claude --limit 3`,
    watch: `Prismo Watch

Usage:
  prismo watch [codex|claude|all] [--json] [--once] [--report] [--rescue] [--guardrails] [--redact-paths] [--interval N] [path]

Examples:
  prismo watch codex
  prismo watch claude --once --json
  prismo watch --once --report
  prismo watch --once --redact-paths
  prismo watch --rescue
  prismo watch --guardrails

Output:
  Shows context pressure, recent growth, likely context leaks, repeated reads/commands, loop suspicion, one suggested action, and live intervention steps.
  --rescue prints a paste-ready prompt to recover a noisy or looping active session.
  --guardrails continuously updates .prismo/live-guardrails.md and .prismo/live-rescue-prompt.md for the active session.`,
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
  prismo doctor [--json] [--dry-run] [--apply-ignores-only] [--no-context-packs] [--limit N] [path]

Flow:
  1. Scan repo and local usage.
  2. Apply safe AI-context fixes.
  3. Generate .prismo/ optimized context files.
  4. Re-scan and show before/after score.

Notes:
  Doctor creates safe recommendation/context files only. It does not overwrite CLAUDE.md, AGENTS.md, .gitignore, or source code.`,
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
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    printCommandHelp(command);
    return;
  }
  if (!["dev", "init", "doctor", "setup", "scan", "optimize", "context", "cc", "usage", "watch", "demo"].includes(command)) {
    throw new Error(`Unknown command: ${command}. Try: prismo doctor, prismo watch, prismo init, prismo scan, prismo optimize, prismo context, prismo cc, or prismo usage`);
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
      noContextPacks: rest.includes("--no-context-packs"),
    });
    if (json) {
      console.log(JSON.stringify(toDoctorJsonPayload(result), null, 2));
      return;
    }
    console.log(renderDoctorTerminal(result));
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
    const positional = getPositionals(rest, new Set(["--limit"]));
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
          suggestedAction: latest?.prismo?.recommendations?.[0] || `${NPX_COMMAND} doctor`,
        }, null, 2));
        return;
      }
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(renderClaudeCostTerminal(summary));
    return;
  }

  if (command === "usage" || command === "watch") {
    const json = rest.includes("--json");
    const knownTools = new Set(["codex", "claude", "all"]);
    const positional = getPositionals(rest, new Set(["--limit", "--interval"]));
    const explicitTool = positional[0] && knownTools.has(positional[0].toLowerCase());
    const tool = explicitTool ? positional[0].toLowerCase() : "all";
    const target = explicitTool ? positional[1] || process.cwd() : positional[0] || process.cwd();
    const limitIndex = rest.indexOf("--limit");
    const intervalIndex = rest.indexOf("--interval");
    const limit = parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5);
    const intervalMs = parsePositiveInt(intervalIndex >= 0 ? rest[intervalIndex + 1] : null, 3) * 1000;
    const usageOptions = {
      tool,
      cwd: path.resolve(target),
      limit,
      json,
      once: rest.includes("--once"),
      report: rest.includes("--report"),
      rescue: rest.includes("--rescue"),
      guardrails: rest.includes("--guardrails"),
      redactPaths: rest.includes("--redact-paths"),
      intervalMs,
    };

    if (command === "watch") {
      await watchUsage(usageOptions);
      return;
    }

    const summary = getUsageSummary(usageOptions);
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
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
  const ciMode = rest.includes("--ci");
  const includeUsage = rest.includes("--usage");
  const limitIndex = rest.indexOf("--limit");
  const usageToolIndex = rest.indexOf("--usage-tool");
  const target = getPositionals(rest, new Set(["--limit", "--usage-tool"]))[0] || process.cwd();
  const scanDone = printStep(includeUsage ? "Scanning repo and local usage" : "Scanning repo", json || simple);
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
    } else if (!noReport) {
      report = writeReport(result);
    }
    const payload = toJsonPayload(result);
    if (ciMode) {
      payload.ci = evaluateCi(result);
      if (!payload.ci.passed) process.exitCode = 1;
    }
    if (fixActions.length) payload.fixActions = fixActions;
    if (report) payload.reportPath = report.reportPath;
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (simple) {
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
  } else if (!noReport && !simple) {
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
  renderSimpleScanReport,
  renderClaudeCostTerminal,
  renderUsageTerminal,
  renderRescuePrompt,
  renderLiveGuardrails,
  renderWatchTerminal,
  renderWatchReport,
  renderTerminalReport,
  renderDoctorTerminal,
  renderInitTerminal,
  runSetup,
  runOptimize,
  runDoctor,
  runInit,
  runCli,
  scanRepo,
  getClaudeCodeCostSummary,
  getUsageSummary,
  analyzeSessionFile,
  calculateClaudeCost,
  toDoctorJsonPayload,
  toJsonPayload,
  toWatchJsonPayload,
  watchUsage,
  writeWatchReport,
  writeReport,
};
