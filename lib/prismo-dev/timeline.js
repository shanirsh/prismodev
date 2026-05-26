module.exports = function createTimeline(deps) {
  const {
    fs,
    path,
    GENERATED_ARTIFACT_PATTERNS,
    NPX_COMMAND,
    formatTokenCount,
    getUsageSummary,
    readIfText,
  } = deps;

  const {
    getActionableRepeatedPaths,
    summarizeGeneratedArtifacts,
  } = require("./usage-log-utils")({
    fs,
    path,
    GENERATED_ARTIFACT_PATTERNS,
    readIfText,
  });

  function bump(map, key, count = 1, sessionId = null) {
    if (!key) return;
    const item = map.get(key) || { value: key, count: 0, sessions: new Set() };
    item.count += Number(count || 0);
    if (sessionId) item.sessions.add(sessionId);
    map.set(key, item);
  }

  function sortedMap(map, limit = 10) {
    return Array.from(map.values())
      .map((item) => ({
        value: item.value,
        count: item.count,
        sessions: item.sessions.size,
      }))
      .sort((a, b) => b.sessions - a.sessions || b.count - a.count)
      .slice(0, limit);
  }

  function buildMultiSessionTimeline(options = {}) {
    const cwd = options.cwd || process.cwd();
    const limit = options.limit || 20;
    const tool = options.tool || "all";
    const usage = getUsageSummary({ cwd, limit, tool });
    const sessions = usage.sessions || [];
    const artifactMap = new Map();
    const fileMap = new Map();
    const commandMap = new Map();
    const events = [];
    let highRiskSessions = 0;
    let toolFloodSessions = 0;
    let loopSessions = 0;
    let totalToolOutputTokens = 0;

    for (const session of sessions) {
      const sessionId = session.sessionId || session.updatedAt || "unknown";
      if (session.contextRisk === "High") highRiskSessions += 1;
      if ((session.estimatedToolTokens || 0) >= 75000) toolFloodSessions += 1;
      if (session.loopSuspicion) loopSessions += 1;
      totalToolOutputTokens += Number(session.estimatedToolTokens || 0);

      for (const group of summarizeGeneratedArtifacts(session.generatedArtifacts || [], 10)) {
        bump(artifactMap, group.type, group.count, sessionId);
      }
      for (const item of getActionableRepeatedPaths(session, 10)) {
        bump(fileMap, item.value, item.count, sessionId);
      }
      for (const item of session.repeatedCommands || []) {
        bump(commandMap, item.value, item.count, sessionId);
      }

      if (session.contextRisk === "High") {
        events.push({
          timestamp: session.updatedAt || null,
          sessionId,
          tool: session.tool,
          type: "high-context-pressure",
          detail: `${formatTokenCount(session.displayTokens || session.contextTokens)} tokens`,
        });
      }
      if ((session.estimatedToolTokens || 0) >= 75000) {
        events.push({
          timestamp: session.updatedAt || null,
          sessionId,
          tool: session.tool,
          type: "tool-output-flood",
          detail: `${formatTokenCount(session.estimatedToolTokens)} tool/output tokens`,
        });
      }
      if (session.loopSuspicion) {
        events.push({
          timestamp: session.updatedAt || null,
          sessionId,
          tool: session.tool,
          type: "possible-loop",
          detail: `${session.repeatedCommands?.[0]?.value || "command"} repeated`,
        });
      }
    }

    const repeatedArtifacts = sortedMap(artifactMap, 10);
    const repeatedFiles = sortedMap(fileMap, 10);
    const repeatedCommands = sortedMap(commandMap, 10);
    const recommendations = [];
    if (repeatedArtifacts.length) recommendations.push(`Add/verify ignore coverage for ${repeatedArtifacts.slice(0, 3).map((item) => item.value).join(", ")}.`);
    if (toolFloodSessions) recommendations.push(`Route noisy commands through ${NPX_COMMAND} shield -- <command>.`);
    if (repeatedFiles.length) recommendations.push(`Use ${NPX_COMMAND} firewall <task> to start sessions with narrower read boundaries.`);
    if (highRiskSessions >= 2) recommendations.push("Split future work earlier; multiple recent sessions reached high context pressure.");
    if (loopSessions) recommendations.push(`Use ${NPX_COMMAND} watch --rescue when loops appear.`);
    if (!recommendations.length) recommendations.push("No recurring multi-session waste pattern detected yet.");

    return {
      schemaVersion: 1,
      command: "timeline",
      generatedAt: new Date().toISOString(),
      scannedPath: cwd,
      tool,
      sessionsAnalyzed: sessions.length,
      confidence: usage.confidence,
      sources: usage.sources || [],
      summary: {
        highRiskSessions,
        toolFloodSessions,
        loopSessions,
        totalToolOutputTokens,
      },
      repeatedArtifacts,
      repeatedFiles,
      repeatedCommands,
      events: events.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0)).slice(-50),
      recommendations,
    };
  }

  function renderMultiSessionTimelineTerminal(timeline) {
    const lines = [];
    lines.push("");
    lines.push("Prismo Multi-Session Timeline");
    lines.push("");
    lines.push(`Sessions analyzed: ${timeline.sessionsAnalyzed}`);
    lines.push(`Sources: ${timeline.sources.join(", ") || "none"}`);
    lines.push(`High-risk sessions: ${timeline.summary.highRiskSessions}`);
    lines.push(`Tool-output flood sessions: ${timeline.summary.toolFloodSessions}`);
    lines.push(`Possible loop sessions: ${timeline.summary.loopSessions}`);
    lines.push(`Total tool/output tokens: ${formatTokenCount(timeline.summary.totalToolOutputTokens)}`);
    lines.push("");
    lines.push("Recurring Artifacts");
    if (timeline.repeatedArtifacts.length) {
      timeline.repeatedArtifacts.slice(0, 5).forEach((item) => lines.push(`- ${item.value}: ${item.count} mentions across ${item.sessions} session(s)`));
    } else {
      lines.push("- None detected.");
    }
    lines.push("");
    lines.push("Recurring Repeated Files");
    if (timeline.repeatedFiles.length) {
      timeline.repeatedFiles.slice(0, 5).forEach((item) => lines.push(`- ${item.value}: ${item.count} mentions across ${item.sessions} session(s)`));
    } else {
      lines.push("- None detected.");
    }
    lines.push("");
    lines.push("Recurring Commands");
    if (timeline.repeatedCommands.length) {
      timeline.repeatedCommands.slice(0, 5).forEach((item) => lines.push(`- ${item.value}: ${item.count} mentions across ${item.sessions} session(s)`));
    } else {
      lines.push("- None detected.");
    }
    lines.push("");
    lines.push("Recent Events");
    if (timeline.events.length) {
      timeline.events.slice(-8).forEach((event) => lines.push(`- ${event.timestamp || "unknown"} ${event.type}: ${event.detail}`));
    } else {
      lines.push("- No high-signal events detected.");
    }
    lines.push("");
    lines.push("Next");
    timeline.recommendations.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    return lines.join("\n");
  }

  return {
    buildMultiSessionTimeline,
    renderMultiSessionTimelineTerminal,
  };
};
