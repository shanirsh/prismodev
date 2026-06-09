const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const createRepairPlanner = require("../lib/prismo-dev/repair-planner");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prismo-planner-"));
}

const HOUR = 60 * 60 * 1000;

// Sessions are stubbed as {updatedAt, tokens, wasted, cause}; estimateWaste
// maps them straight through so tests control waste attribution exactly.
function session(agoMs, tokens, wasted, cause) {
  return {
    updatedAt: new Date(Date.now() - agoMs).toISOString(),
    tokens,
    wasted,
    cause,
  };
}

function plannerWith(sessions, overrides = {}) {
  const executorCalls = [];
  const planner = createRepairPlanner({
    fs,
    path,
    NPX_COMMAND: "npx -y getprismo@latest",
    getUsageSummary: () => ({ sessions }),
    estimateWaste: (s) => ({ tokens: s.tokens, wastedTokens: s.wasted, topCause: s.cause }),
    repairExecutors: {
      forCause: (cause) => async (action, root, helpers) => {
        executorCalls.push({ cause, tier: helpers.options.tier });
        return {
          status: "completed",
          statusMessage: `repaired ${cause}`,
          result: { targetCause: cause, generatedFiles: [".prismo/hot-files.md"] },
        };
      },
    },
    ...overrides,
  });
  return { planner, executorCalls };
}

function writeState(root, state) {
  fs.mkdirSync(path.join(root, ".prismo"), { recursive: true });
  fs.writeFileSync(path.join(root, ".prismo", "repair-state.json"), JSON.stringify(state), "utf8");
}

test("planner does nothing when waste is below thresholds", () => {
  const { planner } = plannerWith([
    session(1 * HOUR, 100000, 4000, "repeated-file-reads"),
  ]);

  const result = planner.plan(tempDir());

  assert.equal(result.decision, null);
  assert.deepEqual(result.skipped, [{ cause: "repeated-file-reads", reason: "below-threshold" }]);
});

test("planner picks the top waste cause at mild tier on first repair", () => {
  const { planner } = plannerWith([
    session(1 * HOUR, 200000, 60000, "tool-output-flood"),
    session(2 * HOUR, 200000, 30000, "repeated-file-reads"),
  ]);

  const result = planner.plan(tempDir());

  assert.equal(result.decision.cause, "tool-output-flood");
  assert.equal(result.decision.tier, "mild");
  assert.equal(result.decision.previousVerdict, null);
  assert.deepEqual(result.skipped, [{ cause: "repeated-file-reads", reason: "lower-priority" }]);
});

test("runPlannerOnce executes the repair and records state; cooldown blocks repeats", async () => {
  const root = tempDir();
  const { planner, executorCalls } = plannerWith([
    session(1 * HOUR, 200000, 60000, "context-loop"),
  ]);

  const first = await planner.runPlannerOnce(root);
  assert.equal(first.executed, true);
  assert.equal(first.outcome.status, "completed");
  assert.deepEqual(executorCalls, [{ cause: "context-loop", tier: "mild" }]);

  const state = JSON.parse(fs.readFileSync(path.join(root, ".prismo", "repair-state.json"), "utf8"));
  assert.equal(state.causes["context-loop"].lastTier, "mild");
  assert.equal(state.causes["context-loop"].attempts, 1);
  assert.equal(state.history.length, 1);

  const second = await planner.runPlannerOnce(root);
  assert.equal(second.executed, false);
  assert.equal(second.decision, null);
  assert.deepEqual(second.skipped, [{ cause: "context-loop", reason: "cooldown" }]);
  assert.equal(executorCalls.length, 1);
});

test("planner waits for enough post-repair sessions before judging", () => {
  const root = tempDir();
  writeState(root, {
    causes: { "generated-artifacts": { lastRepairAt: new Date(Date.now() - 8 * HOUR).toISOString(), lastTier: "mild", attempts: 1 } },
    history: [],
  });
  const { planner } = plannerWith([
    session(10 * HOUR, 200000, 60000, "generated-artifacts"),
    session(7 * HOUR, 200000, 60000, "generated-artifacts"),
  ]);

  const result = planner.plan(root);

  assert.equal(result.decision, null);
  assert.equal(result.skipped[0].reason, "measuring");
  assert.equal(result.skipped[0].verdict.status, "measuring");
});

test("planner escalates to aggressive when the mild repair changed nothing", () => {
  const root = tempDir();
  writeState(root, {
    causes: { "repeated-file-reads": { lastRepairAt: new Date(Date.now() - 8 * HOUR).toISOString(), lastTier: "mild", attempts: 1 } },
    history: [],
  });
  const { planner } = plannerWith([
    session(10 * HOUR, 200000, 60000, "repeated-file-reads"),
    session(2 * HOUR, 200000, 60000, "repeated-file-reads"),
    session(1 * HOUR, 200000, 60000, "repeated-file-reads"),
  ]);

  const result = planner.plan(root);

  assert.equal(result.decision.cause, "repeated-file-reads");
  assert.equal(result.decision.tier, "aggressive");
  assert.equal(result.decision.previousVerdict, "no-change");
});

test("planner stays mild when the last repair improved the cause", () => {
  const root = tempDir();
  writeState(root, {
    causes: { "tool-output-flood": { lastRepairAt: new Date(Date.now() - 8 * HOUR).toISOString(), lastTier: "mild", attempts: 1 } },
    history: [],
  });
  const { planner } = plannerWith([
    session(10 * HOUR, 200000, 120000, "tool-output-flood"),
    session(2 * HOUR, 200000, 40000, "tool-output-flood"),
    session(1 * HOUR, 200000, 40000, "tool-output-flood"),
  ]);

  const result = planner.plan(root);

  assert.equal(result.decision.cause, "tool-output-flood");
  assert.equal(result.decision.tier, "mild");
  assert.equal(result.decision.previousVerdict, "improved");
});

test("planner holds a cause for review after the aggressive tier also failed", () => {
  const root = tempDir();
  writeState(root, {
    causes: { "context-loop": { lastRepairAt: new Date(Date.now() - 8 * HOUR).toISOString(), lastTier: "aggressive", attempts: 2 } },
    history: [],
  });
  const { planner } = plannerWith([
    session(10 * HOUR, 200000, 60000, "context-loop"),
    session(2 * HOUR, 200000, 60000, "context-loop"),
    session(1 * HOUR, 200000, 60000, "context-loop"),
  ]);

  const result = planner.plan(root);

  assert.equal(result.decision, null);
  assert.equal(result.skipped[0].reason, "needs-review");
});

test("execute=false plans without running the executor", async () => {
  const root = tempDir();
  const { planner, executorCalls } = plannerWith([
    session(1 * HOUR, 200000, 60000, "long-session-buildup"),
  ]);

  const result = await planner.runPlannerOnce(root, { execute: false });

  assert.equal(result.decision.cause, "long-session-buildup");
  assert.equal(result.executed, false);
  assert.equal(result.outcome, null);
  assert.equal(executorCalls.length, 0);
  assert.equal(fs.existsSync(path.join(root, ".prismo", "repair-state.json")), false);
});

test("executor failure is recorded and reported, not thrown", async () => {
  const root = tempDir();
  const { planner } = plannerWith([
    session(1 * HOUR, 200000, 60000, "repeated-file-reads"),
  ], {
    repairExecutors: {
      forCause: () => async () => { throw new Error("disk full"); },
    },
  });

  const result = await planner.runPlannerOnce(root);

  assert.equal(result.executed, false);
  assert.equal(result.outcome.status, "failed");
  assert.match(result.outcome.statusMessage, /disk full/);
  const state = JSON.parse(fs.readFileSync(path.join(root, ".prismo", "repair-state.json"), "utf8"));
  assert.equal(state.causes["repeated-file-reads"].lastStatus, "failed");
});

test("planner survives a usage-summary failure", () => {
  const { planner } = plannerWith([], {
    getUsageSummary: () => { throw new Error("no logs"); },
  });

  const result = planner.plan(tempDir());

  assert.equal(result.sessionsAnalyzed, 0);
  assert.equal(result.decision, null);
});

test("renderPlannerTerminal shows causes, decision, and holds", () => {
  const { planner } = plannerWith([]);

  const output = planner.renderPlannerTerminal({
    sessionsAnalyzed: 4,
    causes: [{ cause: "context-loop", wastedTokens: 60000, wasteRate: 0.3, sessions: 2 }],
    decision: { cause: "context-loop", tier: "aggressive", reason: "Last mild repair came back no-change; escalating to aggressive." },
    skipped: [{ cause: "tool-output-flood", reason: "cooldown" }],
    executed: true,
    outcome: { status: "completed", statusMessage: "Repaired context loop." },
  });

  assert.ok(output.includes("Sessions analyzed: 4"));
  assert.ok(output.includes("context-loop: 60,000 tokens"));
  assert.ok(output.includes("Decision: repair context-loop (aggressive tier)"));
  assert.ok(output.includes("tool-output-flood: cooldown"));
  assert.ok(output.includes("Repaired context loop."));
});
