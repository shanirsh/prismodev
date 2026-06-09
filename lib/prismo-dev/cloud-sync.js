module.exports = function createCloudSync(deps) {
  const {
    fs,
    http,
    https,
    os,
    path,
    PACKAGE_VERSION,
    NPX_COMMAND,
    getUsageSummary,
    scanRepo,
  } = deps;

  const DEFAULT_API_URL = "https://api.getprismo.dev";
  const CONFIG_VERSION = 1;

  function prismoHome() {
    return process.env.PRISMO_HOME || path.join(os.homedir(), ".prismo");
  }

  function configPath() {
    return path.join(prismoHome(), "config.json");
  }

  function statePath() {
    return path.join(prismoHome(), "sync-state.json");
  }

  function readJson(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  function writeJson(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  function redactRemote(remote) {
    const value = String(remote || "").trim();
    if (!value) return null;
    const githubSsh = value.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
    if (githubSsh) return `github.com/${githubSsh[1]}/${githubSsh[2].replace(/\.git$/i, "")}`;
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.replace(/^www\./, "");
      const repo = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
      return repo ? `${host}/${repo}` : host;
    } catch {
      return value.replace(/https?:\/\/[^@]+@/i, "https://").replace(/\.git$/i, "");
    }
  }

  function runGit(root, args) {
    try {
      const { spawnSync } = require("child_process");
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return result.status === 0 ? String(result.stdout || "").trim() : "";
    } catch {
      return "";
    }
  }

  function repoIdentity(root) {
    const resolved = path.resolve(root || process.cwd());
    const remote = runGit(resolved, ["config", "--get", "remote.origin.url"]);
    const branch = runGit(resolved, ["branch", "--show-current"]);
    const commit = runGit(resolved, ["rev-parse", "--short=12", "HEAD"]);
    return {
      pathBasename: path.basename(resolved),
      remote: redactRemote(remote),
      branch: branch || null,
      commit: commit || null,
    };
  }

  function sumCounts(items) {
    return (items || []).reduce((sum, item) => sum + Number(item.count || 0), 0);
  }

  function topCauseForSession(session) {
    const toolTokens = Number(session.estimatedToolTokens || 0);
    const repeatedReads = sumCounts(session.actionableRepeatedPaths && session.actionableRepeatedPaths.length ? session.actionableRepeatedPaths : session.repeatedPathMentions);
    const artifacts = sumCounts(session.generatedArtifacts) + sumCounts(session.generatedArtifactGroups);
    const repeatedCommands = sumCounts(session.repeatedCommands);
    const candidates = [
      { cause: "tool-output-flood", score: toolTokens / 25000 },
      { cause: "repeated-file-reads", score: repeatedReads * 2000 },
      { cause: "generated-artifacts", score: artifacts * 2500 },
      { cause: "context-loop", score: (session.loopSuspicion ? 12000 : 0) + repeatedCommands * 3000 },
      { cause: "long-session-buildup", score: session.contextRisk === "High" ? 20000 : session.contextRisk === "Medium" ? 8000 : 0 },
    ].sort((a, b) => b.score - a.score);
    return candidates[0] && candidates[0].score > 0 ? candidates[0].cause : "low-signal";
  }

  function estimateWaste(session) {
    const tokens = Number(session.displayTokens || session.contextTokens || session.tokens || 0);
    const toolTokens = Number(session.estimatedToolTokens || 0);
    const repeatedReads = sumCounts(session.actionableRepeatedPaths && session.actionableRepeatedPaths.length ? session.actionableRepeatedPaths : session.repeatedPathMentions);
    const artifacts = sumCounts(session.generatedArtifacts) + sumCounts(session.generatedArtifactGroups);
    const repeatedCommands = sumCounts(session.repeatedCommands);
    const riskDrag = session.contextRisk === "High" ? tokens * 0.18 : session.contextRisk === "Medium" ? tokens * 0.08 : 0;
    const loopDrag = session.loopSuspicion ? tokens * 0.12 : 0;
    const wasted = Math.min(tokens, Math.round(
      toolTokens * 0.65 +
      repeatedReads * 1800 +
      artifacts * 2200 +
      repeatedCommands * 2800 +
      riskDrag +
      loopDrag
    ));
    return {
      tokens,
      wastedTokens: Math.max(0, wasted),
      wastePercent: tokens > 0 ? Math.round((Math.max(0, wasted) / tokens) * 100) : 0,
      topCause: topCauseForSession(session),
    };
  }

  function sanitizeSession(session, repo) {
    const waste = estimateWaste(session);
    return {
      sessionId: session.sessionId || null,
      title: session.title || null,
      tool: session.tool || "unknown",
      model: session.model || null,
      repo,
      startedAt: session.startedAt || null,
      updatedAt: session.updatedAt || null,
      turns: Number(session.turns || 0),
      toolCalls: Number(session.toolCalls || 0),
      toolResults: Number(session.toolResults || 0),
      contextRisk: session.contextRisk || "Unknown",
      confidence: session.confidence || "unknown",
      tokens: {
        display: Number(session.displayTokens || 0),
        context: Number(session.contextTokens || 0),
        exact: Number(session.exactTotalTokens || 0),
        toolOutput: Number(session.estimatedToolTokens || 0),
      },
      waste,
      signals: {
        repeatedFileReads: sumCounts(session.actionableRepeatedPaths && session.actionableRepeatedPaths.length ? session.actionableRepeatedPaths : session.repeatedPathMentions),
        generatedArtifactMentions: sumCounts(session.generatedArtifacts) + sumCounts(session.generatedArtifactGroups),
        repeatedCommands: sumCounts(session.repeatedCommands),
        loopSuspicion: Boolean(session.loopSuspicion),
      },
    };
  }

  function buildSyncPayload(rootDir = process.cwd(), options = {}) {
    const root = path.resolve(rootDir);
    const repo = repoIdentity(root);
    const usage = getUsageSummary({
      cwd: root,
      tool: options.tool || "all",
      limit: options.limit || 20,
    });
    let scan = null;
    try {
      scan = scanRepo(root, { includeUsage: false });
    } catch {
      scan = null;
    }
    const sessions = (usage.sessions || []).map((session) => sanitizeSession(session, repo));
    const aggregate = sessions.reduce((acc, session) => {
      acc.sessions += 1;
      acc.displayTokens += session.tokens.display;
      acc.contextTokens += session.tokens.context;
      acc.exactTokens += session.tokens.exact;
      acc.toolOutputTokens += session.tokens.toolOutput;
      acc.estimatedWastedTokens += session.waste.wastedTokens;
      return acc;
    }, {
      sessions: 0,
      displayTokens: 0,
      contextTokens: 0,
      exactTokens: 0,
      toolOutputTokens: 0,
      estimatedWastedTokens: 0,
    });
    aggregate.wastePercent = aggregate.displayTokens > 0 ? Math.round((aggregate.estimatedWastedTokens / aggregate.displayTokens) * 100) : 0;

    return {
      schemaVersion: 1,
      command: "sync",
      generatedAt: new Date().toISOString(),
      client: {
        name: "prismodev",
        version: PACKAGE_VERSION,
        platform: `${os.platform()} ${os.arch()}`,
        hostname: os.hostname(),
      },
      repo,
      usage: {
        confidence: usage.confidence,
        sources: usage.sources || [],
        totals: usage.totals || {},
      },
      scan: scan ? {
        score: scan.score,
        riskLevel: scan.risk,
        tokenLeaks: scan.issues.length,
        topTokenLeaks: scan.topTokenLeaks || [],
        toolOutputRisk: scan.toolOutputRisk,
        agentReadiness: scan.agentReadiness,
      } : null,
      aggregate,
      sessions,
      privacy: {
        rawPrompts: false,
        rawCode: false,
        rawStdout: false,
        rawStderr: false,
        fileContents: false,
        note: "Payload contains aggregate local telemetry only. It does not include prompts, source code, file contents, or command output.",
      },
    };
  }

  function requestJson(method, urlValue, token, payload, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(urlValue);
      } catch {
        reject(new Error(`Invalid URL: ${urlValue}`));
        return;
      }
      const body = payload ? JSON.stringify(payload) : null;
      const client = parsed.protocol === "https:" ? https : http;
      const request = client.request({
        method,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          "user-agent": `prismodev/${PACKAGE_VERSION}`,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
        },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = { text };
          }
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ statusCode: response.statusCode, data });
          } else {
            reject(new Error(`HTTP ${response.statusCode}: ${text || response.statusMessage}`));
          }
        });
      });
      request.on("timeout", () => {
        request.destroy();
        reject(new Error("Request timed out"));
      });
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
  }

  function loadConfig() {
    return readJson(configPath());
  }

  function runConnect(options = {}) {
    const apiUrl = String(options.apiUrl || process.env.PRISMO_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
    const token = options.token || process.env.PRISMO_API_KEY || process.env.PRISMO_DEV_TOKEN || null;
    const existing = loadConfig();
    const deviceName = options.device || existing?.device?.name || os.hostname();
    const config = {
      schemaVersion: CONFIG_VERSION,
      connectedAt: new Date().toISOString(),
      apiUrl,
      org: options.org || existing?.org || null,
      user: options.user || existing?.user || null,
      device: {
        id: existing?.device?.id || `${os.hostname()}-${Date.now().toString(36)}`,
        name: deviceName,
        platform: `${os.platform()} ${os.arch()}`,
      },
      token,
      sync: {
        enabled: Boolean(token),
        defaultLimit: Number(options.limit || existing?.sync?.defaultLimit || 20),
      },
    };
    writeJson(configPath(), config);
    return {
      schemaVersion: 1,
      command: "connect",
      connected: Boolean(token),
      configPath: configPath(),
      apiUrl,
      org: config.org,
      user: config.user,
      device: config.device,
      tokenStored: Boolean(token),
      next: token
        ? [`${NPX_COMMAND} sync`, `${NPX_COMMAND} status`]
        : [
            "Open the Prismo dashboard and create a PrismoDev device token.",
            `${NPX_COMMAND} connect --token <token>`,
            `${NPX_COMMAND} sync`,
          ],
    };
  }

  async function runSync(rootDir = process.cwd(), options = {}) {
    const config = loadConfig();
    const payload = buildSyncPayload(rootDir, {
      limit: options.limit || config?.sync?.defaultLimit || 20,
      tool: options.tool || "all",
    });
    if (options.dryRun || options.preview) {
      return {
        schemaVersion: 1,
        command: "sync",
        dryRun: true,
        connected: Boolean(config?.token),
        configPath: configPath(),
        apiUrl: config?.apiUrl || null,
        payload,
        next: config?.token ? [`${NPX_COMMAND} sync`] : [`${NPX_COMMAND} connect --token <token>`],
      };
    }
    if (!config || !config.token) {
      return {
        schemaVersion: 1,
        command: "sync",
        synced: false,
        error: "not-connected",
        configPath: configPath(),
        next: [`${NPX_COMMAND} connect --token <token>`],
      };
    }
    const endpoint = options.endpoint || `${String(config.apiUrl || DEFAULT_API_URL).replace(/\/$/, "")}/v1/dev/sessions/sync`;
    const response = await requestJson("POST", endpoint, config.token, payload, options.timeoutMs || 8000);
    const state = {
      schemaVersion: 1,
      lastSyncAt: new Date().toISOString(),
      endpoint,
      repo: payload.repo,
      aggregate: payload.aggregate,
      response: response.data,
    };
    writeJson(statePath(), state);
    return {
      schemaVersion: 1,
      command: "sync",
      synced: true,
      endpoint,
      statusCode: response.statusCode,
      statePath: statePath(),
      aggregate: payload.aggregate,
      response: response.data,
    };
  }

  function runStatus() {
    const config = loadConfig();
    const state = readJson(statePath());
    return {
      schemaVersion: 1,
      command: "status",
      connected: Boolean(config?.token),
      configPath: configPath(),
      apiUrl: config?.apiUrl || null,
      org: config?.org || null,
      user: config?.user || null,
      device: config?.device || null,
      syncEnabled: Boolean(config?.sync?.enabled),
      lastSync: state || null,
      next: config?.token ? [`${NPX_COMMAND} sync`] : [`${NPX_COMMAND} connect --token <token>`],
    };
  }

  function runDisconnect() {
    const existed = fs.existsSync(configPath());
    const stateExisted = fs.existsSync(statePath());
    if (existed) fs.rmSync(configPath(), { force: true });
    if (stateExisted) fs.rmSync(statePath(), { force: true });
    return {
      schemaVersion: 1,
      command: "disconnect",
      disconnected: existed || stateExisted,
      removed: [existed ? configPath() : null, stateExisted ? statePath() : null].filter(Boolean),
    };
  }

  function renderConnectTerminal(result) {
    const lines = [];
    lines.push("");
    if (result.connected && result.connector?.started) {
      lines.push("Prismo agent is running.");
      lines.push("");
      lines.push(`Device: ${result.device.name}`);
      lines.push(`Mode: ${result.connector.mode || "autopilot"}`);
      lines.push(`Poll: every ${result.connector.interval || 15}s`);
      lines.push(`Sync: every ${result.connector.syncInterval || 60}s`);
      lines.push("");
      lines.push("Your agent will continuously scan, repair, and guard this repo.");
      lines.push("Open the dashboard to see what it's doing.");
    } else {
      lines.push("PrismoDev Connect");
      lines.push("");
      lines.push(`Status: ${result.connected ? "connected" : "token needed"}`);
      lines.push(`Config: ${result.configPath}`);
      lines.push(`API: ${result.apiUrl}`);
      lines.push(`Device: ${result.device.name}`);
      if (result.connector) {
        lines.push(`Connector: ${result.connector.started ? "started" : result.connector.installed ? "installed" : "not started"}`);
        if (result.connector.reason) lines.push(`Note: ${result.connector.reason}`);
        if (result.connector.error) lines.push(`Error: ${result.connector.error}`);
      }
      lines.push("");
      lines.push("Next");
      result.next.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    }
    return lines.join("\n");
  }

  function renderSyncTerminal(result) {
    const lines = [];
    lines.push("");
    lines.push("PrismoDev Sync");
    lines.push("");
    if (result.dryRun) {
      lines.push("Mode: dry run");
      lines.push(`Connected: ${result.connected ? "yes" : "no"}`);
      lines.push(`Sessions: ${result.payload.aggregate.sessions}`);
      lines.push(`Observed tokens: ${result.payload.aggregate.displayTokens.toLocaleString()}`);
      lines.push(`Likely wasted: ${result.payload.aggregate.estimatedWastedTokens.toLocaleString()} (${result.payload.aggregate.wastePercent}%)`);
    } else if (result.synced) {
      lines.push("Status: synced");
      lines.push(`Endpoint: ${result.endpoint}`);
      lines.push(`Sessions: ${result.aggregate.sessions}`);
      lines.push(`Likely wasted: ${result.aggregate.estimatedWastedTokens.toLocaleString()} (${result.aggregate.wastePercent}%)`);
    } else {
      lines.push("Status: not connected");
      lines.push(`Config: ${result.configPath}`);
    }
    if (result.next && result.next.length) {
      lines.push("");
      lines.push("Next");
      result.next.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    }
    return lines.join("\n");
  }

  function renderStatusTerminal(result) {
    const lines = [];
    lines.push("");
    lines.push("PrismoDev Status");
    lines.push("");
    lines.push(`Connected: ${result.connected ? "yes" : "no"}`);
    lines.push(`Config: ${result.configPath}`);
    if (result.apiUrl) lines.push(`API: ${result.apiUrl}`);
    if (result.device) lines.push(`Device: ${result.device.name}`);
    if (result.lastSync) {
      lines.push(`Last sync: ${result.lastSync.lastSyncAt}`);
      lines.push(`Sessions: ${result.lastSync.aggregate.sessions}`);
      lines.push(`Likely wasted: ${result.lastSync.aggregate.estimatedWastedTokens.toLocaleString()} (${result.lastSync.aggregate.wastePercent}%)`);
    } else {
      lines.push("Last sync: never");
    }
    lines.push("");
    lines.push("Next");
    result.next.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    return lines.join("\n");
  }

  function renderDisconnectTerminal(result) {
    const lines = [];
    lines.push("");
    lines.push("PrismoDev Disconnect");
    lines.push("");
    lines.push(result.disconnected ? "Local PrismoDev connection removed." : "No local PrismoDev connection was found.");
    return lines.join("\n");
  }

  return {
    buildSyncPayload,
    configPath,
    estimateWaste,
    loadConfig,
    renderConnectTerminal,
    renderDisconnectTerminal,
    renderStatusTerminal,
    renderSyncTerminal,
    runConnect,
    runDisconnect,
    runStatus,
    runSync,
  };
};
