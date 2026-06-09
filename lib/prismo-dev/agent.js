module.exports = function createAgent(deps) {
  const {
    fs,
    http,
    https,
    path,
    NPX_COMMAND,
    PACKAGE_VERSION,
    loadConfig,
    runDoctor,
    runSync,
    runGuard,
    runShield,
    runOptimize,
    openUrl,
    repairExecutors,
    repairPlanner,
  } = deps;

  const DEFAULT_WORKSPACE_URL = "https://getprismo.dev/dashboard/dev";

  const DEFAULT_API_URL = "https://api.getprismo.dev";
  const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
  const SAFE_SHIELD_COMMANDS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "pytest", "python", "python3", "node"]);
  const VALID_MODES = new Set(["observe", "suggest", "autopilot"]);
  // Backend verification only measures these action types, so self-repairs
  // are registered under the matching type for their cause.
  const CAUSE_ACTION_TYPES = {
    "repeated-file-reads": "doctor",
    "tool-output-flood": "shield",
    "generated-artifacts": "doctor",
    "context-loop": "guard",
    "long-session-buildup": "context",
  };

  function apiBase(config) {
    return String(config?.apiUrl || DEFAULT_API_URL).replace(/\/$/, "");
  }

  function requestJson(method, urlValue, token, payload, timeoutMs = 15000) {
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
          "user-agent": `prismodev-agent/${PACKAGE_VERSION}`,
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

  function parseCommand(command) {
    const parts = String(command || "").trim().split(/\s+/).filter(Boolean);
    const getprismoIndex = parts.findIndex((part) => part === "getprismo" || part === "prismo" || part === "getprismo@latest");
    const commandIndex = getprismoIndex >= 0 ? getprismoIndex + 1 : 0;
    return {
      raw: parts,
      command: parts[commandIndex] || "",
      args: parts.slice(commandIndex + 1),
    };
  }

  function parseShieldArgs(args) {
    const separatorIndex = args.indexOf("--");
    const commandArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : args.slice(1);
    if (!commandArgs.length) return null;
    const binary = commandArgs[0];
    if (!SAFE_SHIELD_COMMANDS.has(binary)) return null;
    if (commandArgs.some((arg) => /[;&|`$<>]/.test(arg))) return null;
    return commandArgs;
  }

  function repoRoot(rootDir, action) {
    if (action.repo && path.basename(rootDir) !== action.repo) {
      const sibling = path.join(path.dirname(rootDir), action.repo);
      if (fs.existsSync(sibling) && fs.statSync(sibling).isDirectory()) return sibling;
    }
    return rootDir;
  }

  async function updateAction(config, actionId, payload, options = {}) {
    const endpoint = options.endpoint || `${apiBase(config)}/v1/dev/workspace/actions/${actionId}`;
    const response = await requestJson("PATCH", endpoint, config.token, payload, options.timeoutMs || 15000);
    return response.data;
  }

  async function claimActions(config, options = {}) {
    const limit = Number(options.limit || 5);
    const endpoint = options.endpoint || `${apiBase(config)}/v1/dev/workspace/actions/claim?limit=${encodeURIComponent(limit)}`;
    const response = await requestJson("POST", endpoint, config.token, null, options.timeoutMs || 15000);
    return response.data?.actions || [];
  }

  async function sendHeartbeat(config, payload = {}, options = {}) {
    const endpoint = options.heartbeatEndpoint || `${apiBase(config)}/v1/dev/workspace/heartbeat`;
    const body = {
      agent: `prismodev/${PACKAGE_VERSION}`,
      mode: payload.mode || "autopilot",
      status: payload.status || "online",
      ...(payload.lastPollAt ? { lastPollAt: payload.lastPollAt } : {}),
    };
    const response = await requestJson("POST", endpoint, config.token, body, options.timeoutMs || 10000);
    return response.data;
  }

  function runAutoDetect(rootDir, options = {}) {
    const mode = options.mode || "autopilot";
    const startedAt = new Date().toISOString();
    const result = runDoctor(rootDir, { limit: 3, applySuggestions: mode === "autopilot", json: true, dryRun: mode === "observe" });
    const score = result.after?.score ?? result.scan?.score ?? null;
    const issues = result.scan?.issues || [];
    const generatedFiles = result.generatedFiles || result.optimize?.generatedFiles || [];
    const findings = [];

    if (score !== null && score < 80) {
      findings.push({ type: "low-score", score, message: `Context health score is ${score}/100.` });
    }
    for (const issue of issues.slice(0, 5)) {
      findings.push({ type: "issue", severity: issue.severity, message: issue.message || issue.recommendation || issue.label });
    }

    return {
      startedAt,
      completedAt: new Date().toISOString(),
      mode,
      score,
      findings,
      generatedFiles,
      applied: mode === "autopilot",
      needsApproval: mode === "suggest" && findings.length > 0,
    };
  }

  async function reportAutoDetect(config, detectResult, options = {}) {
    const endpoint = options.detectEndpoint || `${apiBase(config)}/v1/dev/workspace/auto-detect`;
    try {
      await requestJson("POST", endpoint, config.token, detectResult, options.timeoutMs || 10000);
    } catch (_) {}
  }

  // Register an executed self-repair as a real workspace action row so the
  // backend verification loop measures it like a dashboard-queued repair.
  // Returns false when the endpoint is unavailable (older API) so the
  // caller can fall back to the auto-detect channel.
  async function registerSelfRepair(config, plannerResult, options = {}) {
    if (!plannerResult || !plannerResult.decision || !plannerResult.outcome) return false;
    const { cause, tier } = plannerResult.decision;
    const endpoint = options.selfRepairEndpoint || `${apiBase(config)}/v1/dev/workspace/actions/agent`;
    try {
      const created = await requestJson("POST", endpoint, config.token, {
        actionType: CAUSE_ACTION_TYPES[cause] || "doctor",
        command: `${NPX_COMMAND} repair ${cause}`,
        label: `Self-repair: ${cause} (${tier})`,
        targetCause: cause,
      }, options.timeoutMs || 10000);
      const actionId = created.data && created.data.id;
      if (!actionId) return false;
      await updateAction(config, actionId, {
        status: plannerResult.outcome.status,
        statusMessage: plannerResult.outcome.statusMessage,
        result: {
          executor: "repair-planner",
          targetCause: cause,
          tier,
          generatedFiles: plannerResult.outcome.generatedFiles || [],
        },
      }, options);
      return true;
    } catch {
      return false;
    }
  }

  // Fallback reporting channel for planner activity (planned-only repairs,
  // or APIs without the agent action endpoint).
  async function reportPlanner(config, plannerResult, mode, options = {}) {
    if (!plannerResult || (!plannerResult.decision && !plannerResult.executed)) return;
    const findings = [];
    if (plannerResult.decision) {
      findings.push({
        type: "self-repair",
        cause: plannerResult.decision.cause,
        tier: plannerResult.decision.tier,
        message: plannerResult.outcome && plannerResult.outcome.statusMessage
          ? plannerResult.outcome.statusMessage
          : plannerResult.decision.reason,
      });
    }
    await reportAutoDetect(config, {
      startedAt: plannerResult.generatedAt,
      completedAt: new Date().toISOString(),
      mode,
      score: null,
      findings,
      generatedFiles: plannerResult.outcome ? plannerResult.outcome.generatedFiles : [],
      applied: Boolean(plannerResult.executed),
      needsApproval: mode !== "autopilot" && Boolean(plannerResult.decision),
    }, options);
  }

  function openWorkspace(config) {
    const url = config?.workspaceUrl || DEFAULT_WORKSPACE_URL;
    if (openUrl) {
      openUrl(url);
    }
    return url;
  }

  async function reportProgress(config, actionId, step, detail, options = {}) {
    const endpoint = options.progressEndpoint || `${apiBase(config)}/v1/dev/workspace/actions/${actionId}/progress`;
    try {
      await requestJson("POST", endpoint, config.token, {
        step,
        detail: detail || null,
        timestamp: new Date().toISOString(),
      }, options.timeoutMs || 5000);
    } catch (_) {}
  }

  async function executeAction(action, rootDir, options = {}) {
    const root = repoRoot(path.resolve(rootDir || process.cwd()), action);
    const parsed = parseCommand(action.command);
    const startedAt = new Date().toISOString();
    const config = options._config || null;
    const progress = config ? (step, detail) => reportProgress(config, action.id, step, detail, options) : async () => {};

    // Cause-specific repair executors take precedence: an action that names a
    // waste cause gets a targeted repair instead of the generic command run.
    const targetCause = action.targetCause
      || (parsed.command === "repair" ? parsed.args.find((arg) => !arg.startsWith("-")) : null);
    const causeExecutor = repairExecutors ? repairExecutors.forCause(targetCause) : null;
    if (causeExecutor) {
      return causeExecutor(action, root, { progress, parsed, options });
    }

    if (parsed.command === "doctor" || action.actionType === "doctor") {
      await progress("scanning", "Scanning repo for context issues");
      const result = runDoctor(root, { limit: options.limit || 3, applySuggestions: true, json: true });
      const score = result.after?.score ?? result.scan?.score ?? null;
      const issueCount = result.scan?.issues?.length || 0;
      const generatedFiles = result.generatedFiles || result.optimize?.generatedFiles || [];
      if (issueCount > 0) await progress("fixing", `Found ${issueCount} issue${issueCount === 1 ? "" : "s"}, applying fixes`);
      await progress("done", `Score: ${score}/100, generated ${generatedFiles.length} file${generatedFiles.length === 1 ? "" : "s"}`);
      return {
        status: "completed",
        statusMessage: "Doctor completed and applied safe ignore/context fixes.",
        result: {
          command: "doctor",
          startedAt,
          completedAt: new Date().toISOString(),
          score,
          generatedFiles,
        },
      };
    }

    if (parsed.command === "sync" || action.actionType === "sync") {
      await progress("syncing", "Syncing local telemetry to workspace");
      const result = await runSync(root, { limit: options.limit || 20 });
      await progress("done", result.synced ? "Sync completed" : "Sync failed");
      return {
        status: result.synced ? "completed" : "failed",
        statusMessage: result.synced ? "Sync completed." : "Sync could not run because this machine is not connected.",
        result: {
          command: "sync",
          startedAt,
          completedAt: new Date().toISOString(),
          synced: Boolean(result.synced),
          aggregate: result.aggregate || null,
          error: result.error || null,
        },
      };
    }

    if (parsed.command === "guard" || action.actionType === "guard") {
      await progress("guarding", "Running guardrail snapshot across sessions");
      const result = await runGuard(root, {
        tool: "all",
        limit: options.limit || 5,
        tokenBudget: options.tokenBudget || 600000,
        noSync: false,
        watch: false,
      });
      const eventCount = result.events?.length || 0;
      await progress("done", `Guard complete, ${eventCount} event${eventCount === 1 ? "" : "s"} recorded`);
      return {
        status: "completed",
        statusMessage: "Guard snapshot completed. Start agent watch mode for continuous protection.",
        result: {
          command: "guard",
          startedAt,
          completedAt: new Date().toISOString(),
          guardRunning: Boolean(result.guardRunning),
          events: eventCount,
        },
      };
    }

    if (parsed.command === "context" || parsed.command === "optimize" || action.actionType === "context") {
      const scope = parsed.args.find((arg) => !arg.startsWith("-")) || null;
      await progress("generating", `Generating context pack${scope ? ` for ${scope}` : ""}`);
      const result = runOptimize(root, { scope });
      const generatedFiles = result.generatedFiles || [];
      await progress("done", `Generated ${generatedFiles.length} file${generatedFiles.length === 1 ? "" : "s"}`);
      return {
        status: "completed",
        statusMessage: "Context pack generated.",
        result: {
          command: "context",
          startedAt,
          completedAt: new Date().toISOString(),
          scope,
          generatedFiles,
        },
      };
    }

    if (parsed.command === "shield" || action.actionType === "shield") {
      const commandArgs = parseShieldArgs(parsed.args);
      if (!commandArgs) {
        await progress("rejected", "Command not on safe allowlist");
        return {
          status: "failed",
          statusMessage: "Shield action was rejected because the command is not on the safe allowlist.",
          result: { command: "shield", rejected: true, reason: "unsafe-shield-command" },
        };
      }
      await progress("shielding", `Running shielded command: ${commandArgs.join(" ")}`);
      const result = runShield(root, commandArgs);
      await progress("done", result.exitCode === 0 ? "Command completed" : "Command failed");
      return {
        status: result.exitCode === 0 ? "completed" : "failed",
        statusMessage: result.exitCode === 0 ? "Shielded command completed." : "Shielded command exited with an error.",
        result: {
          command: "shield",
          startedAt,
          completedAt: new Date().toISOString(),
          exitCode: result.exitCode,
          summary: result.summary || null,
          runDir: result.runDir || null,
        },
      };
    }

    return {
      status: "failed",
      statusMessage: `Unsupported workspace action: ${action.actionType || parsed.command || "unknown"}`,
      result: {
        rejected: true,
        reason: "unsupported-action",
        actionType: action.actionType,
        command: action.command,
      },
    };
  }

  async function runAgentOnce(rootDir = process.cwd(), options = {}) {
    const config = loadConfig();
    if (!config || !config.token) {
      return {
        schemaVersion: 1,
        command: "agent",
        connected: false,
        mode: options.mode || "autopilot",
        actionsClaimed: 0,
        actionsCompleted: 0,
        actionsFailed: 0,
        actionsObserved: 0,
        error: "not-connected",
        next: [`${NPX_COMMAND} connect --token <token>`],
      };
    }

    const mode = options.mode || "autopilot";
    const pollTime = new Date().toISOString();

    try {
      await sendHeartbeat(config, { mode, status: "online", lastPollAt: pollTime }, options);
    } catch (_) {}

    let autoDetectResult = null;
    if (options.autoDetect) {
      autoDetectResult = runAutoDetect(rootDir, { mode });
      await reportAutoDetect(config, autoDetectResult, options);
    }

    const actions = await claimActions(config, options);
    const results = [];
    for (const action of actions) {
      if (TERMINAL_STATUSES.has(action.status)) continue;

      if (mode === "observe") {
        results.push({ id: action.id, label: action.label, status: "observed", statusMessage: "Agent is in observe mode. Action not executed." });
        continue;
      }

      if (mode === "suggest") {
        await updateAction(config, action.id, {
          status: "pending_approval",
          statusMessage: "Agent recommends this action. Waiting for approval in workspace.",
        }, options);
        results.push({ id: action.id, label: action.label, status: "pending_approval", statusMessage: "Suggested; awaiting approval." });
        continue;
      }

      await updateAction(config, action.id, {
        status: "running",
        statusMessage: "Running locally through PrismoDev agent.",
      }, options);
      const result = await executeAction(action, rootDir, { ...options, _config: config });
      await updateAction(config, action.id, result, options);
      results.push({ id: action.id, label: action.label, ...result });
    }

    let plannerResult = null;
    if (options.planRepairs && repairPlanner) {
      try {
        plannerResult = await repairPlanner.runPlannerOnce(rootDir, {
          execute: mode === "autopilot",
          sessionLimit: options.plannerSessionLimit,
        });
        const registered = plannerResult.executed
          ? await registerSelfRepair(config, plannerResult, options)
          : false;
        plannerResult.registered = registered;
        if (!registered) await reportPlanner(config, plannerResult, mode, options);
      } catch (error) {
        plannerResult = { error: error && error.message ? error.message : String(error) };
      }
    }

    let syncResult = null;
    if (options.syncTelemetry) {
      try {
        const result = await runSync(rootDir, { limit: options.syncLimit || 20 });
        syncResult = {
          synced: Boolean(result.synced),
          sessions: Number(result.aggregate?.sessions || 0),
          estimatedWastedTokens: Number(result.aggregate?.estimatedWastedTokens || 0),
          wastePercent: Number(result.aggregate?.wastePercent || 0),
        };
      } catch (error) {
        syncResult = {
          synced: false,
          error: error && error.message ? error.message : String(error),
        };
      }
    }

    return {
      schemaVersion: 1,
      command: "agent",
      connected: true,
      mode,
      apiUrl: apiBase(config),
      actionsClaimed: actions.length,
      actionsCompleted: results.filter((item) => item.status === "completed").length,
      actionsFailed: results.filter((item) => item.status === "failed").length,
      actionsObserved: results.filter((item) => item.status === "observed" || item.status === "pending_approval").length,
      autoDetect: autoDetectResult,
      planner: plannerResult,
      sync: syncResult,
      results,
      privacy: {
        rawPrompts: false,
        rawCode: false,
        rawStdout: false,
        rawStderr: false,
        fileContents: false,
      },
    };
  }

  function renderAgentTerminal(result) {
    const lines = [];
    lines.push("");
    lines.push("PrismoDev Agent");
    lines.push("");
    if (!result.connected) {
      lines.push("Status: not connected");
      lines.push(`Mode: ${result.mode || "autopilot"}`);
      lines.push("");
      lines.push("Next");
      result.next.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
      return lines.join("\n");
    }
    lines.push("Status: connected");
    lines.push(`Mode: ${result.mode}`);
    lines.push(`API: ${result.apiUrl}`);
    lines.push(`Actions claimed: ${result.actionsClaimed}`);
    lines.push(`Completed: ${result.actionsCompleted}`);
    lines.push(`Failed: ${result.actionsFailed}`);
    if (result.actionsObserved > 0) {
      lines.push(`Observed/Suggested: ${result.actionsObserved}`);
    }
    if (result.autoDetect) {
      lines.push("");
      lines.push("Auto-detect");
      lines.push(`  Score: ${result.autoDetect.score ?? "unknown"}/100`);
      lines.push(`  Findings: ${result.autoDetect.findings.length}`);
      if (result.autoDetect.applied) lines.push("  Status: auto-fixed");
      else if (result.autoDetect.needsApproval) lines.push("  Status: needs approval in workspace");
      else lines.push("  Status: observed");
      if (result.autoDetect.generatedFiles.length) {
        lines.push(`  Generated: ${result.autoDetect.generatedFiles.join(", ")}`);
      }
      result.autoDetect.findings.forEach((f) => {
        lines.push(`  - ${f.message}`);
      });
    }
    if (result.planner && !result.planner.error) {
      lines.push("");
      lines.push("Self-repair");
      if (result.planner.decision) {
        lines.push(`  Cause: ${result.planner.decision.cause} (${result.planner.decision.tier} tier)`);
        lines.push(`  Why: ${result.planner.decision.reason}`);
        if (result.planner.outcome) {
          lines.push(`  Status: ${result.planner.outcome.status}`);
          if (result.planner.outcome.statusMessage) lines.push(`  ${result.planner.outcome.statusMessage}`);
        } else {
          lines.push(`  Status: planned (mode: ${result.mode}); not executed`);
        }
      } else {
        lines.push("  Nothing to repair right now.");
      }
      (result.planner.skipped || []).forEach((item) => {
        lines.push(`  Held back: ${item.cause} (${item.reason})`);
      });
    }
    if (result.sync) {
      lines.push("");
      lines.push("Sync");
      if (result.sync.synced) {
        lines.push(`  Sessions: ${result.sync.sessions}`);
        lines.push(`  Likely wasted: ${result.sync.estimatedWastedTokens.toLocaleString()} (${result.sync.wastePercent}%)`);
      } else {
        lines.push(`  Status: not synced${result.sync.error ? ` (${result.sync.error})` : ""}`);
      }
    }
    if (result.results.length) {
      lines.push("");
      lines.push("Actions");
      result.results.forEach((item) => {
        lines.push(`- ${item.status}: ${item.label}`);
        if (item.statusMessage) lines.push(`  ${item.statusMessage}`);
      });
    } else if (!result.autoDetect) {
      lines.push("");
      lines.push("No queued workspace actions.");
    }
    return lines.join("\n");
  }

  async function runAgent(rootDir = process.cwd(), options = {}) {
    if (!options.watch) return runAgentOnce(rootDir, options);

    const intervalMs = Math.max(5, Number(options.interval || 15)) * 1000;
    const syncIntervalMs = Math.max(30, Number(options.syncInterval || 60)) * 1000;
    const detectIntervalMs = Math.max(60, Number(options.detectInterval || 300)) * 1000;
    const plannerIntervalMs = Math.max(60, Number(options.plannerInterval || 600)) * 1000;
    let running = true;
    let sleepResolve = null;
    let firstRun = true;
    let lastSyncAt = 0;
    let lastDetectAt = 0;
    let lastPlanAt = 0;

    if (options.open) {
      const config = loadConfig();
      openWorkspace(config);
    }

    async function shutdown() {
      if (!running) return;
      running = false;
      if (sleepResolve) sleepResolve();
      try {
        const config = loadConfig();
        if (config?.token) {
          await sendHeartbeat(config, { mode: options.mode || "autopilot", status: "offline" }, options);
        }
      } catch (_) {}
      if (options.json) console.log(JSON.stringify({ event: "shutdown", status: "offline" }));
      else console.log("\nAgent going offline.");
    }

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    while (running) {
      const now = Date.now();
      const shouldSync = options.noSync !== true && (lastSyncAt === 0 || now - lastSyncAt >= syncIntervalMs);
      if (shouldSync) lastSyncAt = now;
      const shouldDetect = options.autoDetect !== false && (firstRun || now - lastDetectAt >= detectIntervalMs);
      if (shouldDetect) lastDetectAt = now;
      const shouldPlan = options.planRepairs !== false && (firstRun || now - lastPlanAt >= plannerIntervalMs);
      if (shouldPlan) lastPlanAt = now;
      const runOptions = {
        ...options,
        autoDetect: shouldDetect,
        planRepairs: shouldPlan,
        syncTelemetry: shouldSync,
      };
      firstRun = false;
      const result = await runAgentOnce(rootDir, runOptions);
      if (!running) break;
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(renderAgentTerminal(result));
      await new Promise((resolve) => {
        sleepResolve = resolve;
        setTimeout(resolve, intervalMs);
      });
    }

    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }

  return {
    claimActions,
    executeAction,
    openWorkspace,
    parseCommand,
    renderAgentTerminal,
    reportAutoDetect,
    reportProgress,
    runAgent,
    runAgentOnce,
    runAutoDetect,
    sendHeartbeat,
    updateAction,
    VALID_MODES,
  };
};
