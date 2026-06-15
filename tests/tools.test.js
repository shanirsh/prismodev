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
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none"), PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") } }
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

test("bridge command explains optional live interception levels", () => {
  const root = tempRepo();
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "bridge", "--json", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "bridge");
  assert.equal(payload.optional, true);
  assert.equal(payload.root, root);
  assert.equal(payload.privacy.rawPrompts, false);
  assert.deepEqual(payload.agents.map((agent) => agent.tool), ["Claude Code", "Codex", "Cursor"]);
  assert.equal(payload.agents[0].level, "hard-block");
  assert.ok(payload.agents.slice(1).every((agent) => agent.level === "detect-and-repair"));
});

test("protect command enables local protection even before cloud connect", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }), "utf8");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "short instructions\n", "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "protect", "--json", root],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PRISMO_HOME: path.join(root, ".home"),
        PRISMO_CLAUDE_HOME: path.join(root, "none"),
        PRISMO_CODEX_HOME: path.join(root, "none"),
        PRISMO_CURSOR_HOME: path.join(root, "none"),
        PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none"),
      },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "protect");
  assert.ok(payload.steps.some((step) => step.step === "doctor" && step.ok));
  assert.ok(payload.steps.some((step) => step.step === "enforce" && step.ok));
  assert.ok(payload.steps.some((step) => step.step === "connector" && !step.ok));
  assert.equal(fs.existsSync(path.join(root, ".prismo", "context-firewall.md")), true);
  assert.equal(fs.existsSync(path.join(root, ".claude", "settings.json")), true);
});

test("instructions audit separates observable violations, partial compliance, and influence-unknown rules", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  fs.mkdirSync(path.join(root, "src", "api"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "schema.ts"), "export const user = {}\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "api", "routes.ts"), "export const routes = []\n", "utf8");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), [
    "- Do not read package-lock.json or generated dist artifacts.",
    "- Always read src/schema.ts before editing src/api/routes.ts.",
    "- Keep changes small and focused.",
    "- Keep changes small and focused.",
    "- This project values excellence and quality in all work.",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(root, "AGENTS.md"), [
    "- Do not read package-lock.json or generated dist artifacts.",
    "- Use shield for noisy command output.",
  ].join("\n"), "utf8");
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "26");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "instructions.jsonl"), [
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-26T10:00:00Z", payload: { type: "session_meta", id: "instructions-test", cwd: root, model: "gpt-test" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-26T10:01:00Z", payload: { type: "tool_result", content: "package-lock.json\ndist/app.js\nlogs/debug.log\nnpm test failed\n".repeat(12000) } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-26T10:02:00Z", payload: { type: "tool_result", content: "read src/schema.ts before edit src/api/routes.ts\nERROR route tests failed\n" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-26T10:03:00Z", payload: { type: "tool_result", content: "read src/schema.ts before edit src/api/routes.ts\nERROR route tests failed\n" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-26T10:04:00Z", payload: { type: "tool_result", content: "read src/schema.ts before edit src/api/routes.ts\nERROR route tests failed\n" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-26T10:05:00Z", payload: { type: "tool_result", content: "read src/schema.ts before edit src/api/routes.ts\nERROR route tests failed\n" } }),
  ].join("\n"), "utf8");
  const env = { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none"), PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") };

  const json = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "instructions", "audit", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.command, "instructions audit");
  assert.equal(payload.files.length, 2);
  assert.ok(payload.summary.totalRules >= 5);
  assert.ok(payload.summary.duplicatedRules >= 2);
  assert.ok(payload.prunable.some((rule) => rule.status === "observably-violated"));
  assert.ok(payload.prunable.some((rule) => rule.status === "duplicate"));
  assert.ok(payload.partialCompliance.some((rule) => rule.status === "partial-compliance"));
  assert.ok(payload.influenceUnknown.some((rule) => rule.status === "influence-unknown"));

  const ablate = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "instructions", "ablate", "--dry-run", "--json", "--samples", "6", "--limit", "20", root],
    { encoding: "utf8", env }
  );
  assert.equal(ablate.status, 0, ablate.stderr);
  const ablatePayload = JSON.parse(ablate.stdout);
  assert.equal(ablatePayload.command, "instructions ablate");
  assert.equal(ablatePayload.dryRun, true);
  assert.equal(ablatePayload.samples, 6);
  assert.ok(ablatePayload.candidates.some((rule) => rule.mode === "rewrite-as-acceptance-check"));
  assert.ok(ablatePayload.protocol.some((line) => line.includes("one instruction candidate")));

  const terminal = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "instructions", "audit", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.ok(terminal.stdout.includes("Prismo Instruction ROI Audit"));
  assert.ok(terminal.stdout.includes("Safely Prunable"));
  assert.ok(terminal.stdout.includes("Partial Compliance"));
  assert.ok(terminal.stdout.includes("Influence Unknown"));

  const ablateTerminal = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "instructions", "ablate", "--dry-run", "--samples", "6", root],
    { encoding: "utf8", env }
  );
  assert.equal(ablateTerminal.status, 0, ablateTerminal.stderr);
  assert.ok(ablateTerminal.stdout.includes("Prismo Instruction Ablation Plan"));
  assert.ok(ablateTerminal.stdout.includes("Mode: dry run"));

  const applyDryRun = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "instructions", "apply", "--dry-run", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(applyDryRun.status, 0, applyDryRun.stderr);
  const applyPreview = JSON.parse(applyDryRun.stdout);
  assert.equal(applyPreview.command, "instructions apply");
  assert.equal(applyPreview.dryRun, true);
  assert.ok(applyPreview.safeChanges.length >= 2);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8").includes("Keep changes small and focused.\n- Keep changes small and focused."), true);

  const apply = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "instructions", "apply", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(apply.status, 0, apply.stderr);
  const applied = JSON.parse(apply.stdout);
  assert.equal(applied.dryRun, false);
  assert.ok(applied.changedFiles.includes("CLAUDE.md"));
  assert.ok(applied.backups.some((backup) => backup.file === "CLAUDE.md"));
  assert.equal(fs.existsSync(path.join(root, ".prismo", "instructions-apply-report.md")), true);
  const claudeText = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  const agentsText = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.equal((claudeText.match(/Keep changes small and focused/g) || []).length, 1);
  assert.equal(claudeText.includes("Do not read package-lock.json"), true);
  assert.equal(agentsText.includes("Use shield for noisy command output."), true);
  assert.equal(agentsText.includes("Do not read package-lock.json"), false);
});

test("firewall generates scoped context policy files", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "backend", "app", "auth"), { recursive: true });
  fs.mkdirSync(path.join(root, "backend", "app", "routes"), { recursive: true });
  fs.mkdirSync(path.join(root, "coverage"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { express: "4.0.0" } }), "utf8");
  fs.writeFileSync(path.join(root, "backend", "app", "auth", "security.py"), "def auth(): pass\n", "utf8");
  fs.writeFileSync(path.join(root, "backend", "app", "routes", "users.py"), "def route(): pass\n", "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "firewall", "auth-bug", "--json", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.scope, "auth");
  assert.ok(payload.allowed.some((item) => item.includes("auth")));
  assert.ok(payload.blocked.includes("node_modules/**"));
  assert.ok(payload.generatedFiles.includes(".prismo/context-firewall.md"));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "context-firewall.md")));
  assert.ok(fs.readFileSync(path.join(root, ".prismo", "firewall-prompt.md"), "utf8").includes("Follow .prismo/context-firewall.md"));
});

test("firewall updates generated policy files without backups", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "backend", "app", "auth"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { express: "4.0.0" } }), "utf8");
  fs.writeFileSync(path.join(root, "backend", "app", "auth", "security.py"), "def auth(): pass\n", "utf8");

  const first = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "firewall", "enforcement", "--json", root],
    { encoding: "utf8" }
  );
  assert.equal(first.status, 0, first.stderr);

  const second = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "firewall", "repeated-file-reads", "--json", root],
    { encoding: "utf8" }
  );
  assert.equal(second.status, 0, second.stderr);
  assert.ok(fs.readFileSync(path.join(root, ".prismo", "firewall-prompt.md"), "utf8").includes("repeated-file-reads task"));

  const backups = fs.readdirSync(path.join(root, ".prismo")).filter((name) => name.endsWith(".bak"));
  assert.deepEqual(backups, []);
});

test("init dry-run previews npm scripts without modifying package.json", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: {} }, null, 2), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "init", "--dry-run", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Mode: dry run"));
  assert.ok(result.stdout.includes("Would add npm scripts"));
  assert.equal(fs.existsSync(path.join(root, ".prismo", "README.md")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts["ai:doctor"], undefined);
});

test("shield stores full command output and returns compact summary", () => {
  const root = tempRepo();
  const script = [
    "console.log('line '.repeat(4000));",
    "console.error('ERROR: build failed at src/app.ts');",
  ].join("");
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "shield", "--json", root, "--", process.execPath, "-e", script],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.exitCode, 0);
  assert.ok(payload.output.estimatedTokens > 1000);
  assert.ok(payload.output.interestingLines.some((line) => line.includes("ERROR: build failed")));
  assert.ok(fs.existsSync(path.join(root, payload.stored.stdout)));
  assert.ok(fs.existsSync(path.join(root, payload.stored.stderr)));
  assert.ok(fs.existsSync(path.join(root, payload.stored.directory, "summary.json")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "shield", "index.jsonl")));
});

test("shield last and search retrieve indexed output", () => {
  const root = tempRepo();
  const script = [
    "console.log('AUTH_FAILURE payment session expected 200 received 401 '.repeat(200));",
    "console.error('ERROR: AUTH_FAILURE token expired in auth middleware');",
  ].join("");
  const run = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "shield", "--json", root, "--", process.execPath, "-e", script],
    { encoding: "utf8" }
  );
  assert.equal(run.status, 0, run.stderr);

  const last = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "shield", "last", "--json", root],
    { encoding: "utf8" }
  );
  assert.equal(last.status, 0, last.stderr);
  const lastPayload = JSON.parse(last.stdout);
  assert.equal(lastPayload.runs.length, 1);
  assert.ok(lastPayload.runs[0].command.includes(process.execPath));

  const search = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "shield", "search", "AUTH_FAILURE", "--json", root],
    { encoding: "utf8" }
  );
  assert.equal(search.status, 0, search.stderr);
  const searchPayload = JSON.parse(search.stdout);
  assert.ok(["sqlite-fts5", "jsonl-fallback"].includes(searchPayload.mode));
  assert.ok(searchPayload.results.some((item) => String(item.snippet).includes("AUTH_FAILURE")));
});

test("benchmark measures command output and session round trips", () => {
  const root = tempRepo();
  const script = [
    "console.log('AUTH_FAILURE payment session expected 200 received 401 '.repeat(200));",
    "console.error('ERROR: AUTH_FAILURE token expired in auth middleware');",
  ].join("");
  const command = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "benchmark", "--json", root, "--", process.execPath, "-e", script],
    { encoding: "utf8" }
  );
  assert.equal(command.status, 0, command.stderr);
  const commandPayload = JSON.parse(command.stdout);
  assert.equal(commandPayload.mode, "command");
  assert.ok(commandPayload.rawOutput.estimatedTokens > commandPayload.shieldedSummary.estimatedTokens);
  assert.ok(commandPayload.estimatedTokenReductionPercent > 0);

  const codexHome = tempRepo();
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "24");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "bench.jsonl"), [
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-24T10:00:00Z", payload: { type: "session_meta", cwd: root, model: "gpt-test" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-24T10:01:00Z", payload: { type: "tool_result", content: "src/app.ts npm test failed\n".repeat(20) } }),
  ].join("\n"), "utf8");
  const session = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "benchmark", "session", "--json", "--limit", "1", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none"), PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") } }
  );
  assert.equal(session.status, 0, session.stderr);
  const sessionPayload = JSON.parse(session.stdout);
  assert.equal(sessionPayload.mode, "session");
  assert.ok(sessionPayload.roundTripContext);
});

test("--version prints the package version", () => {
  const pkg = require("../package.json");
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "--version"],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), pkg.version);
});

test("mcp server initializes and lists Prismo tools", () => {
  const root = tempRepo();
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    "",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "mcp", root],
    { encoding: "utf8", input }
  );

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].result.serverInfo.name, "prismodev");
  const toolNames = lines[1].result.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("prismo_scan"));
  assert.ok(toolNames.includes("prismo_multi_agent_watch"));
  assert.ok(toolNames.includes("prismo_shield_search"));
  assert.ok(toolNames.includes("prismo_cc_timeline"));
  assert.ok(toolNames.includes("prismo_receipt"));
  assert.ok(toolNames.includes("prismo_instructions_ablate"));
  assert.ok(toolNames.includes("prismo_replay"));
  assert.ok(toolNames.includes("prismo_boundaries"));
  assert.ok(toolNames.includes("prismo_should_shield"));
  assert.ok(toolNames.includes("prismo_loop_check"));
  assert.ok(toolNames.includes("prismo_context_guard"));
});

test("mcp prismo_should_shield decides per command", () => {
  const root = tempRepo();
  function callShield(command) {
    const input = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "prismo_should_shield", arguments: { command, path: root } } }),
      "",
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "..", "bin", "prismo.js"), "mcp", root],
      { encoding: "utf8", input, env: { ...process.env, PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") } }
    );
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    return JSON.parse(lines[1].result.content[0].text);
  }

  const test1 = callShield("npm test");
  assert.equal(test1.shouldShield, true);
  assert.ok(test1.recommended.includes("shield -- npm test"));

  const test2 = callShield("git status");
  assert.equal(test2.shouldShield, false);
  assert.equal(test2.recommended, null);
});

test("mcp doctor validates tools and prints config", () => {
  const root = tempRepo();
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "mcp", "doctor", "--json", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.server.name, "prismodev");
  assert.equal(payload.tools.count, 20);
  assert.equal(payload.tools.hasShield, true);
  assert.equal(payload.smoke.scan.ok, true);
  assert.deepEqual(payload.config.mcpServers.prismodev.args.slice(0, 3), ["-y", "getprismo", "mcp"]);

  const terminal = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "mcp", "doctor", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") } }
  );
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.ok(terminal.stdout.includes("Prismo MCP Doctor"));
  assert.ok(terminal.stdout.includes("Status: ready"));
  assert.ok(terminal.stdout.includes("\"getprismo\""));
});
