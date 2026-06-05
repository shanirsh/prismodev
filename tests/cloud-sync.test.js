const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prismo-dev-cloud-sync-"));
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

test("connect, status, sync dry-run, and disconnect support seamless cloud setup", () => {
  const root = tempDir();
  const prismoHome = tempDir();
  const codexHome = tempDir();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "18.0.0" } }), "utf8");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const app = true;\n", "utf8");
  const sessionDir = path.join(codexHome, "sessions", "2026", "06", "04");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "sync-test.jsonl"), [
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-04T10:00:00Z", payload: { type: "session_meta", id: "sync-test", cwd: root, model: "gpt-test" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-04T10:01:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 300000, output_tokens: 80000, total_tokens: 380000 } } } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-04T10:02:00Z", payload: { type: "tool_result", content: "ERROR build failed\nsrc/app.ts\nsrc/app.ts\nnpm test\n".repeat(2000) } }),
  ].join("\n"), "utf8");

  const env = {
    PRISMO_HOME: prismoHome,
    PRISMO_CODEX_HOME: codexHome,
    PRISMO_CLAUDE_HOME: path.join(root, "none"),
    PRISMO_CURSOR_HOME: path.join(root, "none"),
    PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none"),
  };

  const connect = runPrismo(["connect", "--json", "--token", "test-token", "--api-url", "http://127.0.0.1:3999", "--org", "acme", "--user", "dev@example.com", "--device", "Test Laptop"], { env, cwd: root });
  assert.equal(connect.status, 0, connect.stderr);
  const connected = JSON.parse(connect.stdout);
  assert.equal(connected.connected, true);
  assert.equal(connected.tokenStored, true);
  assert.equal(connected.device.name, "Test Laptop");
  assert.equal(fs.existsSync(path.join(prismoHome, "config.json")), true);

  const status = runPrismo(["status", "--json"], { env, cwd: root });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.connected, true);
  assert.equal(statusPayload.org, "acme");

  const sync = runPrismo(["sync", "--json", "--dry-run", "--limit", "1", root], { env, cwd: root });
  assert.equal(sync.status, 0, sync.stderr);
  const payload = JSON.parse(sync.stdout);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.connected, true);
  assert.equal(payload.payload.privacy.rawPrompts, false);
  assert.equal(payload.payload.privacy.rawCode, false);
  assert.equal(payload.payload.aggregate.sessions, 1);
  assert.ok(payload.payload.aggregate.displayTokens >= 380000);
  assert.ok(payload.payload.sessions[0].waste.wastedTokens >= 0);
  assert.equal(payload.payload.sessions[0].repo.pathBasename, path.basename(root));

  const disconnect = runPrismo(["disconnect", "--json"], { env, cwd: root });
  assert.equal(disconnect.status, 0, disconnect.stderr);
  const disconnected = JSON.parse(disconnect.stdout);
  assert.equal(disconnected.disconnected, true);
  assert.equal(fs.existsSync(path.join(prismoHome, "config.json")), false);
});
