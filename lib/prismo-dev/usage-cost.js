module.exports = function createUsageCost(deps) {
  const {
    CLAUDE_PRICING,
    DEFAULT_CLAUDE_PRICING_KEY,
    NPX_COMMAND,
    formatMoney,
    formatTokenCount,
  } = deps;

  function percentOf(part, total) {
    if (!total) return 0;
    return Math.round((Number(part || 0) / total) * 100);
  }

  function inferClaudePricingKey(model) {
    const normalized = String(model || "").toLowerCase();
    if (normalized.includes("opus") && normalized.includes("4-1")) return "opus-4.1";
    if (normalized.includes("opus") && normalized.includes("4.1")) return "opus-4.1";
    if (normalized.includes("opus") && normalized.includes("4")) return "opus-4";
    if (normalized.includes("sonnet") && normalized.includes("4")) return "sonnet-4";
    if (normalized.includes("sonnet") && (normalized.includes("3-7") || normalized.includes("3.7"))) return "sonnet-3.7";
    if (normalized.includes("sonnet") && (normalized.includes("3-5") || normalized.includes("3.5"))) return "sonnet-3.5";
    if (normalized.includes("haiku") && (normalized.includes("3-5") || normalized.includes("3.5"))) return "haiku-3.5";
    if (normalized.includes("haiku") && normalized.includes("3")) return "haiku-3";
    if (normalized.includes("opus") && normalized.includes("3")) return "opus-3";
    return DEFAULT_CLAUDE_PRICING_KEY;
  }

  function calculateClaudeCost(tokens, model) {
    const pricingKey = inferClaudePricingKey(model);
    const pricing = CLAUDE_PRICING[pricingKey] || CLAUDE_PRICING[DEFAULT_CLAUDE_PRICING_KEY];
    const inputTokens = Number(tokens.inputTokens || 0);
    const outputTokens = Number(tokens.outputTokens || 0);
    const cacheWriteTokens = Number(tokens.cacheCreationTokens || tokens.cacheWriteTokens || 0);
    const cacheReadTokens = Number(tokens.cacheReadTokens || 0);
    const input = (inputTokens / 1000000) * pricing.input;
    const output = (outputTokens / 1000000) * pricing.output;
    const cacheWrite = (cacheWriteTokens / 1000000) * pricing.cacheWrite;
    const cacheRead = (cacheReadTokens / 1000000) * pricing.cacheRead;
    const total = input + output + cacheWrite + cacheRead;
    const noCache = ((inputTokens + cacheWriteTokens + cacheReadTokens) / 1000000) * pricing.input + output;
    return {
      model: pricing.name,
      pricingKey,
      pricing,
      input,
      output,
      cacheWrite,
      cacheRead,
      total,
      noCache,
      cacheSavings: Math.max(noCache - total, 0),
    };
  }

  function buildClaudeSessionDiagnosis(session) {
    const totalCost = session.cost ? session.cost.total : 0;
    const drivers = [];
    if (session.cost) {
      const costParts = [
        ["output", session.cost.output, "Assistant output is the largest cost driver."],
        ["cache-read", session.cost.cacheRead, "Repeated cached context reads are driving spend."],
        ["cache-write", session.cost.cacheWrite, "Large context cache writes are adding upfront cost."],
        ["input", session.cost.input, "Fresh input/context tokens are driving spend."],
      ].sort((a, b) => b[1] - a[1]);
      for (const [name, cost, message] of costParts) {
        if (cost > 0) {
          drivers.push({ type: name, cost, share: percentOf(cost, totalCost), message });
        }
      }
    }
    if (session.estimatedToolTokens >= 75000) {
      drivers.push({
        type: "tool-output",
        tokens: session.estimatedToolTokens,
        share: null,
        message: "Tool output looks heavy; test logs, shell output, or file dumps may be inflating context.",
      });
    }
    if (session.turns >= 30) {
      drivers.push({
        type: "long-session",
        turns: session.turns,
        share: null,
        message: "Long session detected; unrelated follow-up work is likely riding old context.",
      });
    }
    if (session.contextRisk === "High") {
      drivers.push({
        type: "context-risk",
        tokens: session.displayTokens,
        share: null,
        message: "Session context is high enough that splitting work or using context packs should matter.",
      });
    }

    const recommendations = [];
    if (drivers.some((driver) => driver.type === "tool-output")) {
      recommendations.push("Summarize long command output before pasting or re-reading it.");
    }
    if (drivers.some((driver) => driver.type === "cache-read" || driver.type === "cache-write" || driver.type === "context-risk")) {
      recommendations.push(`Run ${NPX_COMMAND} optimize, then start from .prismo/architecture-summary.md.`);
    }
    if (drivers.some((driver) => driver.type === "long-session")) {
      recommendations.push("Start a fresh Claude Code session for the next unrelated task.");
    }
    if (drivers.some((driver) => driver.type === "output")) {
      recommendations.push("Ask for concise diffs, file paths, and verification results instead of full prose dumps.");
    }
    if (!recommendations.length) {
      recommendations.push(`${NPX_COMMAND} scan --usage can tie this spend back to repo-level token waste.`);
    }

    const avoidableRate =
      session.contextRisk === "High" ? 0.28 :
        session.contextRisk === "Medium" ? 0.16 :
          session.turns >= 20 || session.estimatedToolTokens >= 30000 ? 0.1 : 0.04;
    return {
      wasteScore: session.contextRisk === "High" ? 85 : session.contextRisk === "Medium" ? 55 : session.turns >= 20 ? 40 : 20,
      estimatedAvoidableCost: totalCost * avoidableRate,
      estimatedAvoidableRate: avoidableRate,
      drivers: drivers.slice(0, 5),
      recommendations: Array.from(new Set(recommendations)).slice(0, 4),
    };
  }

  function buildSessionTimeline(session) {
    const events = [];
    const timeline = session.exactTokenTimeline || [];
    for (let i = 1; i < timeline.length; i += 1) {
      const previous = timeline[i - 1];
      const current = timeline[i];
      const delta = Math.max(0, (current.total || 0) - (previous.total || 0));
      if (delta >= 60000) {
        events.push({
          timestamp: current.timestamp || session.updatedAt,
          type: delta >= 250000 ? "context-spike" : "context-growth",
          label: delta >= 250000 ? "Context spike likely" : "Context growth",
          tokens: delta,
          detail: `+${formatTokenCount(delta)} tokens`,
        });
      }
    }
    for (const item of (session.generatedArtifacts || []).slice(0, 5)) {
      events.push({
        timestamp: session.updatedAt,
        type: "artifact-leak",
        label: "Generated artifact likely entered context",
        tokens: null,
        detail: `${item.value} (${item.count}x)`,
      });
    }
    for (const item of (session.repeatedCommands || []).slice(0, 5)) {
      events.push({
        timestamp: session.updatedAt,
        type: "repeated-command",
        label: session.loopSuspicion ? "Repeated command loop possible" : "Repeated command",
        tokens: null,
        detail: `${item.value} (${item.count}x)`,
      });
    }
    for (const item of (session.repeatedPathMentions || []).slice(0, 3)) {
      events.push({
        timestamp: session.updatedAt,
        type: "repeated-file",
        label: "Repeated file/path context",
        tokens: null,
        detail: `${item.value} (${item.count}x)`,
      });
    }
    if (session.estimatedToolTokens >= 75000) {
      events.push({
        timestamp: session.updatedAt,
        type: "tool-output",
        label: "Large tool output",
        tokens: session.estimatedToolTokens,
        detail: `${formatTokenCount(session.estimatedToolTokens)} estimated tool/output tokens`,
      });
    }
    return events
      .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0))
      .slice(-20);
  }

  function buildClaudeCostInsights(sessions, totals) {
    const highestCostSessions = sessions
      .slice()
      .sort((a, b) => (b.cost?.total || 0) - (a.cost?.total || 0))
      .slice(0, 3)
      .map((session) => ({
        sessionId: session.sessionId,
        updatedAt: session.updatedAt,
        model: session.cost?.model || session.model,
        cost: session.cost?.total || 0,
        risk: session.contextRisk,
        topDriver: session.prismo?.drivers?.[0] || null,
      }));
    const costDrivers = [
      { type: "output", cost: totals.outputCost, share: percentOf(totals.outputCost, totals.totalCost) },
      { type: "cache-read", cost: totals.cacheReadCost, share: percentOf(totals.cacheReadCost, totals.totalCost) },
      { type: "cache-write", cost: totals.cacheWriteCost, share: percentOf(totals.cacheWriteCost, totals.totalCost) },
      { type: "input", cost: totals.inputCost, share: percentOf(totals.inputCost, totals.totalCost) },
    ].filter((driver) => driver.cost > 0).sort((a, b) => b.cost - a.cost);
    const estimatedAvoidableCost = sessions.reduce((sum, session) => sum + (session.prismo?.estimatedAvoidableCost || 0), 0);
    const recommendations = [];
    if (costDrivers[0]?.type === "cache-read" || costDrivers[0]?.type === "cache-write") {
      recommendations.push("Repeated context is the main spend driver; generate context packs and avoid broad repo reads.");
    }
    if (costDrivers[0]?.type === "output") {
      recommendations.push("Output cost is leading; ask the agent for concise diffs and summaries by default.");
    }
    if (sessions.some((session) => session.estimatedToolTokens >= 75000)) {
      recommendations.push("Tool output is bloating at least one session; keep shell output narrow and summarize logs.");
    }
    if (sessions.some((session) => session.turns >= 30)) {
      recommendations.push("At least one session is long; split unrelated tasks into fresh sessions.");
    }
    recommendations.push(`${NPX_COMMAND} scan --usage`);
    recommendations.push(`${NPX_COMMAND} optimize`);
    return {
      estimatedAvoidableCost,
      estimatedAvoidableRate: totals.totalCost ? estimatedAvoidableCost / totals.totalCost : 0,
      costDrivers,
      highestCostSessions,
      recommendations: Array.from(new Set(recommendations)).slice(0, 5),
    };
  }

  function renderClaudeCostTerminal(summary) {
    const lines = [];
    const latest = summary.sessions[0] || null;
    lines.push("");
    lines.push("Prismo Claude Code Cost");
    lines.push("");
    if (!summary.sessions.length) {
      lines.push(summary.scope === "all-claude-projects" ? "No Claude Code sessions found." : "No Claude Code sessions found for this repo.");
      lines.push("");
      lines.push("Tip: run Claude Code inside this project, then try `npx getprismo cc` again.");
      return lines.join("\n");
    }

    if (summary.command === "list") {
      lines.push(`Recent sessions: ${summary.sessions.length}`);
      lines.push("");
      summary.sessions.forEach((session, index) => {
        lines.push(`${index + 1}. ${session.model || session.cost.model}  ${session.updatedAt || "unknown date"}`);
        lines.push(`   ${formatTokenCount(session.exactTotalTokens || session.contextTokens)} tokens -> ${formatMoney(session.cost.total)}  (${session.sessionId})`);
        if (session.prismo?.drivers?.[0]) lines.push(`   driver: ${session.prismo.drivers[0].message}`);
      });
      lines.push("");
      lines.push(`Estimated avoidable spend: ${formatMoney(summary.insights.estimatedAvoidableCost)}`);
      lines.push(`Next: ${summary.insights.recommendations.slice(0, 2).join(" -> ")}`);
      return lines.join("\n");
    }

    if (summary.command === "all") {
      lines.push(`Sessions: ${summary.totals.sessions}`);
      lines.push("");
      lines.push(`Input:        ${formatTokenCount(summary.totals.inputTokens).padStart(8)} tokens  ->  ${formatMoney(summary.totals.inputCost)}`);
      lines.push(`Output:       ${formatTokenCount(summary.totals.outputTokens).padStart(8)} tokens  ->  ${formatMoney(summary.totals.outputCost)}`);
      lines.push(`Cache write:  ${formatTokenCount(summary.totals.cacheCreationTokens).padStart(8)} tokens  ->  ${formatMoney(summary.totals.cacheWriteCost)}`);
      lines.push(`Cache read:   ${formatTokenCount(summary.totals.cacheReadTokens).padStart(8)} tokens  ->  ${formatMoney(summary.totals.cacheReadCost)}`);
      lines.push("--------------------------------------------------");
      lines.push(`Total:        ${formatTokenCount(summary.totals.totalTokens).padStart(8)} tokens  ->  ${formatMoney(summary.totals.totalCost)}`);
      if (summary.totals.cacheSavings > 0) lines.push("");
      if (summary.totals.cacheSavings > 0) lines.push(`Cache saved you ${formatMoney(summary.totals.cacheSavings)} (vs no caching)`);
      lines.push("");
      lines.push("Prismo Diagnosis");
      lines.push(`Estimated avoidable spend: ${formatMoney(summary.insights.estimatedAvoidableCost)} (${Math.round(summary.insights.estimatedAvoidableRate * 100)}%)`);
      if (summary.insights.costDrivers.length) {
        lines.push(`Main cost driver: ${summary.insights.costDrivers[0].type} (${summary.insights.costDrivers[0].share}%)`);
      }
      summary.insights.recommendations.slice(0, 3).forEach((recommendation) => lines.push(`- ${recommendation}`));
      return lines.join("\n");
    }

    if (summary.command === "timeline") {
      lines.push(`Session: ${latest.sessionId}`);
      if (latest.model || latest.cost?.model) lines.push(`Model: ${latest.model || latest.cost.model}`);
      lines.push(`Updated: ${latest.updatedAt || "unknown date"}`);
      lines.push("");
      lines.push("Timeline");
      if (!latest.timeline || !latest.timeline.length) {
        lines.push("- No major context spikes, repeated commands, or artifact leaks detected in this session.");
      } else {
        latest.timeline.forEach((event) => {
          const when = event.timestamp ? new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "unknown";
          lines.push(`${when}  ${event.label}  ${event.detail}`);
        });
      }
      lines.push("");
      lines.push("Suggested Action");
      lines.push(latest.prismo?.recommendations?.[0] || `${NPX_COMMAND} doctor`);
      return lines.join("\n");
    }

    const sessions = summary.command === "last" ? summary.sessions : [latest];
    sessions.forEach((session, index) => {
      if (index > 0) lines.push("");
      lines.push(`${session.cost.model}  ${session.updatedAt || "unknown date"}`);
      if (session.sessionId) lines.push(`Session: ${session.sessionId}`);
      if (session.exactAvailable) lines.push(`Confidence: ${session.confidence}`);
      else lines.push("Confidence: estimated; exact token usage was not present in the local log.");
      lines.push("");
      lines.push(`Input:        ${formatTokenCount(session.exactInputTokens).padStart(8)} tokens  ->  ${formatMoney(session.cost.input)}`);
      lines.push(`Output:       ${formatTokenCount(session.exactOutputTokens).padStart(8)} tokens  ->  ${formatMoney(session.cost.output)}`);
      lines.push(`Cache write:  ${formatTokenCount(session.exactCacheCreationTokens).padStart(8)} tokens  ->  ${formatMoney(session.cost.cacheWrite)}`);
      lines.push(`Cache read:   ${formatTokenCount(session.exactCacheReadTokens).padStart(8)} tokens  ->  ${formatMoney(session.cost.cacheRead)}`);
      lines.push("--------------------------------------------------");
      lines.push(`Total:        ${formatTokenCount(session.exactTotalTokens || session.contextTokens).padStart(8)} tokens  ->  ${formatMoney(session.cost.total)}`);
      if (session.cost.cacheSavings > 0) lines.push("");
      if (session.cost.cacheSavings > 0) lines.push(`Cache saved you ${formatMoney(session.cost.cacheSavings)} (vs no caching)`);
      lines.push("");
      lines.push("Prismo Diagnosis");
      lines.push(`Waste score: ${session.prismo.wasteScore}/100`);
      lines.push(`Estimated avoidable spend: ${formatMoney(session.prismo.estimatedAvoidableCost)} (${Math.round(session.prismo.estimatedAvoidableRate * 100)}%)`);
      if (session.prismo.drivers.length) {
        lines.push("Cost Drivers:");
        session.prismo.drivers.slice(0, 3).forEach((driver) => lines.push(`- ${driver.message}`));
      }
      lines.push("Better Next Actions:");
      session.prismo.recommendations.forEach((recommendation) => lines.push(`- ${recommendation}`));
    });
    lines.push("");
    lines.push(`Next: ${NPX_COMMAND} scan --usage to connect spend back to repo token waste.`);
    return lines.join("\n");
  }

  return {
    buildClaudeCostInsights,
    buildClaudeSessionDiagnosis,
    buildSessionTimeline,
    calculateClaudeCost,
    renderClaudeCostTerminal,
  };
};
