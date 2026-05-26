module.exports = function createBoundaries(deps) {
  const {
    NPX_COMMAND,
    buildMultiAgentView,
    getUsageSummary,
  } = deps;

  function buildBoundaryCheck(options = {}) {
    const cwd = options.cwd || process.cwd();
    const limit = options.limit || 10;
    const tool = options.tool || "all";
    const usage = getUsageSummary({ cwd, limit, tool });
    const multiAgent = buildMultiAgentView(usage);
    const sameWorktree = (usage.sessions || []).length >= 2;
    const sharedFiles = multiAgent.sharedFiles || [];
    const sharedArtifacts = multiAgent.sharedArtifacts || [];
    const noisyAgents = (multiAgent.agents || []).filter((agent) => ["tool-output-flood", "possible-loop"].includes(agent.liveAction?.cause));
    const highPressureAgents = (multiAgent.agents || []).filter((agent) => agent.contextPressure === "High");
    const score = Math.max(0, 100
      - Math.min(35, sharedFiles.length * 12)
      - Math.min(30, sharedArtifacts.length * 10)
      - Math.min(25, noisyAgents.length * 10)
      - Math.min(25, highPressureAgents.length * 10)
      - (sameWorktree && multiAgent.agentCount >= 3 ? 10 : 0));
    const risk =
      score < 50 ? "High" :
        score < 75 ? "Medium" :
          "Low";
    const recommendations = [];
    if (sameWorktree && multiAgent.agentCount >= 2) recommendations.push("Run parallel agents in separate worktrees or strict task scopes when possible.");
    if (sharedFiles.length) recommendations.push(`Assign file ownership before continuing: ${sharedFiles.slice(0, 3).map((item) => item.path).join(", ")}.`);
    if (sharedArtifacts.length) recommendations.push(`Add/verify ignore coverage for shared artifacts: ${sharedArtifacts.slice(0, 3).map((item) => item.type).join(", ")}.`);
    if (noisyAgents.length) recommendations.push(`Route noisy commands through ${NPX_COMMAND} shield -- <command>.`);
    if (highPressureAgents.length) recommendations.push("Ask high-pressure agents for handoff summaries, then restart scoped sessions.");
    if (!recommendations.length) recommendations.push("Boundaries look acceptable; keep agents scoped to separate tasks/files.");

    return {
      schemaVersion: 1,
      command: "boundaries",
      generatedAt: new Date().toISOString(),
      scannedPath: cwd,
      tool,
      sessionsAnalyzed: usage.sessions.length,
      agentCount: multiAgent.agentCount,
      boundaryScore: score,
      risk,
      sameWorktree,
      agents: multiAgent.agents,
      sharedFiles,
      sharedArtifacts,
      coordinationWarnings: multiAgent.coordinationWarnings,
      recommendations,
    };
  }

  function renderBoundaryTerminal(check) {
    const lines = [];
    lines.push("");
    lines.push("Prismo Agent Boundary Check");
    lines.push("");
    lines.push(`Agents visible: ${check.agentCount}`);
    lines.push(`Boundary score: ${check.boundaryScore}/100 (${check.risk} risk)`);
    lines.push(`Same worktree signal: ${check.sameWorktree ? "yes" : "no"}`);
    lines.push("");
    lines.push("Coordination Warnings");
    if (check.coordinationWarnings.length) check.coordinationWarnings.forEach((warning) => lines.push(`- ${warning}`));
    else lines.push("- None detected.");
    lines.push("");
    lines.push("Shared Files");
    if (check.sharedFiles.length) check.sharedFiles.slice(0, 5).forEach((item) => lines.push(`- ${item.path} (${item.owners.length} agents)`));
    else lines.push("- None detected.");
    lines.push("");
    lines.push("Shared Artifacts");
    if (check.sharedArtifacts.length) check.sharedArtifacts.slice(0, 5).forEach((item) => lines.push(`- ${item.type} (${item.owners.length} agents)`));
    else lines.push("- None detected.");
    lines.push("");
    lines.push("Next");
    check.recommendations.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    return lines.join("\n");
  }

  return {
    buildBoundaryCheck,
    renderBoundaryTerminal,
  };
};
