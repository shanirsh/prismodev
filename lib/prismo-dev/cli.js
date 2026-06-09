const path = require("path");
const { printHelp, printCommandHelp } = require("./help");

const VALID_COMMANDS = new Set([
  "dev", "init", "doctor", "firewall", "benchmark", "shield", "mcp",
  "connect", "sync", "status", "disconnect", "agent", "connector", "setup", "scan",
  "optimize", "context", "cc", "cursor", "receipt", "instructions",
  "timeline", "replay", "boundaries", "usage", "guard", "watch", "demo", "repair",
]);

function parseTokenBudget(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  const multiplier = match[2] === "m" ? 1000000 : match[2] === "k" ? 1000 : 1;
  const parsed = Math.round(amount * multiplier);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function createCli(deps) {
  const {
    PACKAGE_VERSION,
    NPX_COMMAND,
    DEFAULT_PRISMO_PROXY_URL,
    AGENT_VALID_MODES,
    openUrl,
    printStep,
    getPositionals,
    parsePositiveInt,
    parseScopeAndTarget,
    applyFixes,
    createOptimizeContext,
    getContextFileForScope,
    renderContextCommand,
    renderStarterPrompt,
    renderOptimizeTerminal,
    runOptimize,
    renderDemoTerminal,
    renderDevTerminal,
    renderDoctorTerminal,
    renderInitTerminal,
    runDevFlow,
    runDoctor,
    runInit,
    toDoctorJsonPayload,
    renderFirewallTerminal,
    runFirewall,
    runTimelineFirewallSuggestions,
    renderShieldLastTerminal,
    renderShieldSearchTerminal,
    renderShieldTerminal,
    runShieldLast,
    runShieldSearch,
    runShield,
    renderBenchmarkTerminal,
    runBenchmark,
    renderReceiptTerminal,
    buildReceipt,
    renderConnectTerminal,
    renderDisconnectTerminal,
    renderStatusTerminal,
    renderSyncTerminal,
    runConnect,
    runDisconnect,
    runStatus,
    runSync,
    renderGuardTerminal,
    runGuard,
    REPAIR_CAUSES,
    renderRepairTerminal,
    runRepair,
    renderAgentTerminal,
    runAgent,
    renderConnectorTerminal,
    runConnectorInstall,
    runConnectorStart,
    runConnectorStatus,
    runConnectorStop,
    runConnectorUninstall,
    renderInstructionsAblationTerminal,
    renderInstructionsApplyTerminal,
    renderInstructionsAuditTerminal,
    buildInstructionsAblationPlan,
    buildInstructionsApply,
    buildInstructionsAudit,
    renderMultiSessionTimelineTerminal,
    buildMultiSessionTimeline,
    renderReplayTerminal,
    buildReplay,
    renderBoundaryTerminal,
    buildBoundaryCheck,
    renderMcpDoctorTerminal,
    runMcpDoctor,
    runMcpServer,
    renderSetupTerminal,
    runSetup,
    renderClaudeCostTerminal,
    getClaudeCodeCostSummary,
    renderCursorTerminal,
    getCursorSessionSummary,
    getUsageSummary,
    compactUsageSummary,
    renderUsageTerminal,
    watchUsage,
    scanRepo,
    toJsonPayload,
    evaluateCi,
    renderCiReport,
    renderTerminalReport,
    renderSimpleScanReport,
    renderOptimizerFitTerminal,
    renderReportCardTerminal,
    writeReport,
    formatBytes,
    formatTokenCount,
    buildMultiAgentView,
    buildBoundaryCheck: _boundaryCheck,
    buildMultiSessionTimeline: _timeline,
    buildSyncPayload,
    loadConfig,
    buildReceipt: _receipt,
    buildReplay: _replay,
    runFirewall: _firewall,
  } = deps;

  async function runCli(argv) {
    const [command, ...rest] = argv;
    if (command === "--version" || command === "-v" || command === "version") {
      console.log(PACKAGE_VERSION);
      return;
    }
    if (!command || command === "--help" || command === "-h") {
      printHelp();
      return;
    }
    if (rest.includes("--help") || rest.includes("-h")) {
      printCommandHelp(command);
      return;
    }
    if (!VALID_COMMANDS.has(command)) {
      throw new Error(`Unknown command: ${command}. Try: prismo connect, prismo connector, prismo agent, prismo guard, prismo sync, prismo doctor, prismo watch, prismo receipt, prismo benchmark, prismo shield, prismo mcp, prismo firewall, prismo init, prismo scan, prismo optimize, prismo context, prismo cc, prismo cursor, or prismo usage`);
    }

    if (command === "demo") {
      console.log(renderDemoTerminal());
      return;
    }

    if (command === "dev") {
      const json = rest.includes("--json");
      const limitIndex = rest.indexOf("--limit");
      const target = getPositionals(rest, new Set(["--limit"]))[0] || process.cwd();
      const result = runDevFlow(target, {
        json,
        limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 3),
      });
      if (json) {
        console.log(JSON.stringify({
          score: result.scan.score,
          riskLevel: result.scan.risk,
          tokenLeaks: result.scan.issues.length,
          realUsage: result.scan.realUsage,
          generatedFiles: result.optimize.generatedFiles,
          nextCommands: result.nextCommands,
          prompt: renderStarterPrompt(createOptimizeContext(result.optimize.root, result.scope), result.scope),
          scannedPath: result.scan.root,
          generatedAt: result.scan.generatedAt,
        }, null, 2));
        return;
      }
      console.log(renderDevTerminal(result));
      return;
    }

    if (command === "init") {
      const json = rest.includes("--json");
      const target = getPositionals(rest)[0] || process.cwd();
      const result = runInit(target, { dryRun: rest.includes("--dry-run") });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(renderInitTerminal(result));
      return;
    }

    if (command === "doctor") {
      const json = rest.includes("--json");
      const limitIndex = rest.indexOf("--limit");
      const { scope, target } = parseScopeAndTarget(rest, new Set(["--limit"]));
      const result = runDoctor(target, {
        json,
        limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 3),
        scope,
        dryRun: rest.includes("--dry-run"),
        applyIgnoresOnly: rest.includes("--apply-ignores-only"),
        applySuggestions: rest.includes("--apply-suggestions"),
        noContextPacks: rest.includes("--no-context-packs"),
      });
      if (json) {
        console.log(JSON.stringify(toDoctorJsonPayload(result), null, 2));
        return;
      }
      console.log(renderDoctorTerminal(result));
      return;
    }

    if (command === "firewall") {
      const json = rest.includes("--json");
      const { scope, target } = parseScopeAndTarget(rest);
      const result = runFirewall(target, {
        task: scope || "general",
        scope,
        dryRun: rest.includes("--dry-run"),
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(renderFirewallTerminal(result));
      return;
    }

    if (command === "benchmark") {
      const json = rest.includes("--json");
      const limitIndex = rest.indexOf("--limit");
      const separatorIndex = rest.indexOf("--");
      const beforeSeparator = separatorIndex >= 0 ? rest.slice(0, separatorIndex) : rest;
      const commandArgs = separatorIndex >= 0 ? rest.slice(separatorIndex + 1) : [];
      const positional = getPositionals(beforeSeparator, new Set(["--limit"]));
      const sessionOnly = positional[0] === "session" || commandArgs.length === 0;
      const target = positional[0] === "session" ? positional[1] || process.cwd() : positional[0] || process.cwd();
      const result = runBenchmark(target, commandArgs, {
        sessionOnly,
        limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5),
      });
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(renderBenchmarkTerminal(result));
      if (result.mode === "command") process.exitCode = result.exitCode;
      return;
    }

    if (command === "shield") {
      const json = rest.includes("--json");
      const limitIndex = rest.indexOf("--limit");
      const limit = parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5);
      const positional = getPositionals(rest, new Set(["--limit"]));
      if (positional[0] === "last") {
        const target = positional[1] || process.cwd();
        const result = runShieldLast(target, { limit });
        if (json) console.log(JSON.stringify(result, null, 2));
        else console.log(renderShieldLastTerminal(result));
        return;
      }
      if (positional[0] === "search") {
        const query = positional[1];
        const target = positional[2] || process.cwd();
        const result = runShieldSearch(target, query, { limit });
        if (json) console.log(JSON.stringify(result, null, 2));
        else console.log(renderShieldSearchTerminal(result));
        return;
      }
      const separatorIndex = rest.indexOf("--");
      const beforeSeparator = separatorIndex >= 0 ? rest.slice(0, separatorIndex) : [];
      const commandArgs = separatorIndex >= 0 ? rest.slice(separatorIndex + 1) : getPositionals(rest);
      const target = getPositionals(beforeSeparator)[0] || process.cwd();
      const result = runShield(target, commandArgs);
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(renderShieldTerminal(result));
      }
      process.exitCode = result.exitCode;
      return;
    }

    if (command === "mcp") {
      const json = rest.includes("--json");
      const positional = getPositionals(rest);
      const subcommand = positional[0] === "doctor" ? "doctor" : "server";
      const target = subcommand === "doctor" ? positional[1] || process.cwd() : positional[0] || process.cwd();
      const mcpDeps = {
        rootDir: path.resolve(target),
        packageVersion: PACKAGE_VERSION,
        scanRepo,
        toJsonPayload,
        runDoctor,
        toDoctorJsonPayload,
        getUsageSummary,
        getClaudeCodeCostSummary,
        getCursorSessionSummary,
        buildBoundaryCheck,
        buildInstructionsAblationPlan,
        buildInstructionsAudit,
        buildMultiSessionTimeline,
        buildReceipt,
        buildReplay,
        runOptimize,
        createOptimizeContext,
        renderStarterPrompt,
        runFirewall,
        runShield,
        runShieldLast,
        runShieldSearch,
      };
      if (subcommand === "doctor") {
        const result = await runMcpDoctor(mcpDeps);
        if (json) console.log(JSON.stringify(result, null, 2));
        else console.log(renderMcpDoctorTerminal(result));
        return;
      }
      runMcpServer(mcpDeps);
      return;
    }

    if (command === "connect") {
      const json = rest.includes("--json");
      const tokenIndex = rest.indexOf("--token");
      const apiUrlIndex = rest.indexOf("--api-url");
      const orgIndex = rest.indexOf("--org");
      const userIndex = rest.indexOf("--user");
      const deviceIndex = rest.indexOf("--device");
      const limitIndex = rest.indexOf("--limit");
      const intervalIndex = rest.indexOf("--interval");
      const syncIntervalIndex = rest.indexOf("--sync-interval");
      const modeIndex = rest.indexOf("--mode");
      const modeValue = modeIndex >= 0 ? rest[modeIndex + 1] : "autopilot";
      if (!AGENT_VALID_MODES.has(modeValue)) {
        throw new Error(`Invalid connector mode: ${modeValue}. Valid modes: observe, suggest, autopilot`);
      }
      const positional = getPositionals(rest, new Set(["--token", "--api-url", "--org", "--user", "--device", "--limit", "--interval", "--sync-interval", "--mode"]));
      const target = positional[0] || process.cwd();
      const result = runConnect({
        token: tokenIndex >= 0 ? rest[tokenIndex + 1] : null,
        apiUrl: apiUrlIndex >= 0 ? rest[apiUrlIndex + 1] : null,
        org: orgIndex >= 0 ? rest[orgIndex + 1] : null,
        user: userIndex >= 0 ? rest[userIndex + 1] : null,
        device: deviceIndex >= 0 ? rest[deviceIndex + 1] : null,
        limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 20),
      });
      if (result.connected && !rest.includes("--no-agent") && runConnectorInstall) {
        result.connector = runConnectorInstall(target, {
          interval: parsePositiveInt(intervalIndex >= 0 ? rest[intervalIndex + 1] : null, 15),
          syncInterval: parsePositiveInt(syncIntervalIndex >= 0 ? rest[syncIntervalIndex + 1] : null, 60),
          mode: modeValue,
          dryRun: rest.includes("--dry-run"),
        });
        result.next = result.connector?.started
          ? [`${NPX_COMMAND} status`]
          : [`${NPX_COMMAND} connector install`, `${NPX_COMMAND} status`];
      }
      if (result.connected && (rest.includes("--open") || !rest.includes("--no-open"))) {
        openUrl("https://getprismo.dev/dashboard/dev");
      }
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(renderConnectTerminal(result));
      return;
    }

    if (command === "connector") {
      const json = rest.includes("--json");
      const intervalIndex = rest.indexOf("--interval");
      const syncIntervalIndex = rest.indexOf("--sync-interval");
      const modeIndex = rest.indexOf("--mode");
      const modeValue = modeIndex >= 0 ? rest[modeIndex + 1] : "autopilot";
      if (!AGENT_VALID_MODES.has(modeValue)) {
        throw new Error(`Invalid connector mode: ${modeValue}. Valid modes: observe, suggest, autopilot`);
      }
      const positional = getPositionals(rest, new Set(["--interval", "--sync-interval", "--mode"]));
      const action = ["install", "start", "stop", "status", "uninstall"].includes(positional[0]) ? positional[0] : "status";
      const target = ["install"].includes(action) ? positional[1] || process.cwd() : positional[0] || process.cwd();
      let result;
      if (action === "install") {
        result = runConnectorInstall(target, {
          interval: parsePositiveInt(intervalIndex >= 0 ? rest[intervalIndex + 1] : null, 15),
          syncInterval: parsePositiveInt(syncIntervalIndex >= 0 ? rest[syncIntervalIndex + 1] : null, 60),
          mode: modeValue,
          dryRun: rest.includes("--dry-run"),
        });
      } else if (action === "start") {
        result = runConnectorStart({ dryRun: rest.includes("--dry-run") });
      } else if (action === "stop") {
        result = runConnectorStop({ dryRun: rest.includes("--dry-run") });
      } else if (action === "uninstall") {
        result = runConnectorUninstall({ dryRun: rest.includes("--dry-run") });
      } else {
        result = runConnectorStatus();
      }
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(renderConnectorTerminal(result));
      return;
    }

    if (command === "sync") {
      const json = rest.includes("--json");
      const limitIndex = rest.indexOf("--limit");
      const toolIndex = rest.indexOf("--tool");
      const apiUrlIndex = rest.indexOf("--api-url");
      const intervalIndex = rest.indexOf("--interval");
      const positional = getPositionals(rest, new Set(["--limit", "--tool", "--api-url", "--interval"]));
      const target = positional[0] || process.cwd();
      const syncOptions = {
        dryRun: rest.includes("--dry-run") || rest.includes("--preview"),
        preview: rest.includes("--preview"),
        limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 20),
        tool: toolIndex >= 0 ? rest[toolIndex + 1] : "all",
        endpoint: apiUrlIndex >= 0 ? `${String(rest[apiUrlIndex + 1] || "").replace(/\/$/, "")}/v1/dev/sessions/sync` : null,
      };
      if (rest.includes("--watch")) {
        const intervalMs = parsePositiveInt(intervalIndex >= 0 ? rest[intervalIndex + 1] : null, 60) * 1000;
        while (true) {
          const result = await runSync(target, syncOptions);
          if (json) console.log(JSON.stringify(result, null, 2));
          else console.log(renderSyncTerminal(result));
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }
      const result = await runSync(target, syncOptions);
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(renderSyncTerminal(result));
      return;
    }

    if (command === "agent") {
      const json = rest.includes("--json");
      const intervalIndex = rest.indexOf("--interval");
      const syncIntervalIndex = rest.indexOf("--sync-interval");
      const detectIntervalIndex = rest.indexOf("--detect-interval");
      const limitIndex = rest.indexOf("--limit");
      const budgetIndex = rest.indexOf("--budget");
      const modeIndex = rest.indexOf("--mode");
      const modeValue = modeIndex >= 0 ? rest[modeIndex + 1] : "autopilot";
      if (!AGENT_VALID_MODES.has(modeValue)) {
        throw new Error(`Invalid agent mode: ${modeValue}. Valid modes: observe, suggest, autopilot`);
      }
      const positional = getPositionals(rest, new Set(["--interval", "--sync-interval", "--detect-interval", "--limit", "--budget", "--mode"]));
      const target = positional[0] || process.cwd();
      const agentOptions = {
        json,
        mode: modeValue,
        watch: rest.includes("--watch") && !rest.includes("--once"),
        open: rest.includes("--open"),
        autoDetect: !rest.includes("--no-detect"),
        noSync: rest.includes("--no-sync"),
        interval: parsePositiveInt(intervalIndex >= 0 ? rest[intervalIndex + 1] : null, 15),
        syncInterval: parsePositiveInt(syncIntervalIndex >= 0 ? rest[syncIntervalIndex + 1] : null, 60),
        detectInterval: parsePositiveInt(detectIntervalIndex >= 0 ? rest[detectIntervalIndex + 1] : null, 300),
        limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5),
        syncLimit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 20),
        tokenBudget: parseTokenBudget(budgetIndex >= 0 ? rest[budgetIndex + 1] : null) || 600000,
      };
      const result = await runAgent(target, agentOptions);
      if (!agentOptions.watch) {
        if (json) console.log(JSON.stringify(result, null, 2));
        else console.log(renderAgentTerminal(result));
      }
      return;
    }

    if (command === "status") {
      const json = rest.includes("--json");
      const result = runStatus();
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(renderStatusTerminal(result));
      return;
    }

    if (command === "disconnect") {
      const json = rest.includes("--json");
      const result = runDisconnect();
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(renderDisconnectTerminal(result));
      return;
    }

    if (command === "setup") {
      const json = rest.includes("--json");
      const limitIndex = rest.indexOf("--limit");
      const proxyIndex = rest.indexOf("--proxy-url");
      const target = getPositionals(rest, new Set(["--limit", "--proxy-url"]))[0] || process.cwd();
      const result = await runSetup(target, {
        limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 3),
        proxyUrl: proxyIndex >= 0 ? rest[proxyIndex + 1] : DEFAULT_PRISMO_PROXY_URL,
        skipProxyCheck: rest.includes("--skip-proxy-check"),
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(renderSetupTerminal(result));
      return;
    }

    if (command === "cc") {
      const json = rest.includes("--json");
      const limitIndex = rest.indexOf("--limit");
      const firewall = rest.includes("--firewall");
      const taskIndex = rest.indexOf("--task");
      const firewallTask = taskIndex >= 0 && rest[taskIndex + 1] && !rest[taskIndex + 1].startsWith("-")
        ? rest[taskIndex + 1]
        : "timeline-followup";
      const ccArgs = rest.filter((_, index) => {
        if (index === rest.indexOf("--firewall")) return false;
        if (taskIndex >= 0 && (index === taskIndex || index === taskIndex + 1)) return false;
        return true;
      });
      const positional = getPositionals(ccArgs, new Set(["--limit"]));
      const subcommand = positional[0] && ["list", "last", "all", "timeline"].includes(positional[0].toLowerCase()) ? positional[0].toLowerCase() : "latest";
      const lastCount = subcommand === "last" ? parsePositiveInt(positional[1], 5) : null;
      const limit = subcommand === "list"
        ? parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 10)
        : subcommand === "last"
          ? lastCount
          : 1;
      const targetIndex = subcommand === "last" ? 2 : subcommand === "latest" ? 0 : 1;
      const hasTarget = Boolean(positional[targetIndex]);
      const target = hasTarget ? positional[targetIndex] : process.cwd();
      const summary = getClaudeCodeCostSummary({
        cwd: path.resolve(target),
        limit,
        all: subcommand === "all",
        allProjects: !hasTarget,
        mode: subcommand,
      });
      if (json) {
        if (subcommand === "timeline") {
          const latest = summary.sessions[0] || null;
          const firewallSuggestions = firewall && latest
            ? runTimelineFirewallSuggestions(path.resolve(target), latest, { task: firewallTask, dryRun: false })
            : null;
          console.log(JSON.stringify({
            schemaVersion: 1,
            generatedAt: summary.generatedAt,
            scannedPath: summary.scannedPath,
            command: "cc timeline",
            session: latest
              ? {
                  sessionId: latest.sessionId,
                  model: latest.model || latest.cost?.model || null,
                  updatedAt: latest.updatedAt,
                  risk: latest.contextRisk,
                  turns: latest.turns,
                  toolCalls: latest.toolCalls,
                }
              : null,
            timeline: latest ? latest.timeline || [] : [],
            firewallSuggestions,
            suggestedAction: latest?.prismo?.recommendations?.[0] || `${NPX_COMMAND} doctor`,
          }, null, 2));
          return;
        }
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      const output = [renderClaudeCostTerminal(summary)];
      if (subcommand === "timeline" && firewall) {
        const latest = summary.sessions[0] || null;
        if (latest) {
          const suggestions = runTimelineFirewallSuggestions(path.resolve(target), latest, { task: firewallTask, dryRun: false });
          output.push("");
          output.push("Timeline Firewall Suggestions");
          output.push(`Wrote: ${suggestions.generatedFiles.join(", ")}`);
          output.push(`Session-derived allowed: ${suggestions.sessionAllowed.length}`);
          output.push(`Session-derived blocked: ${suggestions.sessionBlocked.length}`);
          output.push("Tell your agent: Use .prismo/context-firewall.suggested.md for the next scoped session.");
        }
      }
      console.log(output.join("\n"));
      return;
    }

    if (command === "cursor") {
      const json = rest.includes("--json");
      const limitIndex = rest.indexOf("--limit");
      const positional = getPositionals(rest, new Set(["--limit"]));
      const subcommand = positional[0] && ["list", "authorship", "timeline", "files", "all"].includes(positional[0].toLowerCase())
        ? positional[0].toLowerCase()
        : "latest";
      const target = (subcommand !== "latest" ? positional[1] : positional[0]) || process.cwd();
      const limit = parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, subcommand === "all" ? 200 : 20);
      const summary = getCursorSessionSummary({
        cwd: path.resolve(target),
        limit,
        mode: subcommand,
      });
      if (json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      console.log(renderCursorTerminal(summary, subcommand));
      return;
    }

    if (command === "receipt") {
      const json = rest.includes("--json");
      const knownTools = new Set(["codex", "claude", "cursor", "all"]);
      const positional = getPositionals(rest, new Set(["--limit"]));
      const explicitTool = positional[0] && knownTools.has(positional[0].toLowerCase());
      const tool = explicitTool ? positional[0].toLowerCase() : "all";
      const target = explicitTool ? positional[1] || process.cwd() : positional[0] || process.cwd();
      const limitIndex = rest.indexOf("--limit");
      const receipt = buildReceipt({
        cwd: path.resolve(target),
        tool,
        limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5),
      });
      if (json) {
        console.log(JSON.stringify(receipt, null, 2));
        return;
      }
      console.log(renderReceiptTerminal(receipt));
      return;
    }

    if (command === "instructions") {
      const json = rest.includes("--json");
      const limitIndex = rest.indexOf("--limit");
      const samplesIndex = rest.indexOf("--samples");
      const positional = getPositionals(rest, new Set(["--limit", "--samples"]));
      const subcommand = ["audit", "ablate", "apply"].includes(positional[0]?.toLowerCase()) ? positional[0].toLowerCase() : "audit";
      const target = ["audit", "ablate", "apply"].includes(positional[0]?.toLowerCase())
        ? positional[1] || process.cwd()
        : positional[0] || process.cwd();
      if (subcommand === "ablate") {
        const plan = buildInstructionsAblationPlan({
          cwd: path.resolve(target),
          limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 20),
          samples: parsePositiveInt(samplesIndex >= 0 ? rest[samplesIndex + 1] : null, 10),
        });
        if (json) {
          console.log(JSON.stringify(plan, null, 2));
          return;
        }
        console.log(renderInstructionsAblationTerminal(plan));
        return;
      }
      if (subcommand === "apply") {
        const result = buildInstructionsApply({
          cwd: path.resolve(target),
          limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 20),
          dryRun: rest.includes("--dry-run"),
        });
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(renderInstructionsApplyTerminal(result));
        return;
      }
      const audit = buildInstructionsAudit({
        cwd: path.resolve(target),
        limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 20),
      });
      if (json) {
        console.log(JSON.stringify(audit, null, 2));
        return;
      }
      console.log(renderInstructionsAuditTerminal(audit));
      return;
    }

    if (command === "timeline") {
      const json = rest.includes("--json");
      const knownTools = new Set(["codex", "claude", "cursor", "all"]);
      const positional = getPositionals(rest, new Set(["--last", "--limit"]));
      const explicitTool = positional[0] && knownTools.has(positional[0].toLowerCase());
      const tool = explicitTool ? positional[0].toLowerCase() : "all";
      const target = explicitTool ? positional[1] || process.cwd() : positional[0] || process.cwd();
      const lastIndex = rest.indexOf("--last");
      const limitIndex = rest.indexOf("--limit");
      const limitValue = lastIndex >= 0 ? rest[lastIndex + 1] : limitIndex >= 0 ? rest[limitIndex + 1] : null;
      const timeline = buildMultiSessionTimeline({
        cwd: path.resolve(target),
        tool,
        limit: parsePositiveInt(limitValue, 20),
      });
      if (json) {
        console.log(JSON.stringify(timeline, null, 2));
        return;
      }
      console.log(renderMultiSessionTimelineTerminal(timeline));
      return;
    }

    if (command === "replay") {
      const json = rest.includes("--json");
      const knownTools = new Set(["codex", "claude", "cursor", "all"]);
      const positional = getPositionals(rest, new Set(["--limit"]));
      const explicitTool = positional[0] && knownTools.has(positional[0].toLowerCase());
      const tool = explicitTool ? positional[0].toLowerCase() : "all";
      const target = explicitTool ? positional[1] || process.cwd() : positional[0] || process.cwd();
      const limitIndex = rest.indexOf("--limit");
      const replay = buildReplay({
        cwd: path.resolve(target),
        tool,
        limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5),
      });
      if (json) {
        console.log(JSON.stringify(replay, null, 2));
        return;
      }
      console.log(renderReplayTerminal(replay));
      return;
    }

    if (command === "boundaries") {
      const json = rest.includes("--json");
      const knownTools = new Set(["codex", "claude", "cursor", "all"]);
      const positional = getPositionals(rest, new Set(["--limit"]));
      const explicitTool = positional[0] && knownTools.has(positional[0].toLowerCase());
      const tool = explicitTool ? positional[0].toLowerCase() : "all";
      const target = explicitTool ? positional[1] || process.cwd() : positional[0] || process.cwd();
      const limitIndex = rest.indexOf("--limit");
      const check = buildBoundaryCheck({
        cwd: path.resolve(target),
        tool,
        limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 10),
      });
      if (json) {
        console.log(JSON.stringify(check, null, 2));
        return;
      }
      console.log(renderBoundaryTerminal(check));
      return;
    }

    if (command === "guard") {
      const json = rest.includes("--json");
      const knownTools = new Set(["codex", "claude", "cursor", "all"]);
      const positional = getPositionals(rest, new Set(["--limit", "--interval", "--budget", "--api-url"]));
      const explicitTool = positional[0] && knownTools.has(positional[0].toLowerCase());
      const tool = explicitTool ? positional[0].toLowerCase() : "all";
      const target = explicitTool ? positional[1] || process.cwd() : positional[0] || process.cwd();
      const limitIndex = rest.indexOf("--limit");
      const intervalIndex = rest.indexOf("--interval");
      const budgetIndex = rest.indexOf("--budget");
      const apiUrlIndex = rest.indexOf("--api-url");
      const guardOptions = {
        tool,
        limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5),
        tokenBudget: parseTokenBudget(budgetIndex >= 0 ? rest[budgetIndex + 1] : null) || 600000,
        dryRun: rest.includes("--dry-run") || rest.includes("--preview"),
        noSync: rest.includes("--no-sync"),
        watch: rest.includes("--watch") && !rest.includes("--once"),
        endpoint: apiUrlIndex >= 0 ? `${String(rest[apiUrlIndex + 1] || "").replace(/\/$/, "")}/v1/dev/guardrails/sync` : null,
      };
      if (guardOptions.watch) {
        const intervalMs = parsePositiveInt(intervalIndex >= 0 ? rest[intervalIndex + 1] : null, 60) * 1000;
        while (true) {
          const result = await runGuard(target, guardOptions);
          if (json) console.log(JSON.stringify(result, null, 2));
          else console.log(renderGuardTerminal(result));
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }
      const result = await runGuard(target, guardOptions);
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(renderGuardTerminal(result));
      return;
    }

    if (command === "repair") {
      const json = rest.includes("--json");
      const separatorIndex = rest.indexOf("--");
      const ownArgs = separatorIndex >= 0 ? rest.slice(0, separatorIndex) : rest;
      const commandArgs = separatorIndex >= 0 ? rest.slice(separatorIndex + 1) : [];
      const positional = getPositionals(ownArgs, new Set(["--limit", "--budget", "--scope"]));
      const cause = (positional[0] || "").toLowerCase();
      const target = positional[1] || process.cwd();
      const limitIndex = ownArgs.indexOf("--limit");
      const budgetIndex = ownArgs.indexOf("--budget");
      const scopeIndex = ownArgs.indexOf("--scope");
      const result = await runRepair(target, cause, {
        limit: parsePositiveInt(limitIndex >= 0 ? ownArgs[limitIndex + 1] : null, 5),
        tokenBudget: parseTokenBudget(budgetIndex >= 0 ? ownArgs[budgetIndex + 1] : null),
        scope: scopeIndex >= 0 ? ownArgs[scopeIndex + 1] : null,
        commandArgs,
      });
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(renderRepairTerminal(result));
      if (result.status === "failed") process.exitCode = 1;
      return;
    }

    if (command === "usage" || command === "watch") {
      const json = rest.includes("--json");
      const knownTools = new Set(["codex", "claude", "cursor", "all"]);
      const positional = getPositionals(rest, new Set(["--limit", "--interval", "--budget"]));
      const explicitTool = positional[0] && knownTools.has(positional[0].toLowerCase());
      const tool = explicitTool ? positional[0].toLowerCase() : "all";
      const target = explicitTool ? positional[1] || process.cwd() : positional[0] || process.cwd();
      const limitIndex = rest.indexOf("--limit");
      const intervalIndex = rest.indexOf("--interval");
      const budgetIndex = rest.indexOf("--budget");
      const auto = rest.includes("--auto");
      const noEvents = rest.includes("--no-events");
      const limit = parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5);
      const intervalMs = parsePositiveInt(intervalIndex >= 0 ? rest[intervalIndex + 1] : null, 3) * 1000;
      const tokenBudget = parseTokenBudget(budgetIndex >= 0 ? rest[budgetIndex + 1] : null) || (auto ? 600000 : null);
      const usageOptions = {
        tool,
        cwd: path.resolve(target),
        limit,
        tokenBudget,
        auto,
        agents: rest.includes("--agents"),
        json,
        once: rest.includes("--once"),
        report: rest.includes("--report"),
        rescue: rest.includes("--rescue"),
        guardrails: auto || rest.includes("--guardrails"),
        throttle: auto || rest.includes("--throttle"),
        events: (auto && !noEvents) || rest.includes("--events"),
        noEvents,
        updateFirewall: auto ? (summary) => {
          const live = summary.live;
          if (!live || live.liveAction.cause === "healthy" || live.liveAction.cause === "no-active-session") return null;
          return runFirewall(summary.scannedPath || target, {
            task: live.liveAction.cause,
            dryRun: false,
            live: true,
          });
        } : null,
        redactPaths: rest.includes("--redact-paths"),
        intervalMs,
      };

      if (command === "watch") {
        await watchUsage(usageOptions);
        return;
      }

      const summary = getUsageSummary(usageOptions);
      if (json) {
        console.log(JSON.stringify(compactUsageSummary(summary), null, 2));
        return;
      }
      console.log(renderUsageTerminal(summary));
      return;
    }

    if (command === "context") {
      const json = rest.includes("--json");
      const { scope, target } = parseScopeAndTarget(rest);
      const ctx = createOptimizeContext(target, scope);
      const prompt = renderStarterPrompt(ctx, scope);
      const output = renderContextCommand(ctx, scope);
      if (json) {
        console.log(JSON.stringify({
          scope,
          prompt,
          contextFile: getContextFileForScope(ctx, scope),
          supportingFiles: [
            !scope && ctx.backendDetected ? ".prismo/backend-summary.md" : null,
            !scope && ctx.frontendDetected ? ".prismo/frontend-summary.md" : null,
            scope === "frontend" ? ".prismo/frontend-summary.md" : null,
            scope === "backend" ? ".prismo/backend-summary.md" : null,
          ].filter(Boolean),
          scannedPath: ctx.root,
          generatedAt: ctx.generatedAt,
        }, null, 2));
        return;
      }
      console.log(output);
      return;
    }

    if (command === "optimize") {
      const json = rest.includes("--json");
      const { scope, target } = parseScopeAndTarget(rest);
      const result = runOptimize(target, { scope });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(renderOptimizeTerminal(result));
      return;
    }

    const fix = rest.includes("--fix");
    const noReport = rest.includes("--no-report");
    const json = rest.includes("--json");
    const simple = rest.includes("--simple");
    const optimizerFit = rest.includes("--optimizer-fit");
    const reportCard = rest.includes("--report-card");
    const ciMode = rest.includes("--ci");
    const includeUsage = rest.includes("--usage") || optimizerFit || reportCard;
    const limitIndex = rest.indexOf("--limit");
    const usageToolIndex = rest.indexOf("--usage-tool");
    const target = getPositionals(rest, new Set(["--limit", "--usage-tool"]))[0] || process.cwd();
    const scanDone = printStep(includeUsage ? "Scanning repo and local usage" : "Scanning repo", json || simple || optimizerFit || reportCard);
    const result = scanRepo(target, {
      includeUsage,
      usageLimit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5),
      usageTool: usageToolIndex >= 0 ? rest[usageToolIndex + 1] : "all",
    });
    scanDone();

    if (json) {
      let fixActions = [];
      let report = null;
      if (fix) {
        fixActions = applyFixes(result);
      } else if (!noReport && !optimizerFit) {
        report = writeReport(result);
      }
      const payload = toJsonPayload(result);
      if (ciMode) {
        payload.ci = evaluateCi(result);
        if (!payload.ci.passed) process.exitCode = 1;
      }
      if (optimizerFit || reportCard) {
        console.log(JSON.stringify({
          schemaVersion: 1,
          scannedPath: result.root,
          score: result.score,
          riskLevel: result.risk,
          optimizerFit: result.optimizerFit,
          reportCard: reportCard ? {
            biggestWaste: result.optimizerFit.summary,
            startWith: result.optimizerFit.recommendedStack[0]?.command || null,
            then: result.optimizerFit.recommendedStack[1]?.command || null,
            roundTripRisk: result.optimizerFit.roundTripContext.level,
          } : undefined,
          generatedAt: result.generatedAt,
        }, null, 2));
        return;
      }
      if (fixActions.length) payload.fixActions = fixActions;
      if (report) payload.reportPath = report.reportPath;
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    if (reportCard) {
      console.log(renderReportCardTerminal(result));
    } else if (optimizerFit) {
      console.log(renderOptimizerFitTerminal(result));
    } else if (simple) {
      console.log(renderSimpleScanReport(result));
    } else if (ciMode) {
      const ci = evaluateCi(result);
      console.log(renderCiReport(result, ci));
      if (!ci.passed) process.exitCode = 1;
    } else {
      console.log(renderTerminalReport(result, { reportEnabled: !noReport || fix }));
    }

    if (fix) {
      const actions = applyFixes(result);
      console.log("\nFix Mode:");
      actions.forEach((action) => console.log(`- ${action}`));
    } else if (!noReport && !simple && !optimizerFit && !reportCard) {
      const report = writeReport(result);
      if (report.backupPath) {
        console.log(`\nExisting report backed up to ${path.basename(report.backupPath)}.`);
      }
    }
  }

  return { runCli, parseTokenBudget };
}

module.exports = createCli;
