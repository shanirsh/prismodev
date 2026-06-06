module.exports = function createGuard(deps) {
  const {
    fs,
    http,
    https,
    os,
    path,
    PACKAGE_VERSION,
    NPX_COMMAND,
    getUsageSummary,
    buildWatchEvent,
    writeContextThrottle,
    writeLiveGuardrails,
    writeWatchEvent,
    runFirewall,
    loadConfig,
  } = deps;

  const DEFAULT_API_URL = "https://api.getprismo.dev";

  function guardRoot(root) {
    return path.join(root, ".prismo");
  }

  function guardEventsPath(root) {
    return path.join(guardRoot(root), "guard-events.jsonl");
  }

  function guardStatePath(root) {
    return path.join(guardRoot(root), "guard-state.json");
  }

  function readLastJsonLine(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
      if (!lines.length) return null;
      return JSON.parse(lines[lines.length - 1]);
    } catch {
      return null;
    }
  }

  function writeJson(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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

  function estimatePreventedTokens(event) {
    if (!event) return 0;
    const toolOutput = Number(event.toolOutputTokens || 0);
    const tokens = Number(event.tokens || 0);
    const growth = Number(event.recentContextGrowth || 0);
    const repeated = (event.repeatedFiles || []).reduce((sum, item) => sum + Number(item.count || 0), 0);
    const artifacts = (event.artifactGroups || []).reduce((sum, item) => sum + Number(item.count || 0), 0);

    if (event.cause === "tool-output-flood") return Math.round(toolOutput * 0.65);
    if (event.cause === "possible-loop") return Math.round(Math.max(toolOutput * 0.45, tokens * 0.08));
    if (event.cause === "artifact-leak") return Math.round(artifacts * 2200);
    if (event.cause === "repeated-file-read") return Math.round(repeated * 1800);
    if (event.cause === "context-spike") return Math.round(growth * 0.5);
    if (event.cause === "token-budget-exceeded") return Math.round(Number(event.budget?.overBy || 0));
    if (event.cause === "high-context-pressure") return Math.round(tokens * 0.08);
    return 0;
  }

  function actionForEvent(event) {
    if (!event) {
      return {
        type: "waiting-for-session",
        label: "Waiting for a local coding-agent session",
        command: `${NPX_COMMAND} setup`,
      };
    }
    if (event.shieldPlan) {
      return {
        type: "shield-recommended",
        label: "Route noisy command output through shield",
        command: event.shieldPlan.commandTemplate || `${NPX_COMMAND} shield -- <command>`,
      };
    }
    if (event.cause === "artifact-leak") {
      return {
        type: "ignore-coverage",
        label: "Tighten ignore coverage for generated artifacts",
        command: `${NPX_COMMAND} doctor --apply-suggestions`,
      };
    }
    if (event.cause === "repeated-file-read") {
      return {
        type: "context-pack",
        label: "Use a compact context pack instead of repeated file reads",
        command: `${NPX_COMMAND} context`,
      };
    }
    if (event.cause === "context-spike" || event.cause === "high-context-pressure" || event.cause === "token-budget-exceeded") {
      return {
        type: "fresh-session",
        label: "Start a scoped fresh session with a rescue prompt",
        command: `${NPX_COMMAND} watch --rescue`,
      };
    }
    return {
      type: "watching",
      label: "Keep guardrails active",
      command: `${NPX_COMMAND} guard --watch`,
    };
  }

  function buildGuardEvent(summary, repo, event) {
    const action = actionForEvent(event);
    const generatedAt = summary.generatedAt || new Date().toISOString();
    const active = summary.live?.activeSession || null;
    return {
      schemaVersion: 1,
      eventId: event ? `${event.signature}:${generatedAt}` : `heartbeat:${generatedAt}`,
      type: event ? "prevention" : "heartbeat",
      createdAt: generatedAt,
      repo,
      tool: event?.tool || active?.tool || summary.tool || "all",
      sessionId: event?.sessionId || active?.sessionId || null,
      pressure: event?.pressure || summary.live?.contextPressure || "Low",
      cause: event?.cause || "no-active-session",
      confidence: event?.confidence || "low",
      summary: event?.summary || "Guard is running and waiting for local session signals.",
      tokensObserved: Number(event?.tokens || active?.tokens || 0),
      tokensPrevented: estimatePreventedTokens(event),
      action,
      guardrails: {
        guardrailsPath: summary.guardrailsPath || null,
        rescuePath: summary.rescuePath || null,
        throttlePath: summary.throttlePath || null,
        firewallPath: summary.firewallPath || null,
        watchEventsPath: summary.eventsPath || null,
      },
      signals: {
        warnings: event?.warnings || summary.live?.warnings || [],
        repeatedFiles: event?.repeatedFiles || [],
        artifactGroups: event?.artifactGroups || [],
        shieldPlan: event?.shieldPlan || null,
        budget: event?.budget || summary.live?.budget || null,
      },
      privacy: {
        rawPrompts: false,
        rawCode: false,
        rawStdout: false,
        rawStderr: false,
        fileContents: false,
      },
    };
  }

  function appendGuardEvent(root, event) {
    const filePath = guardEventsPath(root);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const last = readLastJsonLine(filePath);
    if (last?.cause === event.cause && last?.sessionId === event.sessionId && last?.summary === event.summary) {
      return { path: ".prismo/guard-events.jsonl", appended: false };
    }
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
    return { path: ".prismo/guard-events.jsonl", appended: true };
  }

  function buildGuardPayload(root, guardEvent, state) {
    return {
      schemaVersion: 1,
      command: "guard",
      generatedAt: new Date().toISOString(),
      client: {
        name: "prismodev",
        version: PACKAGE_VERSION,
        platform: `${os.platform()} ${os.arch()}`,
        hostname: os.hostname(),
      },
      repo: guardEvent.repo,
      state: {
        mode: state.mode,
        status: state.status,
        heartbeatAt: state.heartbeatAt,
        active: state.active,
      },
      aggregate: {
        events: 1,
        tokensObserved: guardEvent.tokensObserved,
        tokensPrevented: guardEvent.tokensPrevented,
      },
      events: [guardEvent],
      privacy: {
        rawPrompts: false,
        rawCode: false,
        rawStdout: false,
        rawStderr: false,
        fileContents: false,
        note: "Payload contains guardrail state and aggregate prevention events only. It does not include prompts, source code, file contents, or command output.",
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

  async function syncGuardEvent(root, guardEvent, state, options = {}) {
    const config = loadConfig ? loadConfig() : null;
    const payload = buildGuardPayload(root, guardEvent, state);
    if (options.dryRun || options.noSync || !config?.token) {
      return {
        attempted: false,
        connected: Boolean(config?.token),
        reason: options.noSync ? "disabled" : config?.token ? "dry-run" : "not-connected",
        payload,
      };
    }
    const endpoint = options.endpoint || `${String(config.apiUrl || DEFAULT_API_URL).replace(/\/$/, "")}/v1/dev/guardrails/sync`;
    try {
      const response = await requestJson("POST", endpoint, config.token, payload, options.timeoutMs || 8000);
      return { attempted: true, synced: true, endpoint, statusCode: response.statusCode, response: response.data };
    } catch (error) {
      return { attempted: true, synced: false, endpoint, error: error.message };
    }
  }

  async function runGuard(rootDir = process.cwd(), options = {}) {
    const root = path.resolve(rootDir || process.cwd());
    const repo = repoIdentity(root);
    const summary = getUsageSummary({
      cwd: root,
      tool: options.tool || "all",
      limit: options.limit || 5,
      tokenBudget: options.tokenBudget || 600000,
    });
    summary.auto = true;
    summary.scannedPath = summary.scannedPath || root;
    summary.tokenBudget = options.tokenBudget || 600000;

    if (options.dryRun) {
      summary.guardrailsPath = ".prismo/live-guardrails.md";
      summary.rescuePath = ".prismo/live-rescue-prompt.md";
      summary.throttlePath = ".prismo/live-context-throttle.md";
    } else {
      const liveFiles = writeLiveGuardrails(summary);
      summary.guardrailsPath = liveFiles.guardrailsPath;
      summary.rescuePath = liveFiles.rescuePath;
      summary.throttlePath = writeContextThrottle(summary);
    }

    const watchEventPath = options.dryRun ? null : writeWatchEvent(summary);
    if (watchEventPath) summary.eventsPath = watchEventPath;

    const watchEvent = buildWatchEvent(summary);
    if (watchEvent && options.applyFirewall !== false && !options.dryRun) {
      const firewall = runFirewall(root, {
        task: watchEvent.cause,
        dryRun: false,
        live: true,
      });
      if (firewall?.generatedFiles) summary.firewallPath = ".prismo/context-firewall.md";
    }

    const guardEvent = buildGuardEvent(summary, repo, watchEvent);
    const eventWrite = options.dryRun ? { path: ".prismo/guard-events.jsonl", appended: false } : appendGuardEvent(root, guardEvent);
    const state = {
      schemaVersion: 1,
      command: "guard",
      mode: options.watch ? "watch" : "once",
      status: guardEvent.type === "prevention" ? "preventing" : "watching",
      active: true,
      heartbeatAt: new Date().toISOString(),
      repo,
      lastEvent: guardEvent,
      files: {
        guardStatePath: ".prismo/guard-state.json",
        guardEventsPath: eventWrite.path,
        guardrailsPath: summary.guardrailsPath || null,
        rescuePath: summary.rescuePath || null,
        throttlePath: summary.throttlePath || null,
        firewallPath: summary.firewallPath || null,
        watchEventsPath: summary.eventsPath || null,
      },
    };
    if (!options.dryRun) writeJson(guardStatePath(root), state);
    const dashboardSync = await syncGuardEvent(root, guardEvent, state, options);
    return {
      schemaVersion: 1,
      command: "guard",
      dryRun: Boolean(options.dryRun),
      status: state.status,
      mode: state.mode,
      repo,
      event: guardEvent,
      files: state.files,
      dashboardSync,
      next: guardEvent.action?.command ? [guardEvent.action.command, `${NPX_COMMAND} guard --watch`] : [`${NPX_COMMAND} guard --watch`],
    };
  }

  function formatTokens(value) {
    const n = Number(value || 0);
    if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(Math.round(n));
  }

  function renderGuardTerminal(result) {
    const lines = [];
    lines.push("");
    lines.push("PrismoDev Guard");
    lines.push("");
    lines.push(`Status: ${result.status}`);
    lines.push(`Repo: ${result.repo.remote || result.repo.pathBasename}`);
    lines.push(`Cause: ${result.event.cause}`);
    lines.push(`Action: ${result.event.action.label}`);
    if (result.event.tokensPrevented > 0) {
      lines.push(`Estimated prevented: ${formatTokens(result.event.tokensPrevented)} tokens`);
    }
    lines.push("");
    lines.push("Files");
    Object.entries(result.files || {}).forEach(([label, value]) => {
      if (value) lines.push(`- ${label}: ${value}`);
    });
    lines.push("");
    if (result.dashboardSync?.synced) {
      lines.push(`Dashboard sync: synced (${result.dashboardSync.statusCode})`);
    } else if (result.dashboardSync?.attempted) {
      lines.push(`Dashboard sync: pending web support (${result.dashboardSync.error})`);
    } else {
      lines.push(`Dashboard sync: ${result.dashboardSync?.reason || "not-connected"}`);
    }
    lines.push("");
    lines.push("Next");
    result.next.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    return lines.join("\n");
  }

  return {
    buildGuardEvent,
    buildGuardPayload,
    renderGuardTerminal,
    runGuard,
  };
};
