const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const createRepairExecutors = require("../lib/prismo-dev/repair-executors");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prismo-repair-"));
}

function sessionFixture(overrides = {}) {
  return {
    tool: "claude-code",
    repeatedPathMentions: [],
    generatedArtifacts: [],
    repeatedCommands: [],
    loopSuspicion: false,
    contextRisk: "Low",
    ...overrides,
  };
}

function executorsWith(overrides = {}) {
  return createRepairExecutors({
    fs,
    path,
    NPX_COMMAND: "npx -y getprismo@latest",
    runDoctor: () => ({
      after: { score: 88 },
      fixActions: ["Updated .claudeignore: +dist"],
      generatedFiles: [".prismo/architecture-summary.md"],
      contextFile: ".prismo/architecture-summary.md",
    }),
    runOptimize: () => ({
      scope: null,
      generatedFiles: [".prismo/architecture-summary.md"],
      starterPrompt: "Start from .prismo/architecture-summary.md.",
    }),
    runGuard: async () => ({ guardRunning: false, events: [] }),
    runShield: () => ({ exitCode: 0, summary: "ok", runDir: ".prismo/shield/runs/1" }),
    getUsageSummary: () => ({ sessions: [] }),
    appendIgnoreSuggestions: () => [],
    ...overrides,
  });
}

test("forCause resolves every repair cause and rejects unknown ones", () => {
  const executors = executorsWith();

  for (const cause of executors.REPAIR_CAUSES) {
    assert.equal(typeof executors.forCause(cause), "function");
  }
  assert.equal(executors.forCause("doctor"), null);
  assert.equal(executors.forCause(null), null);
  assert.equal(typeof executors.forCause(" Repeated-File-Reads "), "function");
});

test("repeated-file-reads maps hot files and refreshes context packs", async () => {
  const root = tempDir();
  const doctorCalls = [];
  const executors = executorsWith({
    runDoctor: (dir, options) => {
      doctorCalls.push({ dir, options });
      return {
        after: { score: 90 },
        fixActions: ["Updated .claudeignore: +dist"],
        generatedFiles: [".prismo/architecture-summary.md"],
        contextFile: ".prismo/architecture-summary.md",
      };
    },
    getUsageSummary: () => ({
      sessions: [
        sessionFixture({ repeatedPathMentions: [{ value: "src/db/schema.ts", count: 6 }, { value: "README.md", count: 5 }] }),
        sessionFixture({ repeatedPathMentions: [{ value: "src/db/schema.ts", count: 4 }] }),
      ],
    }),
  });

  const report = await executors.runRepair(root, "repeated-file-reads");

  assert.equal(report.status, "completed");
  assert.equal(report.result.targetCause, "repeated-file-reads");
  assert.equal(doctorCalls.length, 1);
  assert.equal(doctorCalls[0].options.applySuggestions, true);
  assert.deepEqual(report.result.hotPaths, [{ value: "src/db/schema.ts", count: 10 }]);
  assert.equal(report.result.score, 90);
  const guide = fs.readFileSync(path.join(root, ".prismo", "hot-files.md"), "utf8");
  assert.ok(guide.includes("src/db/schema.ts (10 reads)"));
  assert.ok(!guide.includes("README.md (5 reads)"));
});

test("tool-output-flood runs a safe command shielded and stages noisy commands", async () => {
  const root = tempDir();
  const shieldCalls = [];
  const executors = executorsWith({
    runShield: (dir, args) => {
      shieldCalls.push(args);
      return { exitCode: 1, summary: "2 tests failed", runDir: ".prismo/shield/runs/7" };
    },
    getUsageSummary: () => ({
      sessions: [sessionFixture({ repeatedCommands: [{ value: "npm test", count: 5 }] })],
    }),
  });

  const report = await executors.runRepair(root, "tool-output-flood", { commandArgs: ["npm", "test"] });

  assert.equal(report.status, "completed");
  assert.deepEqual(shieldCalls, [["npm", "test"]]);
  assert.equal(report.result.shieldedRun.exitCode, 1);
  assert.deepEqual(report.result.noisyCommands, [{ value: "npm test", count: 5 }]);
  const guide = fs.readFileSync(path.join(root, ".prismo", "noisy-commands.md"), "utf8");
  assert.ok(guide.includes("shield -- npm test"));
  assert.ok(guide.includes("Exit code: 1"));
});

test("tool-output-flood refuses unsafe commands but still stages guidance", async () => {
  const root = tempDir();
  let shieldCalled = false;
  const executors = executorsWith({
    runShield: () => { shieldCalled = true; return { exitCode: 0 }; },
  });

  const report = await executors.runRepair(root, "tool-output-flood", { commandArgs: ["rm", "-rf", "."] });

  assert.equal(report.status, "completed");
  assert.equal(shieldCalled, false);
  assert.equal(report.result.shieldedRun, null);
  assert.ok(fs.existsSync(path.join(root, ".prismo", "noisy-commands.md")));
});

test("generated-artifacts appends ignore rules for session-observed artifacts", async () => {
  const root = tempDir();
  const appended = [];
  const executors = executorsWith({
    appendIgnoreSuggestions: (result) => {
      appended.push(result);
      return ["Updated .claudeignore: +coverage/lcov.info"];
    },
    getUsageSummary: () => ({
      sessions: [sessionFixture({
        generatedArtifacts: [
          { value: "coverage/lcov.info", count: 3 },
          { value: "/etc/passwd", count: 2 },
          { value: "../outside.log", count: 2 },
        ],
      })],
    }),
  });

  const report = await executors.runRepair(root, "generated-artifacts");

  assert.equal(report.status, "completed");
  assert.equal(report.result.targetCause, "generated-artifacts");
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0].missingClaudeIgnoreSuggestions, ["coverage/lcov.info"]);
  assert.ok(report.result.fixActions.includes("Updated .claudeignore: +coverage/lcov.info"));
});

test("context-loop tightens guard and writes loop-breaker rules", async () => {
  const root = tempDir();
  const guardCalls = [];
  const executors = executorsWith({
    runGuard: async (dir, options) => {
      guardCalls.push(options);
      return { guardRunning: false, events: [{ cause: "context-loop" }] };
    },
    getUsageSummary: () => ({
      sessions: [
        sessionFixture({ loopSuspicion: true, repeatedCommands: [{ value: "pytest -q", count: 7 }] }),
        sessionFixture(),
      ],
    }),
  });

  const report = await executors.runRepair(root, "context-loop");

  assert.equal(report.status, "completed");
  assert.equal(guardCalls.length, 1);
  assert.equal(guardCalls[0].tokenBudget, 400000);
  assert.equal(report.result.loopSessions, 1);
  assert.equal(report.result.guardEvents, 1);
  const guide = fs.readFileSync(path.join(root, ".prismo", "loop-breaker.md"), "utf8");
  assert.ok(guide.includes("pytest -q"));
  assert.ok(guide.includes("1 recent session(s) showed loop behavior"));
});

test("long-session-buildup generates scoped packs and a restart routine", async () => {
  const root = tempDir();
  const optimizeCalls = [];
  const executors = executorsWith({
    runOptimize: (dir, options) => {
      optimizeCalls.push(options);
      return {
        scope: "frontend",
        generatedFiles: [".prismo/frontend-summary.md"],
        starterPrompt: "Start from .prismo/frontend-summary.md.",
      };
    },
    getUsageSummary: () => ({
      sessions: [sessionFixture({ contextRisk: "High" }), sessionFixture({ contextRisk: "Medium" })],
    }),
  });

  const report = await executors.runRepair(root, "long-session-buildup", { scope: "frontend" });

  assert.equal(report.status, "completed");
  assert.deepEqual(optimizeCalls, [{ scope: "frontend" }]);
  assert.equal(report.result.heavySessions, 2);
  assert.equal(report.result.scope, "frontend");
  const guide = fs.readFileSync(path.join(root, ".prismo", "session-restart.md"), "utf8");
  assert.ok(guide.includes("2 recent session(s) carried High/Medium context risk"));
  assert.ok(guide.includes("Start from .prismo/frontend-summary.md."));
});

test("aggressive tier adds a context firewall policy and tightens guard budget", async () => {
  const root = tempDir();
  const firewallCalls = [];
  const guardCalls = [];
  const executors = executorsWith({
    runFirewall: (dir, options) => {
      firewallCalls.push(options);
      return { generatedFiles: [".prismo/context-firewall.md", ".prismo/blocked-context.txt"] };
    },
    runGuard: async (dir, options) => {
      guardCalls.push(options);
      return { events: [] };
    },
  });

  const report = await executors.runRepair(root, "context-loop", { tier: "aggressive" });

  assert.equal(report.status, "completed");
  assert.equal(report.result.tier, "aggressive");
  assert.deepEqual(firewallCalls, [{ task: "context-loop", dryRun: false }]);
  assert.equal(guardCalls[0].tokenBudget, 250000);
  assert.ok(report.result.generatedFiles.includes(".prismo/context-firewall.md"));
  assert.match(report.statusMessage, /Aggressive tier/);
});

test("mild tier does not touch the firewall", async () => {
  const root = tempDir();
  let firewallCalled = false;
  const executors = executorsWith({
    runFirewall: () => { firewallCalled = true; return { generatedFiles: [] }; },
  });

  const report = await executors.runRepair(root, "repeated-file-reads");

  assert.equal(report.status, "completed");
  assert.equal(report.result.tier, "mild");
  assert.equal(firewallCalled, false);
});

test("runRepair fails cleanly on unknown cause", async () => {
  const executors = executorsWith();

  const report = await executors.runRepair(tempDir(), "made-up-cause");

  assert.equal(report.status, "failed");
  assert.match(report.statusMessage, /Unknown repair cause/);
  assert.equal(report.result, null);
});

test("executors survive a usage-summary failure", async () => {
  const root = tempDir();
  const executors = executorsWith({
    getUsageSummary: () => { throw new Error("no local logs"); },
  });

  const report = await executors.runRepair(root, "repeated-file-reads");

  assert.equal(report.status, "completed");
  assert.deepEqual(report.result.hotPaths, []);
});

test("executor parses scope and shield args from a workspace action command", async () => {
  const root = tempDir();
  const optimizeCalls = [];
  const shieldCalls = [];
  const executors = executorsWith({
    runOptimize: (dir, options) => {
      optimizeCalls.push(options);
      return { scope: options.scope, generatedFiles: [], starterPrompt: null };
    },
    runShield: (dir, args) => {
      shieldCalls.push(args);
      return { exitCode: 0, summary: "ok", runDir: ".prismo/shield/runs/2" };
    },
  });

  const buildupExecutor = executors.forCause("long-session-buildup");
  await buildupExecutor({ command: "npx -y getprismo@latest context frontend", targetCause: "long-session-buildup" }, root, {
    parsed: { command: "context", args: ["frontend"] },
    options: {},
  });
  assert.deepEqual(optimizeCalls, [{ scope: "frontend" }]);

  const floodExecutor = executors.forCause("tool-output-flood");
  await floodExecutor({ command: "npx -y getprismo@latest shield -- npm test", targetCause: "tool-output-flood" }, root, { options: {} });
  assert.deepEqual(shieldCalls, [["npm", "test"]]);
});

test("renderRepairTerminal shows cause, fixes, and generated files", () => {
  const executors = executorsWith();

  const output = executors.renderRepairTerminal({
    cause: "generated-artifacts",
    status: "completed",
    statusMessage: "Repaired generated artifacts.",
    result: {
      artifacts: [{ value: "coverage/lcov.info", count: 3 }],
      fixActions: ["Updated .claudeignore: +coverage/lcov.info"],
      generatedFiles: [".prismo/optimize-report.md"],
    },
  });

  assert.ok(output.includes("Cause: generated-artifacts"));
  assert.ok(output.includes("coverage/lcov.info (3 mentions)"));
  assert.ok(output.includes("Updated .claudeignore: +coverage/lcov.info"));
  assert.ok(output.includes(".prismo/optimize-report.md"));
});
