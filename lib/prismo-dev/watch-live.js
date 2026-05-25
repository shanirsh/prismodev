module.exports = function createWatchLive(deps) {
  const {
    NPX_COMMAND,
    formatTokenCount,
    getActionableRepeatedPaths,
    summarizeGeneratedArtifacts,
  } = deps;

  function getRiskRank(risk) {
    return { High: 3, Medium: 2, Low: 1 }[risk] || 0;
  }

  function getTopToolNames(session, limit = 4) {
    return Object.entries(session && session.toolNames ? session.toolNames : {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count]) => ({ name, count }));
  }

  function getContextPressure(activeSession, warnings = []) {
    if (!activeSession) return "Low";
    const highSignals = [
      activeSession.contextRisk === "High",
      activeSession.recentContextGrowth >= 250000,
      activeSession.estimatedToolTokens >= 150000,
      activeSession.loopSuspicion,
      warnings.some((warning) => warning.includes("exceeded the live token budget")),
      warnings.length >= 4,
    ].filter(Boolean).length;
    if (highSignals) return "High";
    const mediumSignals = [
      activeSession.contextRisk === "Medium",
      activeSession.recentContextGrowth >= 60000,
      activeSession.estimatedToolTokens >= 50000,
      (activeSession.repeatedPathMentions || []).length > 0,
      (activeSession.generatedArtifacts || []).length > 0,
      activeSession.turns >= 20,
    ].filter(Boolean).length;
    return mediumSignals ? "Medium" : "Low";
  }

  function getTokenBudgetStatus(activeSession, tokenBudget) {
    const budget = Number(tokenBudget || 0);
    if (!activeSession || !Number.isFinite(budget) || budget <= 0) return null;
    const used = Number(activeSession.displayTokens || activeSession.tokens || 0);
    const percent = budget > 0 ? Math.round((used / budget) * 100) : 0;
    return {
      budget,
      used,
      remaining: Math.max(0, budget - used),
      overBy: Math.max(0, used - budget),
      percent,
      nearLimit: percent >= 80 && percent < 100,
      exceeded: used >= budget,
    };
  }

  function buildLiveWarnings(activeSession, summary) {
    const warnings = [];
    if (!activeSession) {
      warnings.push("No active local session detected for this repo yet.");
      return warnings;
    }
    const budgetStatus = getTokenBudgetStatus(activeSession, summary.tokenBudget);
    if (budgetStatus?.exceeded) {
      warnings.push(`Session exceeded the live token budget by about ${formatTokenCount(budgetStatus.overBy)} tokens.`);
    } else if (budgetStatus?.nearLimit) {
      warnings.push(`Session is near the live token budget (${budgetStatus.percent}% used).`);
    }
    if (activeSession.contextRisk === "High") {
      warnings.push("Context risk is high; consider starting a fresh session at the next task boundary.");
    } else if (activeSession.contextRisk === "Medium") {
      warnings.push("Context risk is rising; keep reads and shell output narrow.");
    }
    if (activeSession.estimatedToolTokens >= 150000) {
      warnings.push("Tool/output tokens are dominating this session; summarize logs and test output before loading more.");
    } else if (activeSession.estimatedToolTokens >= 50000) {
      warnings.push("Tool/output tokens are elevated; prefer targeted commands and smaller file reads.");
    }
    if (activeSession.recentContextGrowth >= 250000) {
      warnings.push(`Context jumped by about ${formatTokenCount(activeSession.recentContextGrowth)} tokens recently.`);
    } else if (activeSession.recentContextGrowth >= 60000) {
      warnings.push(`Recent context growth is about ${formatTokenCount(activeSession.recentContextGrowth)} tokens.`);
    }
    for (const item of getActionableRepeatedPaths(activeSession, 2)) {
      warnings.push(`${item.value} appears repeatedly in context (${item.count}x).`);
    }
    for (const group of summarizeGeneratedArtifacts(activeSession.generatedArtifacts || [], 2)) {
      warnings.push(`${group.type} likely entered active context (${group.count} mentions; e.g. ${group.examples[0]}).`);
    }
    if (activeSession.loopSuspicion) {
      const command = activeSession.repeatedCommands?.[0]?.value;
      warnings.push(command ? `Possible repeated command loop (${activeSession.loopConfidence} confidence) around "${command}".` : `Possible repeated tool loop (${activeSession.loopConfidence} confidence).`);
    }
    if (activeSession.turns >= 30) {
      warnings.push("Long session detected; split unrelated follow-up work into a new session.");
    }
    if (!activeSession.exactAvailable) {
      warnings.push("Exact token fields were not found; usage is estimated from local session text.");
    }
    if (summary.totals.displayTokens >= 1000000) {
      warnings.push("Recent local usage is above 1M tokens; prioritize the largest session for cleanup.");
    }
    return Array.from(new Set(warnings)).slice(0, 5);
  }

  function getRecommendedWatchAction(activeSession, warnings) {
    if (!activeSession) return `${NPX_COMMAND} setup`;
    if (activeSession.estimatedToolTokens >= 150000 || activeSession.loopSuspicion) return `${NPX_COMMAND} shield -- <noisy command>`;
    if ((activeSession.generatedArtifacts || []).length || getActionableRepeatedPaths(activeSession, 1).length) return `${NPX_COMMAND} doctor`;
    if (activeSession.recentContextGrowth >= 250000) return "Start a fresh coding-agent session with a scoped Prismo context prompt.";
    if (warnings.some((warning) => warning.includes("Tool/output"))) return `${NPX_COMMAND} context`;
    if (activeSession.contextRisk === "High") return "Start a fresh coding-agent session before the next unrelated task.";
    if (activeSession.turns >= 20) return `${NPX_COMMAND} optimize`;
    return `${NPX_COMMAND} scan --usage`;
  }

  function buildShieldPlan(activeSession, liveAction) {
    if (!activeSession || !liveAction) return null;
    const shieldCauses = new Set(["tool-output-flood", "possible-loop"]);
    const hasRepeatedCommand = Boolean(activeSession.repeatedCommands?.[0]);
    const highToolOutput = activeSession.estimatedToolTokens >= 150000;
    if (!shieldCauses.has(liveAction.cause) && !hasRepeatedCommand && !highToolOutput) return null;

    const repeatedCommand = activeSession.repeatedCommands?.[0]?.value || null;
    const cliCommand = repeatedCommand
      ? `${NPX_COMMAND} shield -- ${repeatedCommand}`
      : `${NPX_COMMAND} shield -- <noisy command>`;
    const searchHint = liveAction.cause === "possible-loop"
      ? "Search the stored output for the stable error text before rerunning the command."
      : "Search the stored output for the failure token, filename, or exception instead of loading the full log.";

    return {
      reason: liveAction.cause === "possible-loop"
        ? "Repeated command/output loop detected; shield the command and search stored output before reruns."
        : "Tool output is flooding context; shield the command so full logs stay local.",
      command: cliCommand,
      commandTemplate: `${NPX_COMMAND} shield -- <command>`,
      searchCommand: `${NPX_COMMAND} shield search "<error text>"`,
      mcp: {
        runTool: "prismo_shield_run",
        searchTool: "prismo_shield_search",
        workflow: "Call prismo_shield_run with the noisy command, then prismo_shield_search for the relevant error text.",
      },
      next: [
        repeatedCommand ? `Run the command through shield: ${cliCommand}` : `Run the noisy command through shield: ${cliCommand}`,
        searchHint,
        "Give the agent the compact shield summary first; inspect full stdout/stderr only if needed.",
      ],
    };
  }

  function buildLiveAction(activeSession, warnings, budgetStatus = null) {
    if (!activeSession) {
      return {
        cause: "no-active-session",
        confidence: "low",
        summary: "No matching live coding-agent session is visible yet.",
        now: [
          "Start Codex or Claude Code from this repo.",
          `Run ${NPX_COMMAND} watch --once after the first tool call.`,
        ],
        rescueAvailable: false,
        rescueCommand: null,
      };
    }

    if (budgetStatus?.exceeded) {
      return {
        cause: "token-budget-exceeded",
        confidence: "high",
        summary: `Session crossed the live token budget (${formatTokenCount(budgetStatus.used)} used / ${formatTokenCount(budgetStatus.budget)} budget).`,
        now: [
          "Stop broad exploration and finish only the current smallest step.",
          "Ask the agent for a compact state summary before any more file reads.",
          "Start a fresh scoped session for the next task boundary.",
        ],
        rescueAvailable: true,
        rescueCommand: `${NPX_COMMAND} watch --rescue`,
      };
    }

    if (activeSession.loopSuspicion) {
      const command = activeSession.repeatedCommands?.[0];
      return {
        cause: "possible-loop",
        confidence: activeSession.loopConfidence || "medium",
        summary: command
          ? `Repeated command loop around "${command.value}" (${command.count}x).`
          : "Repeated tool loop likely.",
        now: [
          "Stop rerunning the same command.",
          "Ask the agent to summarize the exact failure, changed files, and next smallest fix.",
          "Start a fresh scoped session if the summary is longer than one screen.",
        ],
        rescueAvailable: true,
        rescueCommand: `${NPX_COMMAND} watch --rescue`,
      };
    }

    if (activeSession.estimatedToolTokens >= 150000) {
      return {
        cause: "tool-output-flood",
        confidence: "high",
        summary: `Tool/output tokens are dominating this session (${formatTokenCount(activeSession.estimatedToolTokens)} tokens).`,
        now: [
          "Stop loading full logs or broad command output.",
          "Rerun failing commands with tight filters or short ranges.",
          "Ask the agent to summarize current errors before reading more files.",
        ],
        rescueAvailable: true,
        rescueCommand: `${NPX_COMMAND} watch --rescue`,
      };
    }

    const artifactGroup = summarizeGeneratedArtifacts(activeSession.generatedArtifacts || [], 1)[0];
    if (artifactGroup) {
      return {
        cause: "artifact-leak",
        confidence: "high",
        summary: `${artifactGroup.type} entered active context (${artifactGroup.count} mentions).`,
        now: [
          `Add or verify ignore coverage with ${NPX_COMMAND} doctor.`,
          "Tell the agent not to read generated artifacts, lockfiles, caches, build output, or coverage.",
          "Continue from the smallest relevant source files only.",
        ],
        rescueAvailable: true,
        rescueCommand: `${NPX_COMMAND} watch --rescue`,
      };
    }

    const repeatedPath = getActionableRepeatedPaths(activeSession, 1)[0];
    if (repeatedPath) {
      return {
        cause: "repeated-file-read",
        confidence: repeatedPath.count >= 20 ? "high" : "medium",
        summary: `${repeatedPath.value} is repeatedly entering context (${repeatedPath.count}x).`,
        now: [
          "Ask the agent to summarize what it learned from that file.",
          "Stop re-reading it unless a new edit changed it.",
          "Move to the next smallest relevant file or test.",
        ],
        rescueAvailable: true,
        rescueCommand: `${NPX_COMMAND} watch --rescue`,
      };
    }

    if (activeSession.recentContextGrowth >= 250000) {
      return {
        cause: "context-spike",
        confidence: "high",
        summary: `Context jumped by about ${formatTokenCount(activeSession.recentContextGrowth)} tokens.`,
        now: [
          "Pause broad exploration.",
          "Ask for a compact state summary.",
          "Start a fresh session with a scoped context prompt.",
        ],
        rescueAvailable: true,
        rescueCommand: `${NPX_COMMAND} watch --rescue`,
      };
    }

    if (activeSession.contextRisk === "High") {
      return {
        cause: "high-context-pressure",
        confidence: "medium",
        summary: "This session is carrying high context pressure.",
        now: [
          "Finish the current small step only.",
          "Start a fresh session at the next task boundary.",
          `Use ${NPX_COMMAND} context for a scoped restart prompt.`,
        ],
        rescueAvailable: true,
        rescueCommand: `${NPX_COMMAND} watch --rescue`,
      };
    }

    return {
      cause: warnings.length ? "context-pressure" : "healthy",
      confidence: warnings.length ? "medium" : "low",
      summary: warnings.length ? warnings[0] : "No major live waste signal detected.",
      now: warnings.length
        ? ["Keep file reads narrow.", "Avoid broad logs and generated artifacts.", "Continue watching for spikes."]
        : ["Keep working.", "Use scoped reads and concise command output.", "Run watch again after major tool calls."],
      rescueAvailable: warnings.length > 0,
      rescueCommand: warnings.length ? `${NPX_COMMAND} watch --rescue` : null,
    };
  }

  function buildLiveSessionView(summary) {
    const activeSession = summary.sessions[0] || null;
    const warnings = buildLiveWarnings(activeSession, summary);
    const contextPressure = getContextPressure(activeSession, warnings);
    const budgetStatus = getTokenBudgetStatus(activeSession, summary.tokenBudget);
    const topTools = getTopToolNames(activeSession);
    const largestTextBlobs = activeSession ? activeSession.largestTextBlobs || [] : [];
    const actionableRepeatedPaths = activeSession ? getActionableRepeatedPaths(activeSession, 5) : [];
    const generatedArtifactGroups = activeSession ? summarizeGeneratedArtifacts(activeSession.generatedArtifacts || [], 5) : [];
    const liveAction = buildLiveAction(activeSession, warnings, budgetStatus);
    const shieldPlan = buildShieldPlan(activeSession, liveAction);
    return {
      activeSession: activeSession
        ? {
            tool: activeSession.tool,
            sessionId: activeSession.sessionId,
            title: activeSession.title,
            model: activeSession.model,
            cwd: activeSession.cwd,
            updatedAt: activeSession.updatedAt,
            tokens: activeSession.displayTokens,
            contextTokens: activeSession.contextTokens,
            exactAvailable: activeSession.exactAvailable,
            confidence: activeSession.confidence,
            contextRisk: activeSession.contextRisk,
            turns: activeSession.turns,
            toolCalls: activeSession.toolCalls,
            toolResults: activeSession.toolResults,
            estimatedToolTokens: activeSession.estimatedToolTokens,
            recentContextGrowth: activeSession.recentContextGrowth || 0,
            repeatedPathMentions: activeSession.repeatedPathMentions || [],
            actionableRepeatedPaths,
            generatedArtifacts: activeSession.generatedArtifacts || [],
            generatedArtifactGroups,
            repeatedCommands: activeSession.repeatedCommands || [],
            loopSuspicion: Boolean(activeSession.loopSuspicion),
            loopConfidence: activeSession.loopConfidence || "low",
            topTools,
            largestTextBlobs,
          }
        : null,
      contextPressure,
      highestRisk: summary.sessions.reduce((risk, session) => (getRiskRank(session.contextRisk) > getRiskRank(risk) ? session.contextRisk : risk), "Low"),
      budget: budgetStatus,
      warnings,
      liveAction: {
        ...liveAction,
        shieldPlan,
      },
      recommendedAction: getRecommendedWatchAction(activeSession, warnings),
      nextCommands: Array.from(new Set([
        `${NPX_COMMAND} doctor`,
        `${NPX_COMMAND} context`,
        `${NPX_COMMAND} optimize`,
      ])).slice(0, 3),
    };
  }

  function agentLabel(session, index) {
    const tool = session.tool === "claude-code" ? "claude" : session.tool || "agent";
    const id = String(session.sessionId || index + 1).slice(0, 8);
    return `${tool}-${id}`;
  }

  function buildMultiAgentView(summary) {
    const agents = (summary.sessions || []).map((session, index) => {
      const singleSummary = {
        ...summary,
        sessions: [session],
        totals: {
          sessions: 1,
          displayTokens: session.displayTokens || 0,
          contextTokens: session.contextTokens || 0,
          estimatedTokens: session.estimatedTotalTokens || 0,
          exactTokens: session.exactAvailable ? session.exactTotalTokens || 0 : 0,
          toolTokens: session.estimatedToolTokens || 0,
        },
      };
      const live = buildLiveSessionView(singleSummary);
      return {
        label: agentLabel(session, index),
        tool: session.tool,
        sessionId: session.sessionId,
        title: session.title,
        model: session.model,
        updatedAt: session.updatedAt,
        contextPressure: live.contextPressure,
        tokens: session.displayTokens || 0,
        contextTokens: session.contextTokens || 0,
        toolOutputTokens: session.estimatedToolTokens || 0,
        turns: session.turns || 0,
        toolCalls: session.toolCalls || 0,
        liveAction: live.liveAction,
        warnings: live.warnings,
        repeatedFiles: live.activeSession?.actionableRepeatedPaths || [],
        artifactGroups: live.activeSession?.generatedArtifactGroups || [],
        repeatedCommands: session.repeatedCommands || [],
      };
    });

    const warnings = [];
    const highPressureAgents = agents.filter((agent) => agent.contextPressure === "High");
    if (highPressureAgents.length >= 2) {
      warnings.push(`${highPressureAgents.length} agents are under high context pressure; pause broad exploration and split work by task boundary.`);
    }
    const noisyAgents = agents.filter((agent) => ["tool-output-flood", "possible-loop"].includes(agent.liveAction?.cause));
    if (noisyAgents.length) {
      warnings.push(`${noisyAgents.length} agent${noisyAgents.length === 1 ? "" : "s"} should route noisy commands through shield before rerunning.`);
    }

    const fileOwners = new Map();
    for (const agent of agents) {
      for (const item of agent.repeatedFiles || []) {
        const owners = fileOwners.get(item.value) || [];
        owners.push({ agent: agent.label, count: item.count });
        fileOwners.set(item.value, owners);
      }
    }
    const sharedFiles = Array.from(fileOwners.entries())
      .filter(([, owners]) => owners.length >= 2)
      .map(([path, owners]) => ({ path, owners }))
      .slice(0, 5);
    for (const item of sharedFiles.slice(0, 3)) {
      warnings.push(`${item.path} is repeatedly entering context across ${item.owners.length} agents.`);
    }

    const artifactOwners = new Map();
    for (const agent of agents) {
      for (const group of agent.artifactGroups || []) {
        const owners = artifactOwners.get(group.type) || [];
        owners.push({ agent: agent.label, count: group.count, example: group.examples?.[0] || null });
        artifactOwners.set(group.type, owners);
      }
    }
    const sharedArtifacts = Array.from(artifactOwners.entries())
      .filter(([, owners]) => owners.length >= 2)
      .map(([type, owners]) => ({ type, owners }))
      .slice(0, 5);
    for (const item of sharedArtifacts.slice(0, 2)) {
      warnings.push(`${item.type} artifacts appear across ${item.owners.length} agents; add/verify ignore coverage before continuing.`);
    }

    const recommendedActions = [];
    if (noisyAgents.length) recommendedActions.push(`${NPX_COMMAND} shield -- <noisy command>`);
    if (sharedFiles.length || sharedArtifacts.length) recommendedActions.push(`${NPX_COMMAND} doctor --apply-suggestions --dry-run`);
    if (highPressureAgents.length) recommendedActions.push("Ask each high-pressure agent for a compact handoff summary, then restart scoped sessions.");
    if (!recommendedActions.length) recommendedActions.push("Keep agents scoped to separate files/tasks and continue watching.");

    return {
      enabled: true,
      agentCount: agents.length,
      agents,
      highestPressure: agents.reduce((pressure, agent) => (getRiskRank(agent.contextPressure) > getRiskRank(pressure) ? agent.contextPressure : pressure), "Low"),
      coordinationWarnings: Array.from(new Set(warnings)).slice(0, 8),
      sharedFiles,
      sharedArtifacts,
      recommendedActions: Array.from(new Set(recommendedActions)).slice(0, 5),
    };
  }

  return {
    buildLiveSessionView,
    buildMultiAgentView,
    getRiskRank,
    getTokenBudgetStatus,
  };
};
