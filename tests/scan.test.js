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
  fs.mkdirSync(path.join(root, ".prismo"), { recursive: true });
  fs.writeFileSync(path.join(root, ".prismo", "prismo-dev-report.md"), "old report", "utf8");

  const result = scanRepo(root);
  const actions = applyFixes(result);

  assert.ok(fs.existsSync(path.join(root, ".claudeignore")));
  assert.ok(fs.existsSync(path.join(root, ".cursorignore")));
  assert.ok(fs.readFileSync(path.join(root, ".claudeignore"), "utf8").includes("node_modules/"));
  assert.ok(fs.readFileSync(path.join(root, ".cursorignore"), "utf8").includes("node_modules/"));
  assert.ok(fs.readFileSync(path.join(root, ".cursorignore"), "utf8").includes(".prismo/"));
  assert.ok(fs.readFileSync(path.join(root, ".prismo", "prismo-dev-report.md"), "utf8").includes("PrismoDev Report"));
  assert.ok(actions.some((action) => action.includes("Backed up existing report")));
  assert.ok(fs.readdirSync(path.join(root, ".prismo")).some((name) => name.startsWith("prismo-dev-report.md.") && name.endsWith(".bak")));
});

test("existing .claudeignore creates .claudeignore.prismo-suggested instead of overwriting", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, ".claudeignore"), "custom-entry/\n", "utf8");
  fs.writeFileSync(path.join(root, ".cursorignore"), "cursor-custom/\n", "utf8");
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n", "utf8");

  const result = scanRepo(root);
  const actions = applyFixes(result);

  assert.equal(fs.readFileSync(path.join(root, ".claudeignore"), "utf8"), "custom-entry/\n");
  assert.equal(fs.readFileSync(path.join(root, ".cursorignore"), "utf8"), "cursor-custom/\n");
  assert.ok(fs.existsSync(path.join(root, ".claudeignore.prismo-suggested")));
  assert.ok(fs.existsSync(path.join(root, ".cursorignore.prismo-suggested")));
  assert.ok(fs.readFileSync(path.join(root, ".claudeignore.prismo-suggested"), "utf8").includes("dist/"));
  assert.ok(fs.readFileSync(path.join(root, ".cursorignore.prismo-suggested"), "utf8").includes("dist/"));
  assert.ok(actions.some((action) => action.includes(".claudeignore.prismo-suggested")));
  assert.ok(actions.some((action) => action.includes(".cursorignore.prismo-suggested")));
});

test("superset ignores skip suggested files and state/secrets are recommended", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, ".claudeignore"), [
    "node_modules/",
    ".next/",
    "dist/",
    "build/",
    "coverage/",
    ".turbo/",
    ".venv/",
    "venv/",
    "__pycache__/",
    "pycache/",
    ".pytest_cache/",
    ".cache/",
    "logs/",
    "*.log",
    "*.lock",
    "*.tmp",
    "*.min.js",
    "*.min.css",
    "coverage-final.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "test-results/",
    "playwright-report/",
    "events/",
    "event-dumps/",
    "session-dumps/",
    "source-streams/",
    "inbox-dumps/",
    "calendar-dumps/",
    "models/",
    "state-backups/",
    "backups/",
    "*.sqlite",
    "*.sqlite3",
    "*.db",
    "*_state.json",
    "*_tokens.json",
    "*_export.json",
    "*secret*.json",
    "*credential*.json",
    ".env",
    ".env.*",
  ].join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(root, ".cursorignore"), `${fs.readFileSync(path.join(root, ".claudeignore"), "utf8")}.prismo/\nprismo-optimized-CLAUDE.template.md\n`, "utf8");
  fs.writeFileSync(path.join(root, "heartbeat_state.json"), "{}", "utf8");
  fs.writeFileSync(path.join(root, "whoop_tokens.json"), "{}", "utf8");
  fs.writeFileSync(path.join(root, "data.sqlite"), "", "utf8");

  const result = scanRepo(root);
  assert.ok(result.recommendedClaudeIgnore.includes("*_state.json"));
  assert.ok(result.recommendedClaudeIgnore.includes("*_tokens.json"));
  assert.ok(result.recommendedClaudeIgnore.includes("*.sqlite"));
  assert.equal(result.missingClaudeIgnoreSuggestions.length, 0);
  assert.equal(result.missingCursorIgnoreSuggestions.length, 0);
  const actions = applyFixes(result);
  assert.equal(fs.existsSync(path.join(root, ".claudeignore.prismo-suggested")), false);
  assert.equal(fs.existsSync(path.join(root, ".cursorignore.prismo-suggested")), false);
  assert.ok(actions.some((action) => action.includes("already covers Prismo recommendations")));
});

test("source-stream dumps are detected as operational context noise", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "source-streams"), { recursive: true });
  const rows = Array.from({ length: 80 }, (_, index) => JSON.stringify({
    type: "calendar_event",
    timestamp: `2026-05-${String((index % 20) + 1).padStart(2, "0")}T12:00:00Z`,
    attendees: [`person${index}@example.com`, "team@example.com"],
    subject: `planning ${index}`,
    body: "mostly irrelevant event payload copied from an external source",
    issue: { repository: "example/repo", body: "long issue body" },
  })).join("\n");
  fs.writeFileSync(path.join(root, "source-streams", "calendar-events.jsonl"), rows.repeat(12), "utf8");

  const result = scanRepo(root);
  const payload = toJsonPayload(result);
  assert.equal(result.operationalNoise.level !== "Low", true);
  assert.ok(result.issues.some((issue) => issue.category === "operational_noise"));
  assert.ok(result.recommendedClaudeIgnore.includes("source-streams/"));
  assert.ok(result.recommendedClaudeIgnore.includes("source-streams/calendar-events.jsonl"));
  assert.ok(payload.operationalNoise.files.some((file) => file.path === "source-streams/calendar-events.jsonl"));
});

test("CLAUDE.md token estimate produces deterministic impact text and template", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "a".repeat(8000), "utf8");

  const result = scanRepo(root);
  const claude = result.instructionFiles.find((file) => file.path === "CLAUDE.md");
  applyFixes(result);

  assert.equal(claude.tokens, 2000);
  assert.ok(result.issues.some((issue) => issue.title.includes("CLAUDE.md") && issue.estimatedTokenImpact.includes("1,200")));
  assert.ok(result.issues.some((issue) => issue.title.includes("CLAUDE.md") && issue.estimatedTokenImpact.includes("~$0.14/session")));
  assert.ok(result.issues.some((issue) => issue.title.includes("CLAUDE.md") && issue.estimatedTokenImpact.includes("$4.32/month")));
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
  assert.ok(fs.existsSync(path.join(root, ".prismo", "prismo-AGENTS-recommendations.md")));
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
  assert.ok(report.includes("Recommended .cursorignore"));
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
  assert.equal(fs.existsSync(path.join(root, ".prismo", "prismo-dev-report.md")), false);
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
  assert.ok(result.stdout.includes("npx getprismo doctor"));
  assert.ok(result.stdout.includes("npx getprismo watch"));
  assert.ok(result.stdout.includes("npx getprismo cc timeline"));
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

test("scan --optimizer-fit recommends the right optimization path", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "24");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "echo ok" } }), "utf8");
  fs.writeFileSync(path.join(root, "logs", "debug.log"), "error\n".repeat(20000), "utf8");
  fs.writeFileSync(path.join(root, "dist", "bundle.js"), "x".repeat(700 * 1024), "utf8");
  fs.writeFileSync(path.join(sessionDir, "optimizer-fit.jsonl"), [
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-24T10:00:00Z", payload: { type: "session_meta", cwd: root, model: "gpt-test" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-24T10:01:00Z", payload: { type: "tool_result", content: "logs/debug.log dist/bundle.js package-lock.json\n".repeat(1000) } }),
  ].join("\n"), "utf8");

  const env = { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none"), PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") };
  const terminal = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--optimizer-fit", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.ok(terminal.stdout.includes("Prismo Optimizer Fit"));
  assert.ok(terminal.stdout.includes("Recommended Stack"));
  assert.ok(terminal.stdout.includes("Prismo shield") || terminal.stdout.includes("doctor --apply-suggestions"));
  assert.equal(fs.existsSync(path.join(root, ".prismo", "prismo-dev-report.md")), false);

  const json = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--optimizer-fit", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.optimizerFit.schemaVersion, 1);
  assert.ok(payload.optimizerFit.bottlenecks.some((item) => item.id === "output-sandboxing"));
  assert.ok(payload.optimizerFit.recommendedStack.length >= 1);
  assert.ok(payload.optimizerFit.roundTripContext);
  assert.ok(payload.optimizerFit.toolFit.some((item) => item.examples.includes("context-mode")));

  const reportCard = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--report-card", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(reportCard.status, 0, reportCard.stderr);
  assert.ok(reportCard.stdout.includes("PrismoDev Report Card"));
  assert.ok(reportCard.stdout.includes("Biggest waste"));
  assert.equal(fs.existsSync(path.join(root, ".prismo", "prismo-dev-report.md")), false);
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
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none"), PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.realUsage.totals.displayTokens, 1250000);
  assert.equal(payload.realUsage.confidence, "exact-local-log");
  assert.ok(payload.issues.some((issue) => issue.title.includes("Recent local AI sessions used")));
  assert.ok(payload.recommendations.some((rec) => rec.includes("real session usage")));
});

test("scan --usage turns session context leaks into ignore suggestions", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "21");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "logs", "debug.log"), "debug", "utf8");
  fs.writeFileSync(path.join(root, "dist", "app.js"), "bundle", "utf8");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}", "utf8");
  fs.writeFileSync(path.join(sessionDir, "leaks.jsonl"), [
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-21T10:00:00Z", payload: { type: "session_meta", cwd: root, model: "gpt-test" } }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-05-21T10:01:00Z",
      payload: {
        type: "tool_result",
        content: [
          "failure included package-lock.json",
          "logs/debug.log",
          "dist/app.js",
          "logs/debug.log",
          "dist/app.js",
        ].join("\n").repeat(20),
      },
    }),
  ].join("\n"), "utf8");

  const env = { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none"), PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") };
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--usage", "--json", "--no-report", "--limit", "1", root],
    { encoding: "utf8", env }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const patterns = payload.sessionIgnoreSuggestions.map((item) => item.pattern);
  assert.ok(patterns.includes("package-lock.json"));
  assert.ok(patterns.includes("logs/"));
  assert.ok(patterns.includes("dist/"));
  assert.ok(payload.suggestedClaudeIgnore.includes("logs/"));
  assert.ok(payload.suggestedClaudeIgnore.includes("dist/"));
  assert.ok(payload.issues.some((issue) => issue.title.includes("session-derived ignore")));

  const report = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--usage", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(report.status, 0, report.stderr);
  const markdown = fs.readFileSync(path.join(root, ".prismo", "prismo-dev-report.md"), "utf8");
  assert.ok(markdown.includes("Session-Derived Ignore Suggestions"));
  assert.ok(markdown.includes("logs/"));
});

test("scan --ci fails high-risk repos", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "large.json"), `{ "data": "${"x".repeat(700 * 1024)}" }`, "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--ci", "--no-report", root],
    { encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.ok(result.stdout.includes("Prismo CI"));
  assert.ok(result.stdout.includes("FAIL"));
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
