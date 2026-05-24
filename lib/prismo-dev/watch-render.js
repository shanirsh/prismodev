module.exports = function createWatchRender(deps) {
  const {
    NPX_COMMAND,
    buildLiveSessionView,
    color,
    formatTokenCount,
    getActionableRepeatedPaths,
    summarizeGeneratedArtifacts,
  } = deps;

function renderUsageTerminal(summary, title = "Prismo Usage") {
  const lines = [];
  lines.push("");
  lines.push(title);
  lines.push("");
  lines.push(`Tool scope: ${summary.tool}`);
  lines.push(`Sessions shown: ${summary.sessions.length}`);
  lines.push(`Total displayed tokens: ${formatTokenCount(summary.totals.displayTokens)}`);
  if (summary.totals.exactTokens) lines.push(`Exact local-log tokens: ${formatTokenCount(summary.totals.exactTokens)}`);
  if (summary.totals.toolTokens) lines.push(`Estimated tool/output tokens: ${formatTokenCount(summary.totals.toolTokens)}`);
  lines.push(`Confidence: ${summary.confidence}`);
  lines.push("");
  lines.push("Recent Sessions:");
  if (!summary.sessions.length) {
    lines.push("- No local sessions detected.");
  } else {
    summary.sessions.forEach((session, index) => {
      lines.push(`${index + 1}. ${session.tool} - ${session.title || session.sessionId}`);
      lines.push(`   tokens: ${formatTokenCount(session.displayTokens)} (${session.confidence}), risk: ${session.contextRisk}, turns: ${session.turns}, tools: ${session.toolCalls}`);
      if (session.model) lines.push(`   model: ${session.model}`);
      if (session.cwd) lines.push(`   cwd: ${session.cwd}`);
    });
  }
  lines.push("");
  lines.push("Notes: exact means the local tool log exposed token fields. Estimated means Prismo used local text size heuristics only.");
  return lines.join("\n");
}
function renderWatchTerminal(summary) {
  const live = summary.live || buildLiveSessionView(summary);
  const active = live.activeSession;
  const lines = [];
  const pressureTone = live.contextPressure === "High" ? "red" : live.contextPressure === "Medium" ? "yellow" : "green";
  lines.push("");
  lines.push(color("Prismo Watch", "bold"));
  lines.push("");
  if (!active) {
    lines.push("Context Pressure: Low");
    lines.push("- No local Codex/Claude Code session detected for this repo yet.");
    lines.push("");
    lines.push("Suggested Action");
    lines.push(`Run: ${live.recommendedAction}`);
    lines.push("");
    lines.push("Tip: start Codex or Claude Code in this repo, then keep this watch open.");
    return lines.join("\n");
  }
  lines.push(`Context Pressure: ${color(live.contextPressure.toUpperCase(), pressureTone)}`);
  lines.push(`Session Size: ${formatTokenCount(active.tokens)} tokens (${active.confidence})`);
  if (live.budget) {
    const budgetTone = live.budget.exceeded ? "red" : live.budget.nearLimit ? "yellow" : "green";
    lines.push(`Token Budget: ${color(`${live.budget.percent}%`, budgetTone)} of ${formatTokenCount(live.budget.budget)}`);
  }
  lines.push(`Recent Growth: +${formatTokenCount(active.recentContextGrowth || 0)} tokens`);
  lines.push(`Tool Output: ${formatTokenCount(active.estimatedToolTokens)} tokens`);
  lines.push(`Turns: ${active.turns}  |  Tool calls: ${active.toolCalls}`);
  lines.push(`Source: ${active.tool}`);
  if (active.contextTokens && active.contextTokens !== active.tokens) lines.push(`Context tokens observed: ${formatTokenCount(active.contextTokens)}`);
  if (active.model) lines.push(`Model: ${active.model}`);
  if (active.updatedAt) lines.push(`Updated: ${active.updatedAt}`);
  lines.push("");
  lines.push("Warnings");
  if (live.warnings.length) live.warnings.slice(0, 6).forEach((warning) => lines.push(`- ${warning}`));
  else lines.push("- No major context-pressure signals detected.");
  lines.push("");
  lines.push("Do This Now");
  lines.push(`Cause: ${live.liveAction.cause} (${live.liveAction.confidence} confidence)`);
  lines.push(live.liveAction.summary);
  live.liveAction.now.slice(0, 4).forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  if (live.liveAction.rescueAvailable) lines.push(`Rescue: ${live.liveAction.rescueCommand}`);
  if (live.liveAction.shieldPlan) {
    lines.push("");
    lines.push("Shield Plan");
    lines.push(live.liveAction.shieldPlan.reason);
    lines.push(`Run: ${live.liveAction.shieldPlan.command}`);
    lines.push(`Then: ${live.liveAction.shieldPlan.searchCommand}`);
    lines.push(`MCP: ${live.liveAction.shieldPlan.mcp.runTool} -> ${live.liveAction.shieldPlan.mcp.searchTool}`);
  }
  lines.push("");
  if (active.actionableRepeatedPaths?.length || active.generatedArtifactGroups?.length || active.repeatedCommands.length) {
    lines.push("Signals");
    (active.actionableRepeatedPaths || []).slice(0, 3).forEach((item) => lines.push(`- Repeated file: ${item.value} (${item.count}x)`));
    (active.generatedArtifactGroups || []).slice(0, 3).forEach((group) => lines.push(`- Generated artifacts: ${group.type} (${group.count} mentions; e.g. ${group.examples[0]})`));
    active.repeatedCommands.slice(0, 2).forEach((item) => lines.push(`- Repeated command: ${item.value} (${item.count}x${active.loopSuspicion ? `, ${active.loopConfidence} loop confidence` : ""})`));
    lines.push("");
  }
  if (active.largestTextBlobs.length) {
    lines.push("Largest Context Sources");
    active.largestTextBlobs.slice(0, 3).forEach((blob) => lines.push(`- ${blob.label}: ~${blob.tokens.toLocaleString()} tokens`));
    lines.push("");
  }
  lines.push("Suggested Action");
  lines.push(`Run: ${live.recommendedAction}`);
  lines.push("");
  lines.push("Useful Commands");
  live.nextCommands.forEach((command) => lines.push(`- ${command}`));
  lines.push("");
  lines.push("Signals are local estimates from available coding-agent logs. Prismo uses likely/suspicious language when log visibility is limited.");
  lines.push("Expected project instruction files are muted unless they combine with stronger context-pressure signals.");
  return lines.join("\n");
}
function renderRescuePrompt(summary) {
  const live = summary.live || buildLiveSessionView(summary);
  const active = live.activeSession;
  const lines = [];
  lines.push("Prismo Rescue Prompt");
  lines.push("");
  if (!active) {
    lines.push("No active local Codex/Claude Code session was found for this repo.");
    lines.push("");
    lines.push("Start a coding-agent session from the repo root, then rerun:");
    lines.push(`${NPX_COMMAND} watch --rescue`);
    return lines.join("\n");
  }

  lines.push("Paste this into the current AI coding session:");
  lines.push("");
  lines.push("```text");
  lines.push("We are in a high-context AI coding session. Stop broad exploration and recover state before doing more work.");
  lines.push("");
  lines.push(`Current Prismo signal: ${live.liveAction.cause} (${live.liveAction.confidence} confidence).`);
  lines.push(`Summary: ${live.liveAction.summary}`);
  lines.push(`Context pressure: ${live.contextPressure}. Session size: ${formatTokenCount(active.tokens)} tokens. Tool output: ${formatTokenCount(active.estimatedToolTokens)} tokens.`);
  if (active.recentContextGrowth) lines.push(`Recent context growth: +${formatTokenCount(active.recentContextGrowth)} tokens.`);
  lines.push("");
  lines.push("Do this now:");
  live.liveAction.now.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  if (live.liveAction.shieldPlan) {
    lines.push("");
    lines.push("For noisy commands, use Prismo shield instead of loading full output into this chat:");
    lines.push(`- CLI: ${live.liveAction.shieldPlan.command}`);
    lines.push(`- Search stored output: ${live.liveAction.shieldPlan.searchCommand}`);
    lines.push(`- MCP workflow: ${live.liveAction.shieldPlan.mcp.workflow}`);
  }
  lines.push("");
  lines.push("Before reading or editing anything else, summarize:");
  lines.push("- files changed so far");
  lines.push("- exact failing command or error");
  lines.push("- current hypothesis");
  lines.push("- next smallest file/test to inspect");
  lines.push("");
  const repeated = active.actionableRepeatedPaths || [];
  if (repeated.length) {
    lines.push("Do not re-read these files unless they changed:");
    repeated.slice(0, 5).forEach((item) => lines.push(`- ${item.value} (${item.count}x already)`));
    lines.push("");
  }
  const groups = active.generatedArtifactGroups || [];
  lines.push("Do not read generated/noisy artifacts unless explicitly required:");
  const avoids = groups.length
    ? groups.map((group) => `${group.type}${group.examples?.[0] ? `, e.g. ${group.examples[0]}` : ""}`)
    : ["node_modules/", ".next/", "dist/", "build/", "coverage/", "package-lock.json", "logs/"];
  avoids.slice(0, 8).forEach((item) => lines.push(`- ${item}`));
  lines.push("");
  lines.push("Keep the next response under 20 lines unless a code diff is required.");
  lines.push("```");
  return lines.join("\n");
}
function renderLiveGuardrails(summary) {
  const live = summary.live || buildLiveSessionView(summary);
  const active = live.activeSession;
  const lines = [];
  lines.push("# Prismo Live Guardrails");
  lines.push("");
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Context pressure: ${live.contextPressure}`);
  lines.push(`Current issue: ${live.liveAction.cause}`);
  lines.push(`Confidence: ${live.liveAction.confidence}`);
  lines.push("");
  lines.push("## Effective Immediately");
  lines.push("");
  live.liveAction.now.forEach((step) => lines.push(`- ${step}`));
  if (live.liveAction.shieldPlan) {
    lines.push(`- Run noisy commands through Prismo shield: \`${live.liveAction.shieldPlan.command}\`.`);
    lines.push(`- Search stored command output with: \`${live.liveAction.shieldPlan.searchCommand}\`.`);
    lines.push(`- If MCP tools are available, use \`${live.liveAction.shieldPlan.mcp.runTool}\` then \`${live.liveAction.shieldPlan.mcp.searchTool}\`.`);
  }
  lines.push("- Keep command output short; prefer filtered errors, small ranges, and summaries over full logs.");
  lines.push("- Do not read generated artifacts, lockfiles, caches, build output, coverage, or logs unless explicitly required.");
  lines.push("- Before broad exploration, summarize the current task, changed files, current failure, and next smallest useful file/test.");
  if (active) {
    lines.push("");
    lines.push("## Current Session");
    lines.push("");
    lines.push(`- Tool: ${active.tool}`);
    lines.push(`- Session size: ${formatTokenCount(active.tokens)} tokens`);
    lines.push(`- Tool/output tokens: ${formatTokenCount(active.estimatedToolTokens)}`);
    lines.push(`- Turns: ${active.turns}`);
    if (active.recentContextGrowth) lines.push(`- Recent context growth: +${formatTokenCount(active.recentContextGrowth)} tokens`);
    const repeated = active.actionableRepeatedPaths || [];
    if (repeated.length) {
      lines.push("");
      lines.push("## Do Not Re-Read Unless Changed");
      lines.push("");
      repeated.slice(0, 8).forEach((item) => lines.push(`- ${item.value} (${item.count}x already)`));
    }
    const groups = active.generatedArtifactGroups || [];
    if (groups.length) {
      lines.push("");
      lines.push("## Noisy Artifacts To Avoid");
      lines.push("");
      groups.slice(0, 8).forEach((group) => {
        lines.push(`- ${group.type}${group.examples?.[0] ? `, e.g. ${group.examples[0]}` : ""}`);
      });
    }
  } else {
    lines.push("");
    lines.push("No active local session was detected for this repo yet. Keep this file referenced once the coding-agent session starts.");
  }
  lines.push("");
  lines.push("## Agent Instruction");
  lines.push("");
  lines.push("Follow this file during the current session. If it changes, adapt immediately before reading more files or running more tools.");
  lines.push("");
  return lines.join("\n");
}
function renderContextThrottle(summary) {
  const live = summary.live || buildLiveSessionView(summary);
  const active = live.activeSession;
  const budget = live.budget;
  const lines = [];
  lines.push("# Prismo Live Context Throttle");
  lines.push("");
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Mode: ${budget?.exceeded ? "hard-throttle" : budget?.nearLimit ? "soft-throttle" : live.contextPressure === "High" ? "pressure-throttle" : "watch"}`);
  lines.push(`Context pressure: ${live.contextPressure}`);
  lines.push(`Current issue: ${live.liveAction.cause}`);
  if (budget) {
    lines.push(`Token budget: ${formatTokenCount(budget.budget)}`);
    lines.push(`Current session: ${formatTokenCount(budget.used)} (${budget.percent}% used)`);
  }
  lines.push("");
  lines.push("## Stop");
  lines.push("");
  lines.push("- Do not run broad search commands without a tight pattern and path.");
  lines.push("- Do not paste or read full logs, lockfiles, generated files, cache folders, coverage, build output, or minified bundles.");
  lines.push("- Do not re-open files listed below unless they changed after this file was generated.");
  lines.push("");
  lines.push("## Allowed Next");
  lines.push("");
  if (budget?.exceeded) {
    lines.push("- Produce a compact state summary first.");
    lines.push("- Finish only the smallest current fix or stop at a clear handoff.");
    lines.push("- Move the next unrelated task into a fresh session.");
  } else {
    live.liveAction.now.slice(0, 4).forEach((step) => lines.push(`- ${step}`));
    lines.push("- Keep the next tool call narrow enough to summarize in one screen.");
  }
  if (live.liveAction.shieldPlan) {
    lines.push(`- Run noisy commands through shield: \`${live.liveAction.shieldPlan.command}\`.`);
    lines.push(`- Search shield output instead of reloading full logs: \`${live.liveAction.shieldPlan.searchCommand}\`.`);
  }
  if (active?.actionableRepeatedPaths?.length) {
    lines.push("");
    lines.push("## Blocked Re-Reads");
    lines.push("");
    active.actionableRepeatedPaths.slice(0, 10).forEach((item) => lines.push(`- ${item.value} (${item.count}x already)`));
  }
  if (active?.generatedArtifactGroups?.length) {
    lines.push("");
    lines.push("## Blocked Artifact Classes");
    lines.push("");
    active.generatedArtifactGroups.slice(0, 10).forEach((group) => {
      lines.push(`- ${group.type}${group.examples?.[0] ? `, e.g. ${group.examples[0]}` : ""}`);
    });
  }
  lines.push("");
  lines.push("## Agent Instruction");
  lines.push("");
  lines.push("Treat this as the active context budget. Prefer summaries over reads, targeted commands over broad output, and fresh sessions over dragging old context forward.");
  lines.push("");
  return lines.join("\n");
}

  return {
    renderContextThrottle,
    renderLiveGuardrails,
    renderRescuePrompt,
    renderUsageTerminal,
    renderWatchTerminal,
  };
};
