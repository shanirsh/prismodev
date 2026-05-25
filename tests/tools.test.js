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
  assert.equal(payload.tools.count, 11);
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
