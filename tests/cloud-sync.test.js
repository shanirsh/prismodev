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

test("sync preserves Claude Code worker metadata without double-counting parent rollups", () => {
  const base = tempDir();
  const prismoHome = tempDir();
  const claudeHome = tempDir();
  const root = path.join(base, "app");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "18.0.0" } }), "utf8");

  const encode = (p) => p.replace(/[\/\\:.\s]/g, "-");
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch {}
  const projectDirs = Array.from(new Set([encode(root), encode(realRoot)]))
    .map((enc) => path.join(claudeHome, "projects", enc));
  for (const projectDir of projectDirs) fs.mkdirSync(projectDir, { recursive: true });
  const parentRows = [
    JSON.stringify({ type: "summary", summary: "parent work", cwd: root }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-12T10:01:00Z",
      requestId: "req-parent",
      message: {
        id: "msg-parent",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 1000, output_tokens: 200 },
        content: [{ type: "text", text: "parent session" }],
      },
    }),
  ].join("\n");
  const workerRows = [
    JSON.stringify({
      type: "tool_permission",
      timestamp: "2026-06-12T10:02:00Z",
      cwd: root,
      parentSessionId: "parent",
      workerId: "worker-1",
      toolUseId: "toolu_123",
      permissionRequestId: "perm_123",
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-12T10:03:00Z",
      requestId: "req-worker",
      message: {
        id: "msg-worker",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 500, output_tokens: 100 },
        content: [{ type: "text", text: "worker session" }],
      },
    }),
  ].join("\n");
  for (const projectDir of projectDirs) {
    fs.writeFileSync(path.join(projectDir, "parent.jsonl"), parentRows, "utf8");
    fs.writeFileSync(path.join(projectDir, "worker.jsonl"), workerRows, "utf8");
  }

  const env = {
    PRISMO_HOME: prismoHome,
    PRISMO_CLAUDE_HOME: claudeHome,
    PRISMO_CODEX_HOME: path.join(base, "none"),
    PRISMO_CURSOR_HOME: path.join(base, "none"),
    PRISMO_CURSOR_APP_SUPPORT: path.join(base, "none"),
  };
  const res = runPrismo(["sync", "--dry-run", "--json", "--limit", "5"], { env, cwd: root });
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout).payload;
  const parent = payload.sessions.find((s) => s.sessionId === "parent");
  const worker = payload.sessions.find((s) => s.sessionId === "worker");
  assert.equal(parent.accounting.countsTowardTotals, true);
  assert.equal(parent.accounting.sourceOfTruth, "claude-code-jsonl");
  assert.equal(worker.run.role, "worker");
  assert.equal(worker.run.parentSessionId, "parent");
  assert.equal(worker.run.workerId, "worker-1");
  assert.equal(worker.run.toolUseId, "toolu_123");
  assert.equal(worker.run.permissionRequestId, "perm_123");
  assert.equal(worker.accounting.countsTowardTotals, false);
  assert.equal(worker.accounting.sourceOfTruth, "parent-session-rollup");
  assert.equal(payload.aggregate.displayTokens, parent.tokens.display);
});

test("sync --all-repos captures sessions from multiple repos, each attributed to its own repo", () => {
  const base = tempDir();
  const prismoHome = tempDir();
  const claudeHome = tempDir();
  const repoA = path.join(base, "repo-a");
  const repoB = path.join(base, "My Code", "repo-b"); // spaced path too
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });

  const encode = (p) => p.replace(/[\/\\:.\s]/g, "-");
  function writeClaudeSession(repoRoot, sessionId) {
    let real = repoRoot;
    try { real = fs.realpathSync(repoRoot); } catch {}
    for (const enc of new Set([encode(repoRoot), encode(real)])) {
      const dir = path.join(claudeHome, "projects", enc);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), [
        JSON.stringify({ type: "summary", summary: "work", cwd: real }),
        JSON.stringify({ type: "user", cwd: real, message: { role: "user", content: "go" }, timestamp: "2026-06-12T10:00:00Z" }),
        JSON.stringify({ type: "assistant", cwd: real, message: { role: "assistant", usage: { input_tokens: 300000, output_tokens: 40000 }, content: [{ type: "text", text: "reading src/a.ts ".repeat(40) }] }, timestamp: "2026-06-12T10:01:00Z" }),
      ].join("\n"), "utf8");
    }
  }
  writeClaudeSession(repoA, "sess-a");
  writeClaudeSession(repoB, "sess-b");

  const env = {
    PRISMO_HOME: prismoHome,
    PRISMO_CLAUDE_HOME: claudeHome,
    PRISMO_CODEX_HOME: path.join(base, "none"),
    PRISMO_CURSOR_HOME: path.join(base, "none"),
    PRISMO_CURSOR_APP_SUPPORT: path.join(base, "none"),
  };
  // Run from repoA but request all repos: must capture repoB's session too.
  const res = runPrismo(["sync", "--dry-run", "--json", "--all-repos"], { env, cwd: repoA });
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout).payload;
  const repos = new Set((payload.sessions || []).map((s) => s.repo && s.repo.pathBasename).filter(Boolean));
  assert.ok(repos.has("repo-a"), `expected repo-a, got ${[...repos]}`);
  assert.ok(repos.has("repo-b"), `expected repo-b attributed to its own repo, got ${[...repos]}`);
});

test("sessions and report render local usage from session logs", () => {
  const base = tempDir();
  const prismoHome = tempDir();
  const codexHome = tempDir();
  const root = path.join(base, "app");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "18.0.0" } }), "utf8");
  const sessionDir = path.join(codexHome, "sessions", "2026", "06", "12");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "s.jsonl"), [
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-12T10:00:00Z", payload: { type: "session_meta", id: "s", cwd: root, model: "gpt-test" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-12T10:01:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 300000, output_tokens: 80000, total_tokens: 380000 } } } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-12T10:02:00Z", payload: { type: "tool_result", content: "ERROR build failed\nnpm test\nnpm test\nnpm test\nnpm test\n".repeat(1500) } }),
  ].join("\n"), "utf8");

  const env = {
    PRISMO_HOME: prismoHome,
    PRISMO_CODEX_HOME: codexHome,
    PRISMO_CLAUDE_HOME: path.join(base, "none"),
    PRISMO_CURSOR_HOME: path.join(base, "none"),
    PRISMO_CURSOR_APP_SUPPORT: path.join(base, "none"),
  };

  const sessions = runPrismo(["sessions", "--json"], { env, cwd: root });
  assert.equal(sessions.status, 0, sessions.stderr);
  const sv = JSON.parse(sessions.stdout);
  assert.equal(sv.command, "sessions");
  assert.ok(sv.totals.sessions >= 1);
  assert.ok(sv.sessions.some((s) => s.tool === "codex"));

  const report = runPrismo(["report", "--json"], { env, cwd: root });
  assert.equal(report.status, 0, report.stderr);
  const rv = JSON.parse(report.stdout);
  assert.equal(rv.command, "report");
  assert.ok(rv.observedTokens > 0);
  assert.ok(typeof rv.nextAction === "string" && rv.nextAction.length > 0);
});
