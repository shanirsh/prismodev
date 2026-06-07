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
