const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prismo-dev-guard-"));
}

function writeCodexSession(root, codexHome) {
  const sessionDir = path.join(codexHome, "sessions", "2026", "06", "06");
  fs.mkdirSync(sessionDir, { recursive: true });
  const noisyOutput = "ERROR build failed\nsrc/app.js\nsrc/app.js\nnpm test\n".repeat(5000);
  fs.writeFileSync(path.join(sessionDir, "guard-test.jsonl"), [
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-06T10:00:00Z", payload: { type: "session_meta", id: "guard-test", cwd: root, model: "gpt-test" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-06T10:01:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 700000, output_tokens: 10000, total_tokens: 710000 } } } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-06T10:02:00Z", payload: { type: "tool_result", content: noisyOutput } }),
  ].join("\n"), "utf8");
}

function runPrismo(args, options = {}) {
  return spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), ...args],
    {
      encoding: "utf8",
      env: { ...process.env, ...options.env },
      cwd: options.cwd || undefined,
    }
  );
}

function setupRepo() {
  const root = tempDir();
  const codexHome = tempDir();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }), "utf8");
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const app = true;\n", "utf8");
  writeCodexSession(root, codexHome);
  const env = {
    PRISMO_HOME: path.join(root, ".home"),
    PRISMO_CODEX_HOME: codexHome,
    PRISMO_CLAUDE_HOME: path.join(root, "none"),
    PRISMO_CURSOR_HOME: path.join(root, "none"),
    PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none"),
  };
  return { root, env };
}

test("guard dry-run previews proactive protections without writing local state", () => {
  const { root, env } = setupRepo();

  const result = runPrismo(["guard", "--json", "--dry-run", "--no-sync", root], { env, cwd: root });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "guard");
  assert.equal(payload.dryRun, true);
  assert.equal(payload.status, "preventing");
  assert.equal(payload.event.type, "prevention");
  assert.ok(payload.event.tokensPrevented > 0);
  assert.equal(payload.event.privacy.rawPrompts, false);
  assert.equal(payload.event.privacy.rawCode, false);
  assert.equal(payload.dashboardSync.reason, "disabled");
  assert.equal(fs.existsSync(path.join(root, ".prismo", "guard-state.json")), false);
  assert.equal(fs.existsSync(path.join(root, ".prismo", "guard-events.jsonl")), false);
});

test("guard writes local guardrail state and prevention events", () => {
  const { root, env } = setupRepo();

  const result = runPrismo(["guard", "--json", "--no-sync", root], { env, cwd: root });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "preventing");
  assert.equal(payload.files.guardStatePath, ".prismo/guard-state.json");
  assert.equal(payload.files.guardEventsPath, ".prismo/guard-events.jsonl");
  assert.equal(fs.existsSync(path.join(root, ".prismo", "guard-state.json")), true);
  assert.equal(fs.existsSync(path.join(root, ".prismo", "guard-events.jsonl")), true);
  assert.equal(fs.existsSync(path.join(root, ".prismo", "live-guardrails.md")), true);
  assert.equal(fs.existsSync(path.join(root, ".prismo", "live-context-throttle.md")), true);

  const state = JSON.parse(fs.readFileSync(path.join(root, ".prismo", "guard-state.json"), "utf8"));
  assert.equal(state.status, "preventing");
  assert.equal(state.lastEvent.privacy.fileContents, false);
});
