const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");

const { applyFixes, getUsageSummary, scanRepo, toJsonPayload, writeReport } = require("../lib/prismo-dev-scan");

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prismo-dev-scan-"));
}

test("flags oversized CLAUDE.md, missing .claudeignore, bloat dirs, and large files", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n", "utf8");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "Use concise instructions.\n".repeat(500), "utf8");
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "large.json"), `{ "data": "${"x".repeat(600 * 1024)}" }`, "utf8");

  const result = scanRepo(root);

  assert.equal(result.hasClaudeIgnore, false);
  assert.ok(result.score < 100);
  assert.ok(result.issues.some((issue) => issue.title.includes("CLAUDE.md")));
  assert.ok(result.issues.some((issue) => issue.title.includes(".claudeignore")));
  assert.ok(result.issues.every((issue) => issue.severity && issue.category && issue.description && issue.recommendation));
  assert.ok(result.exposedHighRiskDirs.some((dir) => dir.path === "node_modules"));
  assert.ok(result.exposedLargeFiles.some((file) => file.path === "large.json"));
});

test("fix mode creates .claudeignore and report without overwriting existing report silently", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Keep changes small.\n", "utf8");
  fs.writeFileSync(path.join(root, "prismo-dev-report.md"), "old report", "utf8");

  const result = scanRepo(root);
  const actions = applyFixes(result);

  assert.ok(fs.existsSync(path.join(root, ".claudeignore")));
  assert.ok(fs.readFileSync(path.join(root, ".claudeignore"), "utf8").includes("node_modules/"));
  assert.ok(fs.readFileSync(path.join(root, "prismo-dev-report.md"), "utf8").includes("PrismoDev Report"));
  assert.ok(actions.some((action) => action.includes("Backed up existing report")));
  assert.ok(fs.readdirSync(root).some((name) => name.startsWith("prismo-dev-report.md.") && name.endsWith(".bak")));
});

test("existing .claudeignore creates .claudeignore.prismo-suggested instead of overwriting", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, ".claudeignore"), "custom-entry/\n", "utf8");
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n", "utf8");

  const result = scanRepo(root);
  const actions = applyFixes(result);

  assert.equal(fs.readFileSync(path.join(root, ".claudeignore"), "utf8"), "custom-entry/\n");
  assert.ok(fs.existsSync(path.join(root, ".claudeignore.prismo-suggested")));
  assert.ok(fs.readFileSync(path.join(root, ".claudeignore.prismo-suggested"), "utf8").includes("dist/"));
  assert.ok(actions.some((action) => action.includes(".claudeignore.prismo-suggested")));
});

test("CLAUDE.md token estimate produces deterministic impact text and template", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "a".repeat(2400), "utf8");

  const result = scanRepo(root);
  const claude = result.instructionFiles.find((file) => file.path === "CLAUDE.md");
  applyFixes(result);

  assert.equal(claude.tokens, 600);
  assert.ok(result.issues.some((issue) => issue.title.includes("CLAUDE.md") && issue.estimatedTokenImpact.includes("100")));
  assert.ok(fs.existsSync(path.join(root, "prismo-optimized-CLAUDE.template.md")));
});

test("AGENTS.md and .codex config are detected as Codex findings", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, ".codex"));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Codex instructions.\n".repeat(200), "utf8");
  fs.writeFileSync(path.join(root, ".codex", "config.toml"), "[mcp_servers.one]\ncommand = \"x\"\n", "utf8");

  const result = scanRepo(root);
  applyFixes(result);

  assert.ok(result.instructionFiles.some((file) => file.path === "AGENTS.md"));
  assert.ok(result.codexConfig.files.some((file) => file.includes(".codex/config.toml")));
  assert.ok(result.issues.some((issue) => issue.category === "codex_config"));
  assert.ok(fs.existsSync(path.join(root, "prismo-AGENTS-recommendations.md")));
});

test("writeReport generates markdown with Claude and Codex recommendations", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Do the task.\n", "utf8");
  const result = scanRepo(root);
  const { reportPath } = writeReport(result);
  const report = fs.readFileSync(reportPath, "utf8");

  assert.ok(report.includes("# PrismoDev Report"));
  assert.ok(report.includes("Executive Summary"));
  assert.ok(report.includes("Claude Code Findings"));
  assert.ok(report.includes("OpenAI/Codex Findings"));
  assert.ok(report.includes("Disclaimer"));
});

test("--json prints valid JSON only with expected keys", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "Use concise instructions.\n".repeat(50), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--json", "--no-report", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.scannedPath, root);
  assert.equal(typeof payload.score, "number");
  assert.ok(Array.isArray(payload.issues));
  assert.ok(Array.isArray(payload.suggestedClaudeIgnore));
  assert.ok(payload.claudeFindings);
  assert.ok(payload.codexFindings);
  assert.ok(payload.agentReadiness);
  assert.ok(payload.optimizationStack);
  assert.ok(payload.toolOutputRisk);
  assert.ok(payload.proxyTrackingReadiness);
  assert.equal(result.stdout.trim().startsWith("{"), true);
});

test("scan --simple prints plain-English output and does not write a report", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "Use concise instructions.\n".repeat(50), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--simple", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("PrismoDev Simple Scan"));
  assert.ok(result.stdout.includes("Plain English:"));
  assert.ok(result.stdout.includes("does not need API keys"));
  assert.equal(fs.existsSync(path.join(root, "prismo-dev-report.md")), false);
});

test("demo command is safe for first-time users", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "demo"],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("PrismoDev"));
  assert.ok(result.stdout.includes("Try it on your repo"));
  assert.ok(result.stdout.includes("npx getprismo scan --usage"));
});

test("scan reports coding-agent readiness, optimization stack, tool-output risk, and proxy tracking", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: "14.0.0" } }), "utf8");
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(root, ".rtk"), { recursive: true });
  fs.mkdirSync(path.join(root, "playwright-report"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "config.toml"), "[mcp_servers.files]\ncommand = \"x\"\n", "utf8");
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ mcpServers: { one: {}, two: {} }, hooks: { PreToolUse: [{ command: "echo ok" }] } }), "utf8");
  fs.writeFileSync(path.join(root, "playwright-report", "trace.json"), `{ "trace": "${"x".repeat(650 * 1024)}" }`, "utf8");

  const result = scanRepo(root);
  const payload = JSON.parse(JSON.stringify(toJsonPayload(result)));

  assert.equal(result.agentReadiness.claudeCode.detected, true);
  assert.equal(result.agentReadiness.codex.detected, true);
  assert.equal(result.optimizationStack.tools.rtk.detected, true);
  assert.equal(result.optimizationStack.claudeMcpServers, 2);
  assert.equal(result.toolOutputRisk.level !== "Low", true);
  assert.ok(result.issues.some((issue) => issue.title.includes("Tool output risk")));
  assert.equal(payload.proxyTrackingReadiness.exactApiTracking.available, true);
  assert.equal(payload.agentReadiness.codex.exactProxyTracking, "available-when-using-api-key-base-url-mode");
});

test("optimize generates AI-readable context files in .prismo", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "frontend", "src", "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "backend", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "frontend", "package.json"), JSON.stringify({
    dependencies: { next: "14.0.0", react: "18.0.0" },
    devDependencies: { typescript: "5.0.0", tailwindcss: "3.0.0" },
  }), "utf8");
  fs.writeFileSync(path.join(root, "backend", "requirements.txt"), "fastapi\nsqlalchemy\nredis\n", "utf8");
  fs.writeFileSync(path.join(root, "backend", "app", "main.py"), "from fastapi import FastAPI\n", "utf8");
  fs.writeFileSync(path.join(root, "frontend", "src", "app", "page.tsx"), "export default function Page() { return null }\n", "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Prismo Optimize"));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "architecture-summary.md")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "backend-summary.md")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "frontend-summary.md")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "recommended-CLAUDE.md")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "recommended-AGENTS.md")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "recommended-.claudeignore")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "recommended-.gitignore-additions")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "optimize-report.md")));
});

test("optimize scoped frontend command generates frontend-context.md", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "frontend", "src", "components"), { recursive: true });
  fs.writeFileSync(path.join(root, "frontend", "package.json"), JSON.stringify({ dependencies: { react: "18.0.0" } }), "utf8");
  fs.writeFileSync(path.join(root, "frontend", "src", "components", "Button.tsx"), "export function Button() { return null }\n", "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", "frontend", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(root, ".prismo", "frontend-context.md")));
  assert.ok(fs.readFileSync(path.join(root, ".prismo", "frontend-context.md"), "utf8").includes("Button.tsx"));
});

test("optimize --json outputs valid JSON only", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { express: "4.0.0" } }), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", "--json", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.frameworks.includes("Express"));
  assert.ok(payload.generatedFiles.includes(".prismo/architecture-summary.md"));
  assert.ok(Array.isArray(payload.optimizationSuggestions));
  assert.ok(payload.starterPrompt.includes(".prismo/architecture-summary.md"));
  assert.equal(result.stdout.trim().startsWith("{"), true);
});

test("context command prints copy-pasteable prompt", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "frontend", "src", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "frontend", "package.json"), JSON.stringify({ dependencies: { next: "14.0.0", react: "18.0.0" } }), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "context", "frontend", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Prismo Frontend Context Prompt"));
  assert.ok(result.stdout.includes(".prismo/frontend-context.md"));
  assert.ok(result.stdout.includes("Copy/Paste Task Wrapper"));
});

test("context --json outputs prompt metadata", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { express: "4.0.0" } }), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "context", "--json", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.contextFile, ".prismo/architecture-summary.md");
  assert.ok(payload.prompt.includes("Use Prismo's compact repo context"));
  assert.equal(result.stdout.trim().startsWith("{"), true);
});

test("usage command reads exact Codex token_count events from local JSONL", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "08");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "rollout-test.jsonl"), [
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-08T10:00:00Z", payload: { type: "session_meta", id: "codex-test", cwd: root, model: "gpt-test" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-08T10:01:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 300, total_tokens: 1500 } } } }),
  ].join("\n"), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "usage", "codex", "--json", "--limit", "1", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sessions[0].tool, "codex");
  assert.equal(payload.sessions[0].displayTokens, 1100);
  assert.equal(payload.sessions[0].contextTokens, 1500);
  assert.equal(payload.sessions[0].exactAvailable, true);
  assert.equal(payload.sessions[0].confidence, "exact-local-log");
});

test("usage summary reads exact Claude Code message usage from local JSONL", () => {
  const root = tempRepo();
  const claudeHome = tempRepo();
  const safeProject = root.replace(/[\/\\:]/g, "-").replace(/^-/, "-");
  const projectDir = path.join(claudeHome, "projects", safeProject);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "claude-test.jsonl"), [
    JSON.stringify({ type: "user", timestamp: "2026-05-08T10:00:00Z", cwd: root, message: { role: "user", content: "hello" } }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-05-08T10:01:00Z",
      requestId: "req-1",
      message: {
        id: "msg-1",
        role: "assistant",
        model: "claude-test",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 40,
        },
        content: [{ type: "text", text: "done" }],
      },
    }),
  ].join("\n"), "utf8");

  const originalClaudeHome = process.env.PRISMO_CLAUDE_HOME;
  const originalCodexHome = process.env.PRISMO_CODEX_HOME;
  process.env.PRISMO_CLAUDE_HOME = claudeHome;
  process.env.PRISMO_CODEX_HOME = path.join(root, "none");
  try {
    const payload = getUsageSummary({ tool: "claude", cwd: root, limit: 1 });
    assert.equal(payload.sessions[0].tool, "claude-code");
    assert.equal(payload.sessions[0].exactTotalTokens, 100);
    assert.equal(payload.sessions[0].exactAvailable, true);
    assert.equal(payload.sessions[0].confidence, "exact-local-log");
  } finally {
    if (originalClaudeHome === undefined) delete process.env.PRISMO_CLAUDE_HOME;
    else process.env.PRISMO_CLAUDE_HOME = originalClaudeHome;
    if (originalCodexHome === undefined) delete process.env.PRISMO_CODEX_HOME;
    else process.env.PRISMO_CODEX_HOME = originalCodexHome;
  }
});

test("usage terminal output and watch --once --json are script-friendly", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "08");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "rollout-test.jsonl"), [
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-08T10:00:00Z", payload: { type: "session_meta", cwd: root, model: "gpt-test" } }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-05-08T10:01:00Z",
      payload: { type: "response", role: "assistant", content: [{ type: "tool_use", name: "shell", input: "npm test" }] },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-05-08T10:02:00Z",
      payload: { type: "tool_result", content: "failure\n".repeat(30000) },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-05-08T10:03:00Z",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } } },
    }),
  ].join("\n"), "utf8");
  const env = { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none") };

  const terminal = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "usage", "codex", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.ok(terminal.stdout.includes("Prismo Usage"));
  assert.ok(terminal.stdout.includes("Exact local-log tokens"));

  const watch = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(watch.status, 0, watch.stderr);
  const payload = JSON.parse(watch.stdout);
  assert.equal(payload.sessions[0].displayTokens, 150);
  assert.ok(payload.live);
  assert.equal(payload.live.activeSession.tool, "codex");
  assert.ok(payload.live.warnings.some((warning) => warning.includes("Tool/output")));
  assert.ok(payload.live.recommendedAction.includes("context"));

  const watchTerminal = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(watchTerminal.status, 0, watchTerminal.stderr);
  assert.ok(watchTerminal.stdout.includes("Active Session"));
  assert.ok(watchTerminal.stdout.includes("Live Warnings"));
  assert.ok(watchTerminal.stdout.includes("Next Action"));
});

test("scan --usage folds exact local session usage into diagnostics", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "08");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "rollout-test.jsonl"), JSON.stringify({
    type: "event_msg",
    timestamp: "2026-05-08T10:01:00Z",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1200000, output_tokens: 50000, total_tokens: 1250000 } } },
  }), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--usage", "--json", "--no-report", "--limit", "1", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.realUsage.totals.displayTokens, 1250000);
  assert.equal(payload.realUsage.confidence, "exact-local-log");
  assert.ok(payload.issues.some((issue) => issue.title.includes("Recent local AI sessions used")));
  assert.ok(payload.recommendations.some((rec) => rec.includes("real session usage")));
});

test("setup command reports detected tools and tracking modes without modifying config", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "18.0.0" } }), "utf8");
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "config.toml"), "[mcp_servers.files]\ncommand = \"x\"\n", "utf8");
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ command: "echo ok" }] } }), "utf8");
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "08");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "rollout-test.jsonl"), [
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-08T10:00:00Z", payload: { type: "session_meta", cwd: root } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-08T10:01:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 300, output_tokens: 80, total_tokens: 380 } } } }),
  ].join("\n"), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "setup", "--json", "--skip-proxy-check", "--limit", "1", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.detected.codex.detected, true);
  assert.equal(payload.detected.codex.localLogsFound, true);
  assert.equal(payload.detected.claudeCode.detected, true);
  assert.ok(payload.trackingModes.some((mode) => mode.id === "exact-api-proxy"));
  assert.ok(payload.recommendedCommands.some((command) => command.includes("watch")));
  assert.equal(fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8").includes("mcp_servers"), true);
});

test("command-specific help and demo mode are available", () => {
  const help = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--help"],
    { encoding: "utf8" }
  );
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes("PrismoDev"));
  assert.ok(help.stdout.includes("--usage reads local Codex/Claude Code logs"));

  const setupHelp = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "setup", "--help"],
    { encoding: "utf8" }
  );
  assert.equal(setupHelp.status, 0, setupHelp.stderr);
  assert.ok(setupHelp.stdout.includes("PrismoDev Setup"));
  assert.ok(setupHelp.stdout.includes("read-only"));

  const demo = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "demo"],
    { encoding: "utf8" }
  );
  assert.equal(demo.status, 0, demo.stderr);
  assert.ok(demo.stdout.includes("PrismoDev"));
  assert.ok(demo.stdout.includes("Try it on your repo"));
});

test("dev command runs guided scan, optimize, and prompt flow", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: "14.0.0", react: "18.0.0" } }), "utf8");
  fs.mkdirSync(path.join(root, "src", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app", "page.tsx"), "export default function Page() { return null }\n", "utf8");
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "08");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "rollout-test.jsonl"), JSON.stringify({
    type: "event_msg",
    timestamp: "2026-05-08T10:01:00Z",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 } } },
  }), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "dev", "--json", "--limit", "1", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.generatedFiles.includes(".prismo/architecture-summary.md"));
  assert.ok(payload.prompt.includes(".prismo/"));
  assert.equal(payload.realUsage.totals.displayTokens, 1200);
});

test("missing scan path returns a clear error", () => {
  const missing = path.join(os.tmpdir(), "prismo-missing-path-for-test");
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", missing],
    { encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("Path not found"));
});
