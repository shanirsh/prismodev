const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const createEnforce = require("../lib/prismo-dev/enforce");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prismo-enforce-"));
}

function enforceWith(overrides = {}) {
  return createEnforce({
    fs,
    path,
    NPX_COMMAND: "npx -y getprismo@latest",
    runFirewall: null,
    ...overrides,
  });
}

function writeBlocked(root, lines) {
  fs.mkdirSync(path.join(root, ".prismo"), { recursive: true });
  fs.writeFileSync(path.join(root, ".prismo", "blocked-context.txt"), ["# Blocked Context", "", ...lines].join("\n"), "utf8");
}

function readEvent(root, toolName, toolInput, sessionId = "session-1") {
  return JSON.stringify({
    session_id: sessionId,
    cwd: root,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
  });
}

test("denies reads into blocked context with a context-pack pointer", () => {
  const root = tempDir();
  writeBlocked(root, ["node_modules/**", "logs/**", "*.log"]);
  const enforce = enforceWith();

  const denied = enforce.decidePreToolUse(root, readEvent(root, "Read", { file_path: path.join(root, "logs", "debug-output.json") }));
  assert.ok(denied);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /blocked context/);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /context packs/);

  const deniedExt = enforce.decidePreToolUse(root, readEvent(root, "Grep", { path: path.join(root, "server.log") }));
  assert.ok(deniedExt);

  const deniedNested = enforce.decidePreToolUse(root, readEvent(root, "Read", { file_path: path.join(root, "packages", "api", "node_modules", "x", "index.js") }));
  assert.ok(deniedNested);
});

test("allows reads of normal source files", () => {
  const root = tempDir();
  writeBlocked(root, ["node_modules/**", "dist/**"]);
  const enforce = enforceWith();

  assert.equal(enforce.decidePreToolUse(root, readEvent(root, "Read", { file_path: path.join(root, "src", "index.ts") })), null);
  assert.equal(enforce.decidePreToolUse(root, readEvent(root, "Glob", { pattern: "**/*.ts" })), null);
});

test("allows everything when no blocked-context policy exists", () => {
  const root = tempDir();
  const enforce = enforceWith();

  assert.equal(enforce.decidePreToolUse(root, readEvent(root, "Read", { file_path: path.join(root, "node_modules", "x.js") })), null);
});

test("denies the fourth identical bash command in a session", () => {
  const root = tempDir();
  const enforce = enforceWith();
  const event = () => readEvent(root, "Bash", { command: "npm   test" });

  assert.equal(enforce.decidePreToolUse(root, event()), null);
  assert.equal(enforce.decidePreToolUse(root, event()), null);
  assert.equal(enforce.decidePreToolUse(root, event()), null);
  const denied = enforce.decidePreToolUse(root, event());
  assert.ok(denied);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /already run 3 times/);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /shield -- npm test/);

  // A different command and a different session are unaffected.
  assert.equal(enforce.decidePreToolUse(root, readEvent(root, "Bash", { command: "npm run build" })), null);
  assert.equal(enforce.decidePreToolUse(root, readEvent(root, "Bash", { command: "npm test" }, "session-2")), null);
});

test("a command that ever succeeded is never loop-blocked", () => {
  const root = tempDir();
  const enforce = enforceWith();
  const pre = () => readEvent(root, "Bash", { command: "npm test" });
  const post = (failed) => JSON.stringify({
    session_id: "session-1",
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { exit_code: failed ? 1 : 0 },
  });

  // First run succeeds; many later runs of the same command stay allowed.
  assert.equal(enforce.decidePreToolUse(root, pre()), null);
  enforce.decidePostToolUse(root, post(false));
  for (let i = 0; i < 6; i += 1) {
    assert.equal(enforce.decidePreToolUse(root, pre()), null);
    enforce.decidePostToolUse(root, post(true));
  }
});

test("three recorded failures block the next attempt", () => {
  const root = tempDir();
  const enforce = enforceWith();
  const pre = () => readEvent(root, "Bash", { command: "pytest -q" });
  const post = () => JSON.stringify({
    session_id: "session-1",
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "pytest -q" },
    tool_response: { exit_code: 2 },
  });

  for (let i = 0; i < 3; i += 1) {
    assert.equal(enforce.decidePreToolUse(root, pre()), null);
    enforce.decidePostToolUse(root, post());
  }
  const denied = enforce.decidePreToolUse(root, pre());
  assert.ok(denied);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /failed 3 times/);
  const state = JSON.parse(fs.readFileSync(path.join(root, ".prismo", "enforce-state.json"), "utf8"));
  assert.equal(state.loopStops.length, 1);
  assert.equal(state.loopStops[0].tool, "claude-code");
  assert.equal(state.loopStops[0].reason, "repeated-failing-command");
  assert.equal(state.loopStops[0].failures, 3);
  // pytest is a noisy command, so a blocked retry saves the higher estimate.
  assert.equal(state.loopStops[0].estimatedTokensSaved, 12000);
});

test("loop-stop token estimate scales with command noisiness", () => {
  const root = tempDir();
  const enforce = enforceWith();
  const quiet = () => readEvent(root, "Bash", { command: "git log" });
  for (let i = 0; i < 4; i += 1) enforce.decidePreToolUse(root, quiet());
  const noisy = () => readEvent(root, "Bash", { command: "npm run build" }, "session-2");
  for (let i = 0; i < 4; i += 1) enforce.decidePreToolUse(root, noisy());

  const state = JSON.parse(fs.readFileSync(path.join(root, ".prismo", "enforce-state.json"), "utf8"));
  const byCmd = Object.fromEntries(state.loopStops.map((s) => [s.command, s.estimatedTokensSaved]));
  assert.equal(byCmd["git log"], 2000);
  assert.equal(byCmd["npm run build"], 12000);
});

test("unknown response shapes record nothing and keep the attempt fallback", () => {
  const root = tempDir();
  const enforce = enforceWith();
  enforce.decidePostToolUse(root, JSON.stringify({
    session_id: "session-1",
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { someUnknownField: true },
  }));
  const pre = () => readEvent(root, "Bash", { command: "npm test" });

  assert.equal(enforce.decidePreToolUse(root, pre()), null);
  assert.equal(enforce.decidePreToolUse(root, pre()), null);
  assert.equal(enforce.decidePreToolUse(root, pre()), null);
  assert.ok(enforce.decidePreToolUse(root, pre()));
});

test("denials are counted with estimated tokens kept out", () => {
  const root = tempDir();
  writeBlocked(root, ["logs/**"]);
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, "logs", "big.log"), "x".repeat(40_000), "utf8");
  const enforce = enforceWith();

  enforce.decidePreToolUse(root, readEvent(root, "Read", { file_path: path.join(root, "logs", "big.log") }));
  const pre = () => readEvent(root, "Bash", { command: "npm run flaky" });
  for (let i = 0; i < 4; i += 1) enforce.decidePreToolUse(root, pre());

  const status = enforce.runEnforceStatus(root);
  assert.equal(status.denials.total, 2);
  assert.equal(status.denials.blockedContext, 1);
  assert.equal(status.denials.loops, 1);
  // 40kB file ≈ 10k tokens + 2k loop estimate.
  assert.equal(status.denials.estimatedTokensSaved, 12_000);
  const state = JSON.parse(fs.readFileSync(path.join(root, ".prismo", "enforce-state.json"), "utf8"));
  assert.equal(state.contextBlocks.length, 1);
  assert.equal(state.contextBlocks[0].target, "logs/big.log");
  assert.equal(state.contextBlocks[0].rule, "logs/**");
  assert.equal(state.contextBlocks[0].estimatedTokensSaved, 10_000);
  const rendered = enforce.renderEnforceTerminal(status);
  assert.match(rendered, /tokens kept out of context/);
});

test("fails open on malformed events", () => {
  const enforce = enforceWith();
  assert.equal(enforce.decidePreToolUse(tempDir(), "not json"), null);
  assert.equal(enforce.decidePreToolUse(tempDir(), JSON.stringify({ tool_name: "Read" })), null);
  assert.equal(enforce.decidePreToolUse(tempDir(), JSON.stringify(null)), null);
});

test("install adds the hook once, backs up settings, and is idempotent", () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }), "utf8");
  const enforce = enforceWith();

  const first = enforce.runEnforceInstall(root);
  assert.equal(first.installed, true);
  const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.permissions.allow[0], "Bash(npm test)");
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /hook pretooluse/);
  assert.ok(fs.existsSync(path.join(root, ".claude", "settings.json.prismo-backup")));

  const second = enforce.runEnforceInstall(root);
  const after = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
  assert.equal(after.hooks.PreToolUse.length, 1);
  assert.ok(second.actions.some((a) => a.includes("already installed")));
});

test("install generates the firewall policy when missing", () => {
  const root = tempDir();
  let firewallRan = false;
  const enforce = enforceWith({
    runFirewall: (dir, options) => {
      firewallRan = true;
      writeBlocked(root, ["dist/**"]);
      return { task: options.task, generatedFiles: [] };
    },
  });

  const result = enforce.runEnforceInstall(root);

  assert.equal(firewallRan, true);
  assert.equal(result.blockedRules, 1);
});

test("uninstall removes only the prismo hook; status reports state", () => {
  const root = tempDir();
  const enforce = enforceWith();
  enforce.runEnforceInstall(root);
  // Add a non-prismo hook alongside.
  const filePath = path.join(root, ".claude", "settings.json");
  const settings = JSON.parse(fs.readFileSync(filePath, "utf8"));
  settings.hooks.PreToolUse.push({ matcher: "Write", hooks: [{ type: "command", command: "./scripts/lint.sh" }] });
  fs.writeFileSync(filePath, JSON.stringify(settings), "utf8");

  assert.equal(enforce.runEnforceStatus(root).installed, true);
  const result = enforce.runEnforceUninstall(root);
  assert.equal(result.installed, false);
  const after = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(after.hooks.PreToolUse.length, 1);
  assert.equal(after.hooks.PreToolUse[0].hooks[0].command, "./scripts/lint.sh");
  assert.equal(enforce.runEnforceStatus(root).installed, false);
});
