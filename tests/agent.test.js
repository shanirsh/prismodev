const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");

const createAgent = require("../lib/prismo-dev/agent");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prismo-agent-"));
}

function createServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(text ? JSON.parse(text) : null);
    });
  });
}

function agentWith(overrides = {}) {
  return createAgent({
    fs,
    http,
    https: require("https"),
    path,
    NPX_COMMAND: "npx -y getprismo@latest",
    PACKAGE_VERSION: "0.0.0-test",
    loadConfig: () => null,
    runDoctor: () => ({
      after: { score: 91 },
      generatedFiles: [".claudeignore", ".prismo/frontend-summary.md"],
    }),
    runSync: async () => ({ synced: true, aggregate: { sessions: 1 } }),
    runGuard: async () => ({ guardRunning: false, events: [] }),
    runShield: () => ({ exitCode: 0, summary: "ok", runDir: ".prismo/shield/runs/1" }),
    runOptimize: () => ({ generatedFiles: [".prismo/frontend-summary.md"] }),
    ...overrides,
  });
}

test("agent routes actions with a targetCause to the cause-specific executor", async () => {
  const executorCalls = [];
  let doctorCalled = false;
  const agent = agentWith({
    runDoctor: () => { doctorCalled = true; return { after: { score: 90 } }; },
    repairExecutors: {
      forCause: (cause) => (cause === "repeated-file-reads"
        ? async (action, root, helpers) => {
            executorCalls.push({ action, root, hasProgress: typeof helpers.progress === "function" });
            return {
              status: "completed",
              statusMessage: "Repaired repeated file reads.",
              result: { command: "repair", targetCause: "repeated-file-reads" },
            };
          }
        : null),
    },
  });

  const result = await agent.executeAction({
    id: "action-cause-1",
    actionType: "doctor",
    command: "npx -y getprismo@latest doctor",
    label: "Fix repeated file reads",
    targetCause: "repeated-file-reads",
  }, tempDir());

  assert.equal(result.status, "completed");
  assert.equal(result.result.targetCause, "repeated-file-reads");
  assert.equal(executorCalls.length, 1);
  assert.equal(executorCalls[0].hasProgress, true);
  assert.equal(doctorCalled, false);
});

test("agent falls back to generic dispatch for unknown or missing targetCause", async () => {
  let doctorCalls = 0;
  const agent = agentWith({
    runDoctor: () => { doctorCalls += 1; return { after: { score: 90 } }; },
    repairExecutors: { forCause: () => null },
  });

  const withUnknownCause = await agent.executeAction({
    id: "action-cause-2",
    actionType: "doctor",
    command: "npx -y getprismo@latest doctor",
    label: "Run doctor",
    targetCause: "not-a-real-cause",
  }, tempDir());
  const withoutCause = await agent.executeAction({
    id: "action-cause-3",
    actionType: "doctor",
    command: "npx -y getprismo@latest doctor",
    label: "Run doctor",
  }, tempDir());

  assert.equal(withUnknownCause.status, "completed");
  assert.equal(withUnknownCause.result.command, "doctor");
  assert.equal(withoutCause.status, "completed");
  assert.equal(doctorCalls, 2);
});

test("agent passes --tier from an escalated cloud command to the executor", async () => {
  const tiersSeen = [];
  const agent = agentWith({
    repairExecutors: {
      forCause: (cause) => (cause === "tool-output-flood"
        ? async (action, root, helpers) => {
            tiersSeen.push(helpers.options.tier || null);
            return { status: "completed", statusMessage: "ok", result: { targetCause: cause, tier: helpers.options.tier } };
          }
        : null),
    },
  });

  const escalated = await agent.executeAction({
    id: "action-tier-1",
    actionType: "shield",
    command: "npx -y getprismo@latest repair tool-output-flood --tier aggressive",
    label: "Auto-queued: Tool-output floods",
    targetCause: "tool-output-flood",
  }, tempDir());
  const mild = await agent.executeAction({
    id: "action-tier-2",
    actionType: "shield",
    command: "npx -y getprismo@latest repair tool-output-flood",
    label: "Auto-queued: Tool-output floods",
    targetCause: "tool-output-flood",
  }, tempDir());

  assert.equal(escalated.result.tier, "aggressive");
  assert.equal(mild.status, "completed");
  assert.deepEqual(tiersSeen, ["aggressive", null]);
});

test("agent resolves the cause from a repair command when targetCause is missing", async () => {
  const causesSeen = [];
  const agent = agentWith({
    repairExecutors: {
      forCause: (cause) => {
        causesSeen.push(cause);
        return cause === "context-loop"
          ? async () => ({ status: "completed", statusMessage: "ok", result: { targetCause: "context-loop" } })
          : null;
      },
    },
  });

  const result = await agent.executeAction({
    id: "action-cause-4",
    actionType: "repair",
    command: "npx -y getprismo@latest repair context-loop",
    label: "Repair context loop",
  }, tempDir());

  assert.equal(result.status, "completed");
  assert.deepEqual(causesSeen, ["context-loop"]);
});

test("agent runs the repair planner in autopilot and reports it via auto-detect", async () => {
  const plannerCalls = [];
  const detectPayloads = [];
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/dev/workspace/auto-detect") {
      detectPayloads.push(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ actions: [] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
      repairPlanner: {
        runPlannerOnce: async (root, options) => {
          plannerCalls.push(options);
          return {
            generatedAt: new Date().toISOString(),
            sessionsAnalyzed: 3,
            causes: [{ cause: "context-loop", wastedTokens: 60000, wasteRate: 0.3, sessions: 2 }],
            decision: { cause: "context-loop", tier: "mild", reason: "top cause" },
            skipped: [],
            executed: true,
            outcome: { status: "completed", statusMessage: "Repaired context loop.", tier: "mild", generatedFiles: [".prismo/loop-breaker.md"] },
          };
        },
      },
    });

    const result = await agent.runAgentOnce(tempDir(), { mode: "autopilot", planRepairs: true });

    assert.equal(plannerCalls.length, 1);
    assert.equal(plannerCalls[0].execute, true);
    assert.ok(result.planner);
    assert.equal(result.planner.decision.cause, "context-loop");
    assert.equal(detectPayloads.length, 1);
    assert.equal(detectPayloads[0].applied, true);
    assert.equal(detectPayloads[0].findings[0].type, "self-repair");
    assert.equal(detectPayloads[0].findings[0].cause, "context-loop");
  } finally {
    server.close();
  }
});

test("agent registers executed self-repairs as workspace actions for cloud verification", async () => {
  const creates = [];
  const patches = [];
  const detectPayloads = [];
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/dev/workspace/actions/agent") {
      creates.push(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "self-repair-1", status: "queued" }));
      return;
    }
    if (req.method === "PATCH" && req.url === "/v1/dev/workspace/actions/self-repair-1") {
      patches.push(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/dev/workspace/auto-detect") {
      detectPayloads.push(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ actions: [] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
      repairPlanner: {
        runPlannerOnce: async () => ({
          generatedAt: new Date().toISOString(),
          sessionsAnalyzed: 3,
          causes: [{ cause: "repeated-file-reads", wastedTokens: 80000, wasteRate: 0.2, sessions: 2 }],
          decision: { cause: "repeated-file-reads", tier: "aggressive", reason: "escalated" },
          skipped: [],
          executed: true,
          outcome: { status: "completed", statusMessage: "Repaired repeated file reads.", tier: "aggressive", generatedFiles: [".prismo/hot-files.md"] },
        }),
      },
    });

    const result = await agent.runAgentOnce(tempDir(), { mode: "autopilot", planRepairs: true });

    assert.equal(creates.length, 1);
    assert.equal(creates[0].targetCause, "repeated-file-reads");
    assert.equal(creates[0].actionType, "doctor");
    assert.match(creates[0].label, /Self-repair: repeated-file-reads \(aggressive\)/);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].status, "completed");
    assert.equal(patches[0].result.tier, "aggressive");
    assert.equal(result.planner.registered, true);
    assert.equal(detectPayloads.length, 0);
  } finally {
    server.close();
  }
});

test("agent planner plans without executing outside autopilot", async () => {
  const plannerCalls = [];
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ actions: [] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
      repairPlanner: {
        runPlannerOnce: async (root, options) => {
          plannerCalls.push(options);
          return { generatedAt: new Date().toISOString(), sessionsAnalyzed: 0, causes: [], decision: null, skipped: [], executed: false, outcome: null };
        },
      },
    });

    const result = await agent.runAgentOnce(tempDir(), { mode: "observe", planRepairs: true });

    assert.equal(plannerCalls.length, 1);
    assert.equal(plannerCalls[0].execute, false);
    assert.equal(result.planner.executed, false);
  } finally {
    server.close();
  }
});

test("agent fetches fleet priors and passes them to the planner", async () => {
  const plannerOptions = [];
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/dev/fleet/repair-priors") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        totalVerdicts: 20,
        priors: [{ cause: "context-loop", tier: "mild", attempts: 10, improved: 2, improveRate: 0.2 }],
      }));
      return;
    }
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ actions: [] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
      repairPlanner: {
        runPlannerOnce: async (root, options) => {
          plannerOptions.push(options);
          return { generatedAt: new Date().toISOString(), sessionsAnalyzed: 0, causes: [], decision: null, skipped: [], executed: false, outcome: null };
        },
      },
    });

    await agent.runAgentOnce(tempDir(), { mode: "autopilot", planRepairs: true });

    assert.equal(plannerOptions.length, 1);
    assert.equal(plannerOptions[0].fleetPriors.length, 1);
    assert.equal(plannerOptions[0].fleetPriors[0].cause, "context-loop");
  } finally {
    server.close();
  }
});

test("agent skips the planner when planRepairs is not set", async () => {
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ actions: [] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    let plannerCalled = false;
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
      repairPlanner: {
        runPlannerOnce: async () => { plannerCalled = true; return {}; },
      },
    });

    const result = await agent.runAgentOnce(tempDir(), { mode: "autopilot" });

    assert.equal(plannerCalled, false);
    assert.equal(result.planner, null);
  } finally {
    server.close();
  }
});

test("agent reports not connected without polling cloud", async () => {
  const agent = agentWith();

  const result = await agent.runAgentOnce(tempDir());

  assert.equal(result.connected, false);
  assert.equal(result.error, "not-connected");
  assert.equal(result.actionsClaimed, 0);
});

test("agent claims workspace actions, runs safe command, and patches status", async () => {
  const patches = [];
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/dev/workspace/actions/claim?limit=5") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        actions: [{
          id: "action-1",
          actionType: "doctor",
          command: "npx -y getprismo@latest doctor",
          label: "Run doctor",
          repo: null,
          status: "claimed",
        }],
      }));
      return;
    }
    if (req.method === "PATCH" && req.url === "/v1/dev/workspace/actions/action-1") {
      patches.push(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
    });

    const result = await agent.runAgentOnce(tempDir());

    assert.equal(result.connected, true);
    assert.equal(result.actionsClaimed, 1);
    assert.equal(result.actionsCompleted, 1);
    assert.equal(result.actionsFailed, 0);
    assert.equal(patches.length, 2);
    assert.equal(patches[0].status, "running");
    assert.equal(patches[1].status, "completed");
    assert.equal(patches[1].result.command, "doctor");
  } finally {
    server.close();
  }
});

test("agent rejects unsafe shield workspace command", async () => {
  const agent = agentWith();

  const result = await agent.executeAction({
    id: "action-2",
    actionType: "shield",
    command: "npx -y getprismo@latest shield -- rm -rf .",
    label: "Unsafe shield",
  }, tempDir());

  assert.equal(result.status, "failed");
  assert.equal(result.result.reason, "unsafe-shield-command");
});

test("agent parses npx and direct prismo command forms", () => {
  const agent = agentWith();

  assert.deepEqual(agent.parseCommand("npx -y getprismo@latest doctor"), {
    raw: ["npx", "-y", "getprismo@latest", "doctor"],
    command: "doctor",
    args: [],
  });
  assert.deepEqual(agent.parseCommand("prismo sync --limit 5"), {
    raw: ["prismo", "sync", "--limit", "5"],
    command: "sync",
    args: ["--limit", "5"],
  });
});

test("agent sends heartbeat on each poll cycle", async () => {
  const heartbeats = [];
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/dev/workspace/heartbeat") {
      heartbeats.push(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/dev/workspace/actions/claim?limit=5") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ actions: [] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
    });

    await agent.runAgentOnce(tempDir());

    assert.equal(heartbeats.length, 1);
    assert.equal(heartbeats[0].status, "online");
    assert.equal(heartbeats[0].mode, "autopilot");
    assert.match(heartbeats[0].agent, /^prismodev\//);
    assert.ok(heartbeats[0].lastPollAt);
  } finally {
    server.close();
  }
});

test("agent publishes Claude loop stops and Codex/Cursor loop detections as live events", async () => {
  const liveEvents = [];
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/dev/workspace/heartbeat") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/dev/workspace/live-events") {
      liveEvents.push(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/dev/workspace/actions/claim?limit=5") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ actions: [] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const root = tempDir();
    fs.mkdirSync(path.join(root, ".prismo"), { recursive: true });
    fs.writeFileSync(path.join(root, ".prismo", "enforce-state.json"), JSON.stringify({
      loopStops: [{
        eventId: "claude-stop-1",
        at: "2026-06-11T18:00:00Z",
        tool: "claude-code",
        command: "npm test",
        reason: "repeated-failing-command",
        failures: 3,
        estimatedTokensSaved: 2000,
        sessionId: "claude-session",
      }],
    }), "utf8");

    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
      getUsageSummary: () => ({
        sessions: [
          {
            tool: "codex",
            sessionId: "codex-session",
            updatedAt: "2026-06-11T18:01:00Z",
            repeatedCommands: [{ value: "pytest -q", count: 4 }],
            loopSuspicion: true,
          },
          {
            tool: "cursor",
            sessionId: "cursor-session",
            updatedAt: "2026-06-11T18:02:00Z",
            repeatedCommands: [{ value: "npm run build", count: 3 }],
            loopSuspicion: false,
          },
        ],
      }),
    });

    await agent.runAgentOnce(root);

    const eventTypes = liveEvents.map((event) => event.eventType);
    assert.ok(eventTypes.includes("loop_stopped"));
    assert.equal(liveEvents.find((event) => event.eventType === "loop_stopped").phase, "stopped");
    assert.equal(liveEvents.filter((event) => event.eventType === "loop_detected").length, 2);
    assert.ok(liveEvents.some((event) => /Codex loop pattern/.test(event.headline)));
    assert.ok(liveEvents.some((event) => /Cursor loop pattern/.test(event.headline)));
  } finally {
    server.close();
  }
});

test("agent observe mode reports actions without executing", async () => {
  const requests = [];
  const { server, url } = await createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.method === "POST" && req.url === "/v1/dev/workspace/heartbeat") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/dev/workspace/actions/claim?limit=5") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        actions: [{
          id: "action-obs-1",
          actionType: "doctor",
          command: "prismo doctor",
          label: "Run doctor",
          status: "claimed",
        }],
      }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const doctorCalled = { value: false };
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
      runDoctor: () => { doctorCalled.value = true; return { after: { score: 90 } }; },
    });

    const result = await agent.runAgentOnce(tempDir(), { mode: "observe" });

    assert.equal(result.mode, "observe");
    assert.equal(result.actionsClaimed, 1);
    assert.equal(result.actionsCompleted, 0);
    assert.equal(result.actionsObserved, 1);
    assert.equal(result.results[0].status, "observed");
    assert.equal(doctorCalled.value, false);
    const patches = requests.filter((r) => r.method === "PATCH");
    assert.equal(patches.length, 0);
  } finally {
    server.close();
  }
});

test("agent suggest mode sends pending_approval without executing", async () => {
  const patches = [];
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/dev/workspace/heartbeat") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/dev/workspace/actions/claim?limit=5") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        actions: [{
          id: "action-sug-1",
          actionType: "sync",
          command: "prismo sync",
          label: "Run sync",
          status: "claimed",
        }],
      }));
      return;
    }
    if (req.method === "PATCH" && req.url === "/v1/dev/workspace/actions/action-sug-1") {
      patches.push(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const syncCalled = { value: false };
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
      runSync: async () => { syncCalled.value = true; return { synced: true }; },
    });

    const result = await agent.runAgentOnce(tempDir(), { mode: "suggest" });

    assert.equal(result.mode, "suggest");
    assert.equal(result.actionsCompleted, 0);
    assert.equal(result.actionsObserved, 1);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].status, "pending_approval");
    assert.equal(syncCalled.value, false);
  } finally {
    server.close();
  }
});

test("agent autopilot mode executes actions (default behavior)", async () => {
  const patches = [];
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/dev/workspace/heartbeat") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/dev/workspace/actions/claim?limit=5") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        actions: [{
          id: "action-auto-1",
          actionType: "doctor",
          command: "prismo doctor",
          label: "Run doctor",
          status: "claimed",
        }],
      }));
      return;
    }
    if (req.method === "PATCH" && req.url === "/v1/dev/workspace/actions/action-auto-1") {
      patches.push(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
    });

    const result = await agent.runAgentOnce(tempDir(), { mode: "autopilot" });

    assert.equal(result.mode, "autopilot");
    assert.equal(result.actionsCompleted, 1);
    assert.equal(result.actionsObserved, 0);
    assert.equal(patches.length, 2);
    assert.equal(patches[0].status, "running");
    assert.equal(patches[1].status, "completed");
  } finally {
    server.close();
  }
});

test("agent sends offline heartbeat via sendHeartbeat", async () => {
  const heartbeats = [];
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/dev/workspace/heartbeat") {
      heartbeats.push(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
    });

    await agent.sendHeartbeat(
      { token: "test-token", apiUrl: url },
      { mode: "observe", status: "offline" },
    );

    assert.equal(heartbeats.length, 1);
    assert.equal(heartbeats[0].status, "offline");
    assert.equal(heartbeats[0].mode, "observe");
  } finally {
    server.close();
  }
});

test("agent heartbeat failure does not block poll cycle", async () => {
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/dev/workspace/heartbeat") {
      res.writeHead(500);
      res.end("internal error");
      return;
    }
    if (req.method === "POST" && req.url === "/v1/dev/workspace/actions/claim?limit=5") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ actions: [] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
    });

    const result = await agent.runAgentOnce(tempDir());

    assert.equal(result.connected, true);
    assert.equal(result.actionsClaimed, 0);
  } finally {
    server.close();
  }
});

test("agent can sync telemetry during a poll cycle", async () => {
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/dev/workspace/heartbeat") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/dev/workspace/actions/claim?limit=5") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ actions: [] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    let synced = false;
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
      runSync: async () => {
        synced = true;
        return {
          synced: true,
          aggregate: {
            sessions: 2,
            estimatedWastedTokens: 1200,
            wastePercent: 12,
          },
        };
      },
    });

    const result = await agent.runAgentOnce(tempDir(), { syncTelemetry: true });

    assert.equal(synced, true);
    assert.equal(result.sync.synced, true);
    assert.equal(result.sync.sessions, 2);
    assert.equal(result.sync.estimatedWastedTokens, 1200);
  } finally {
    server.close();
  }
});

test("agent terminal output includes mode", () => {
  const agent = agentWith();

  const output = agent.renderAgentTerminal({
    connected: true,
    mode: "observe",
    apiUrl: "https://api.getprismo.dev",
    actionsClaimed: 2,
    actionsCompleted: 0,
    actionsFailed: 0,
    actionsObserved: 2,
    results: [
      { status: "observed", label: "Run doctor", statusMessage: "Agent is in observe mode." },
      { status: "observed", label: "Run sync", statusMessage: "Agent is in observe mode." },
    ],
  });

  assert.ok(output.includes("Mode: observe"));
  assert.ok(output.includes("Observed/Suggested: 2"));
});

test("VALID_MODES contains expected modes", () => {
  const agent = agentWith();
  assert.ok(agent.VALID_MODES.has("observe"));
  assert.ok(agent.VALID_MODES.has("suggest"));
  assert.ok(agent.VALID_MODES.has("autopilot"));
  assert.equal(agent.VALID_MODES.size, 3);
});

test("auto-detect runs doctor proactively and reports findings", async () => {
  const detectPayloads = [];
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/dev/workspace/heartbeat") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/dev/workspace/auto-detect") {
      detectPayloads.push(await readBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/dev/workspace/actions/claim?limit=5") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ actions: [] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
      runDoctor: (root, opts) => ({
        scan: { score: 62, issues: [{ severity: "high", message: ".next exposed" }] },
        after: { score: 85 },
        generatedFiles: [".claudeignore"],
      }),
    });

    const result = await agent.runAgentOnce(tempDir(), { mode: "autopilot", autoDetect: true });

    assert.ok(result.autoDetect);
    assert.equal(result.autoDetect.applied, true);
    assert.equal(result.autoDetect.score, 85);
    assert.equal(result.autoDetect.findings.length, 1);
    assert.equal(detectPayloads.length, 1);
    assert.equal(detectPayloads[0].applied, true);
  } finally {
    server.close();
  }
});

test("auto-detect in suggest mode marks findings as needing approval", async () => {
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
      runDoctor: () => ({
        scan: { score: 55, issues: [{ severity: "high", message: "node_modules exposed" }] },
        after: { score: 55 },
        generatedFiles: [],
      }),
    });

    const result = await agent.runAgentOnce(tempDir(), { mode: "suggest", autoDetect: true });

    assert.ok(result.autoDetect);
    assert.equal(result.autoDetect.applied, false);
    assert.equal(result.autoDetect.needsApproval, true);
    assert.ok(result.autoDetect.findings.length >= 1);
  } finally {
    server.close();
  }
});

test("auto-detect in observe mode does not apply changes", async () => {
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    let doctorOpts = null;
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
      runDoctor: (root, opts) => {
        doctorOpts = opts;
        return { scan: { score: 90, issues: [] }, after: { score: 90 }, generatedFiles: [] };
      },
    });

    const result = await agent.runAgentOnce(tempDir(), { mode: "observe", autoDetect: true });

    assert.ok(result.autoDetect);
    assert.equal(result.autoDetect.applied, false);
    assert.equal(result.autoDetect.needsApproval, false);
    assert.equal(doctorOpts.dryRun, true);
  } finally {
    server.close();
  }
});

test("auto-detect is skipped when autoDetect option is false", async () => {
  const { server, url } = await createServer(async (req, res) => {
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ actions: [] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const agent = agentWith({
      loadConfig: () => ({ token: "test-token", apiUrl: url }),
    });

    const result = await agent.runAgentOnce(tempDir(), { autoDetect: false });

    assert.equal(result.autoDetect, null);
  } finally {
    server.close();
  }
});

test("openWorkspace returns the default workspace URL", () => {
  let opened = null;
  const agent = createAgent({
    fs,
    http,
    https: require("https"),
    path,
    NPX_COMMAND: "npx -y getprismo@latest",
    PACKAGE_VERSION: "0.0.0-test",
    loadConfig: () => ({ token: "t" }),
    runDoctor: () => ({}),
    runSync: async () => ({}),
    runGuard: async () => ({}),
    runShield: () => ({}),
    runOptimize: () => ({}),
    openUrl: (url) => { opened = url; },
  });

  const url = agent.openWorkspace({ token: "t" });
  assert.equal(url, "https://getprismo.dev/dashboard/dev");
  assert.equal(opened, "https://getprismo.dev/dashboard/dev");
});

test("auto-detect terminal output shows findings", () => {
  const agent = agentWith();

  const output = agent.renderAgentTerminal({
    connected: true,
    mode: "autopilot",
    apiUrl: "https://api.getprismo.dev",
    actionsClaimed: 0,
    actionsCompleted: 0,
    actionsFailed: 0,
    actionsObserved: 0,
    autoDetect: {
      score: 72,
      findings: [{ type: "low-score", score: 72, message: "Context health score is 72/100." }],
      generatedFiles: [".claudeignore"],
      applied: true,
      needsApproval: false,
    },
    results: [],
  });

  assert.ok(output.includes("Auto-detect"));
  assert.ok(output.includes("Score: 72/100"));
  assert.ok(output.includes("auto-fixed"));
  assert.ok(output.includes(".claudeignore"));
  assert.ok(output.includes("Context health score is 72/100."));
});
