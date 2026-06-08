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
