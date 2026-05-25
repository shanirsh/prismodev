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

test("usage command reads exact Codex token_count events from local JSONL", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "08");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "real.js"), "export const real = true;\n", "utf8");
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

test("cc command reports Claude Code token costs and cache savings", () => {
  const root = tempRepo();
  const claudeHome = tempRepo();
  const safeProject = root.replace(/[\/\\:]/g, "-").replace(/^-/, "-");
  const projectDir = path.join(claudeHome, "projects", safeProject);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "claude-cost.jsonl"), [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-05-08T10:01:00Z",
      requestId: "req-1",
      message: {
        id: "msg-1",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        usage: {
          input_tokens: 50000,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 100000,
          output_tokens: 10000,
        },
        content: [{ type: "text", text: "done" }],
      },
    }),
  ].join("\n"), "utf8");

  const env = { ...process.env, PRISMO_CLAUDE_HOME: claudeHome, PRISMO_CODEX_HOME: path.join(root, "none") };
  const json = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "cc", "--json", root],
    { encoding: "utf8", env }
  );
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.sessions[0].cost.model, "Claude Sonnet 4");
  assert.equal(payload.totals.inputTokens, 50000);
  assert.equal(payload.totals.outputTokens, 10000);
  assert.equal(payload.totals.cacheCreationTokens, 5000);
  assert.equal(payload.totals.cacheReadTokens, 100000);
  assert.equal(Number(payload.totals.totalCost.toFixed(4)), 0.3488);
  assert.ok(payload.totals.cacheSavings > 0);
  assert.ok(payload.insights.estimatedAvoidableCost > 0);
  assert.ok(payload.insights.costDrivers.length > 0);
  assert.ok(payload.sessions[0].prismo.recommendations.some((rec) => rec.includes("optimize") || rec.includes("scan --usage")));

  const terminal = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "cc", "last", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.ok(terminal.stdout.includes("Prismo Claude Code Cost"));
  assert.ok(terminal.stdout.includes("Claude Sonnet 4"));
  assert.ok(terminal.stdout.includes("Cache saved you"));
  assert.ok(terminal.stdout.includes("Prismo Diagnosis"));
  assert.ok(terminal.stdout.includes("Better Next Actions"));

  const timeline = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "cc", "timeline", "--json", root],
    { encoding: "utf8", env }
  );
  assert.equal(timeline.status, 0, timeline.stderr);
  const timelinePayload = JSON.parse(timeline.stdout);
  assert.equal(timelinePayload.schemaVersion, 1);
  assert.equal(timelinePayload.command, "cc timeline");
  assert.equal(timelinePayload.session.model, "claude-sonnet-4-20250514");
  assert.ok(Array.isArray(timelinePayload.timeline));
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
      payload: { type: "tool_result", content: (`failure in package-lock.json and dist/app.js after npm test\nsrc/real.js stayed relevant\n/Users/someone/other-repo/lib/noise.js should not count\nM /Users/someone/other-repo/lib/status-noise.js should not count\nmissing/local-file.js should not count\n`).repeat(30000) },
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

  const allUsage = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "usage", "all", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(allUsage.status, 0, allUsage.stderr);
  const allUsagePayload = JSON.parse(allUsage.stdout);
  assert.equal(allUsagePayload.scannedPath, root);
  assert.equal(allUsagePayload.sessions[0].tool, "codex");
  assert.equal(allUsagePayload.sessions[0].cwd, root);

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
  assert.ok(["Medium", "High"].includes(payload.live.contextPressure));
  assert.ok(payload.live.warnings.some((warning) => warning.includes("Tool/output")));
  assert.ok(payload.live.warnings.some((warning) => warning.includes("package-lock.json")));
  assert.equal(payload.live.liveAction.cause, "tool-output-flood");
  assert.ok(payload.live.liveAction.now.length >= 2);
  assert.ok(payload.live.liveAction.rescueCommand.includes("watch --rescue"));
  assert.equal(payload.live.liveAction.shieldPlan.mcp.runTool, "prismo_shield_run");
  assert.equal(payload.live.liveAction.shieldPlan.mcp.searchTool, "prismo_shield_search");
  assert.ok(payload.live.liveAction.shieldPlan.command.includes("npx getprismo shield --"));
  assert.equal(payload.live.activeSession.actionableRepeatedPaths.some((item) => item.value.includes("other-repo")), false);
  assert.equal(payload.live.activeSession.actionableRepeatedPaths.some((item) => item.value.includes("missing/local-file.js")), false);
  assert.ok(payload.live.recommendedAction.includes("shield"));

  const watchTerminal = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(watchTerminal.status, 0, watchTerminal.stderr);
  assert.ok(watchTerminal.stdout.includes("Context Pressure"));
  assert.ok(watchTerminal.stdout.includes("Recent Growth"));
  assert.ok(watchTerminal.stdout.includes("Warnings"));
  assert.ok(watchTerminal.stdout.includes("Do This Now"));
  assert.ok(watchTerminal.stdout.includes("Shield Plan"));
  assert.ok(watchTerminal.stdout.includes("prismo_shield_run"));
  assert.ok(watchTerminal.stdout.includes("Cause:"));
  assert.ok(watchTerminal.stdout.includes("Suggested Action"));
  assert.equal(watchTerminal.stdout.includes("Refreshing every"), false);

  const rescue = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--rescue", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(rescue.status, 0, rescue.stderr);
  assert.ok(rescue.stdout.includes("Prismo Rescue Prompt"));
  assert.ok(rescue.stdout.includes("Paste this into the current AI coding session"));
  assert.ok(rescue.stdout.includes("Prismo shield"));
  assert.ok(rescue.stdout.includes("package-lock.json"));

  const rescueJson = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--rescue", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(rescueJson.status, 0, rescueJson.stderr);
  const rescuePayload = JSON.parse(rescueJson.stdout);
  assert.ok(rescuePayload.rescuePrompt.includes("Prismo Rescue Prompt"));

  const guardrails = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--guardrails", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(guardrails.status, 0, guardrails.stderr);
  const guardrailsPayload = JSON.parse(guardrails.stdout);
  assert.equal(guardrailsPayload.guardrailsPath, ".prismo/live-guardrails.md");
  assert.equal(guardrailsPayload.rescuePath, ".prismo/live-rescue-prompt.md");
  const guardrailsText = fs.readFileSync(path.join(root, ".prismo", "live-guardrails.md"), "utf8");
  const liveRescueText = fs.readFileSync(path.join(root, ".prismo", "live-rescue-prompt.md"), "utf8");
  assert.ok(guardrailsText.includes("Prismo Live Guardrails"));
  assert.ok(guardrailsText.includes("Effective Immediately"));
  assert.ok(guardrailsText.includes("Prismo shield"));
  assert.ok(liveRescueText.includes("Prismo Rescue Prompt"));

  const throttle = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--throttle", "--budget", "1", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(throttle.status, 0, throttle.stderr);
  const throttlePayload = JSON.parse(throttle.stdout);
  assert.equal(throttlePayload.throttlePath, ".prismo/live-context-throttle.md");
  assert.equal(throttlePayload.live.liveAction.cause, "token-budget-exceeded");
  assert.equal(throttlePayload.live.budget.budget, 1);
  const throttleText = fs.readFileSync(path.join(root, ".prismo", "live-context-throttle.md"), "utf8");
  assert.ok(throttleText.includes("Prismo Live Context Throttle"));
  assert.ok(throttleText.includes("hard-throttle"));

  const auto = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--auto", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(auto.status, 0, auto.stderr);
  const autoPayload = JSON.parse(auto.stdout);
  assert.equal(autoPayload.auto, true);
  assert.equal(autoPayload.guardrailsPath, ".prismo/live-guardrails.md");
  assert.equal(autoPayload.rescuePath, ".prismo/live-rescue-prompt.md");
  assert.equal(autoPayload.throttlePath, ".prismo/live-context-throttle.md");
  assert.equal(autoPayload.eventsPath, ".prismo/watch-events.jsonl");
  assert.equal(autoPayload.live.budget.budget, 600000);
  const eventsPath = path.join(root, ".prismo", "watch-events.jsonl");
  assert.ok(fs.existsSync(eventsPath));
  const watchEvent = JSON.parse(fs.readFileSync(eventsPath, "utf8").trim().split(/\r?\n/)[0]);
  assert.equal(watchEvent.schemaVersion, 1);
  assert.equal(watchEvent.cause, autoPayload.live.liveAction.cause);
  assert.equal(watchEvent.shieldPlan.mcp.runTool, "prismo_shield_run");
  assert.equal(autoPayload.firewallPath, ".prismo/context-firewall.md");
  assert.ok(fs.existsSync(path.join(root, ".prismo", "context-firewall.md")));

  fs.rmSync(path.join(root, ".prismo", "watch-events.jsonl"));
  const noEvents = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--auto", "--no-events", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(noEvents.status, 0, noEvents.stderr);
  const noEventsPayload = JSON.parse(noEvents.stdout);
  assert.equal(noEventsPayload.eventsPath, null);
  assert.equal(fs.existsSync(path.join(root, ".prismo", "watch-events.jsonl")), false);

  const watchReport = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--report", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(watchReport.status, 0, watchReport.stderr);
  assert.ok(fs.existsSync(path.join(root, ".prismo", "watch-report.md")));
  assert.ok(fs.readFileSync(path.join(root, ".prismo", "watch-report.md"), "utf8").includes("Prismo Watch Report"));
});

test("watch --agents shows multi-agent coordination risks", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "25");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "shared.js"), "export const shared = true;\n", "utf8");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}", "utf8");

  const noisyOutput = [
    "ERROR: auth failed",
    "package-lock.json",
  ].join("\n").repeat(25000);
  const makeSession = (id, minute) => [
    JSON.stringify({ type: "event_msg", timestamp: `2026-05-25T10:${minute}:00Z`, payload: { type: "session_meta", id, cwd: root, model: "gpt-test" } }),
    ...Array.from({ length: 4 }, (_, index) => JSON.stringify({
      type: "event_msg",
      timestamp: `2026-05-25T10:${minute}:0${index + 1}Z`,
      payload: { type: "tool_result", content: `src/shared.js\n${noisyOutput}` },
    })),
  ].join("\n");
  fs.writeFileSync(path.join(sessionDir, "agent-one.jsonl"), makeSession("agent-one", "01"), "utf8");
  fs.writeFileSync(path.join(sessionDir, "agent-two.jsonl"), makeSession("agent-two", "03"), "utf8");

  const env = { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none") };
  const json = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--agents", "--once", "--json", "--limit", "2", root],
    { encoding: "utf8", env }
  );
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.multiAgent.enabled, true);
  assert.equal(payload.multiAgent.agentCount, 2);
  assert.ok(payload.multiAgent.coordinationWarnings.some((warning) => warning.includes("src/shared.js")));
  assert.ok(payload.multiAgent.sharedFiles.some((item) => item.path === "src/shared.js"));
  assert.ok(payload.multiAgent.sharedArtifacts.some((item) => item.type === "lockfiles"));
  assert.ok(payload.multiAgent.recommendedActions.some((action) => action.includes("shield")));

  const usage = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "usage", "codex", "--json", "--limit", "2", root],
    { encoding: "utf8", env }
  );
  assert.equal(usage.status, 0, usage.stderr);
  const usagePayload = JSON.parse(usage.stdout);
  assert.equal(usagePayload.multiAgent.enabled, true);
  assert.equal(usagePayload.multiAgent.agentCount, 2);

  const scan = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--usage", "--json", "--no-report", "--limit", "2", root],
    { encoding: "utf8", env }
  );
  assert.equal(scan.status, 0, scan.stderr);
  const scanPayload = JSON.parse(scan.stdout);
  assert.equal(scanPayload.realUsage.multiAgent.enabled, true);
  assert.equal(scanPayload.realUsage.multiAgent.agentCount, 2);

  const doctor = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "doctor", "--json", "--dry-run", "--limit", "2", root],
    { encoding: "utf8", env }
  );
  assert.equal(doctor.status, 0, doctor.stderr);
  const doctorPayload = JSON.parse(doctor.stdout);
  assert.equal(doctorPayload.before.realUsage.multiAgent.enabled, true);
  assert.equal(doctorPayload.before.realUsage.multiAgent.agentCount, 2);

  const terminal = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--agents", "--once", "--limit", "2", root],
    { encoding: "utf8", env }
  );
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.ok(terminal.stdout.includes("Prismo Multi-Agent Watch"));
  assert.ok(terminal.stdout.includes("Active Agents"));
  assert.ok(terminal.stdout.includes("Coordination Warnings"));
  assert.ok(terminal.stdout.includes("Shared Repeated Files"));
  assert.ok(terminal.stdout.includes("src/shared.js"));
});
