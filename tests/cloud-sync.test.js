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

  const connect = runPrismo(["connect", "--json", "--no-agent", "--token", "test-token", "--api-url", "http://127.0.0.1:3999", "--org", "acme", "--user", "dev@example.com", "--device", "Test Laptop"], { env, cwd: root });
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

test("sync captures Claude Code sessions when the repo path contains spaces", () => {
  const base = tempDir();
  const prismoHome = tempDir();
  const claudeHome = tempDir();
  // Repo path with a space, like the common "Code Projects" folder.
  const root = path.join(base, "My Code", "app");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "18.0.0" } }), "utf8");

  // Claude Code encodes the project folder by replacing path separators,
  // whitespace, and dots in the cwd with "-". Create both possible encodings.
  const encode = (p) => p.replace(/[\/\\:.\s]/g, "-");
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch {}
  for (const enc of new Set([encode(root), encode(realRoot)])) {
    const projDir = path.join(claudeHome, "projects", enc);
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "sess.jsonl"), [
      JSON.stringify({ type: "summary", summary: "spaced path work" }),
      JSON.stringify({ type: "user", message: { role: "user", content: "do work" }, timestamp: "2026-06-12T10:00:00Z" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 400000, output_tokens: 50000 }, content: [{ type: "text", text: "reading src/app.ts ".repeat(50) }] }, timestamp: "2026-06-12T10:01:00Z" }),
    ].join("\n"), "utf8");
  }

  const env = {
    PRISMO_HOME: prismoHome,
    PRISMO_CLAUDE_HOME: claudeHome,
    PRISMO_CODEX_HOME: path.join(base, "none"),
    PRISMO_CURSOR_HOME: path.join(base, "none"),
    PRISMO_CURSOR_APP_SUPPORT: path.join(base, "none"),
  };
  const res = runPrismo(["sync", "--dry-run", "--json"], { env, cwd: root });
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout).payload;
  const tools = (payload.sessions || []).map((s) => s.tool);
  assert.ok(tools.some((t) => String(t).includes("claude")), `expected a Claude Code session, got tools: ${JSON.stringify(tools)}`);
});
