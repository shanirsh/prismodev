module.exports = function createUsageWatch(deps) {
  const {
    fs,
    os,
    path,
    NPX_COMMAND,
    CLAUDE_PRICING,
    DEFAULT_CLAUDE_PRICING_KEY,
    GENERATED_ARTIFACT_PATTERNS,
    readIfText,
    estimateTokens,
    color,
    writeGeneratedFile,
  } = deps;

const {
  getActionableRepeatedPaths,
  normalizeMentionedPath,
  summarizeGeneratedArtifacts,
} = require("./usage-log-utils")({
  fs,
  path,
  GENERATED_ARTIFACT_PATTERNS,
  readIfText,
});

function formatTokenCount(value) {
  const n = Number(value || 0);
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

function formatMoney(value) {
  const n = Number(value || 0);
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

const {
  buildClaudeCostInsights,
  buildClaudeSessionDiagnosis,
  buildSessionTimeline,
  calculateClaudeCost,
  renderClaudeCostTerminal,
} = require("./usage-cost")({
  CLAUDE_PRICING,
  DEFAULT_CLAUDE_PRICING_KEY,
  NPX_COMMAND,
  formatMoney,
  formatTokenCount,
});

const {
  buildLiveSessionView,
  buildMultiAgentView,
} = require("./watch-live")({
  NPX_COMMAND,
  formatTokenCount,
  getActionableRepeatedPaths,
  summarizeGeneratedArtifacts,
});

const {
  analyzeSessionFile,
  analyzeCursorSessions,
  getAllClaudeSessionFiles,
  getClaudeSessionFiles,
  getCodexSessionFiles,
  getUsageSummary: getBaseUsageSummary,
} = require("./usage-sessions")({
  fs,
  os,
  path,
  GENERATED_ARTIFACT_PATTERNS,
  calculateClaudeCost,
  estimateTokens,
  readIfText,
});

const {
  buildCursorDiagnosis,
  buildCursorSessionTimeline,
  renderCursorTerminal,
} = require("./cursor-sessions")({ fs, os, path, estimateTokens });

function getUsageSummary(options = {}) {
  const summary = getBaseUsageSummary(options);
  if ((summary.sessions || []).length > 1) {
    summary.multiAgent = buildMultiAgentView(summary);
  }
  return summary;
}

const {
  renderContextThrottle,
  renderLiveGuardrails,
  renderMultiAgentWatchTerminal,
  renderRescuePrompt,
  renderUsageTerminal,
  renderWatchTerminal,
} = require("./watch-render")({
  NPX_COMMAND,
  buildLiveSessionView,
  buildMultiAgentView,
  color,
  formatTokenCount,
  getActionableRepeatedPaths,
  summarizeGeneratedArtifacts,
});

function getClaudeCodeCostSummary(options = {}) {
  const limit = options.all ? 200 : options.limit || 1;
  const cwd = options.cwd || process.cwd();
  const files = options.allProjects ? getAllClaudeSessionFiles() : getClaudeSessionFiles(cwd);
  const sessions = files
    .slice(0, limit)
    .map((file) => analyzeSessionFile(file, "claude-code"))
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .slice(0, limit)
    .map((session) => {
      if (session.cost) return session;
      return {
        ...session,
        cost: calculateClaudeCost({
          inputTokens: session.exactInputTokens,
          outputTokens: session.exactOutputTokens,
          cacheCreationTokens: session.exactCacheCreationTokens,
          cacheReadTokens: session.exactCacheReadTokens,
        }, session.model),
      };
    })
    .map((session) => ({
      ...session,
      prismo: buildClaudeSessionDiagnosis(session),
      timeline: buildSessionTimeline(session),
    }));
  const totals = sessions.reduce(
    (acc, session) => {
      acc.sessions += 1;
      acc.inputTokens += session.exactInputTokens || 0;
      acc.outputTokens += session.exactOutputTokens || 0;
      acc.cacheCreationTokens += session.exactCacheCreationTokens || 0;
      acc.cacheReadTokens += session.exactCacheReadTokens || 0;
      acc.totalTokens += session.exactTotalTokens || session.contextTokens || 0;
      acc.inputCost += session.cost ? session.cost.input : 0;
      acc.outputCost += session.cost ? session.cost.output : 0;
      acc.cacheWriteCost += session.cost ? session.cost.cacheWrite : 0;
      acc.cacheReadCost += session.cost ? session.cost.cacheRead : 0;
      acc.totalCost += session.cost ? session.cost.total : 0;
      acc.noCacheCost += session.cost ? session.cost.noCache : 0;
      acc.cacheSavings += session.cost ? session.cost.cacheSavings : 0;
      acc.estimatedAvoidableCost += session.prismo ? session.prismo.estimatedAvoidableCost : 0;
      return acc;
    },
    {
      sessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      inputCost: 0,
      outputCost: 0,
      cacheWriteCost: 0,
      cacheReadCost: 0,
      totalCost: 0,
      noCacheCost: 0,
      cacheSavings: 0,
      estimatedAvoidableCost: 0,
    }
  );
  const insights = buildClaudeCostInsights(sessions, totals);
  return {
    generatedAt: new Date().toISOString(),
    scannedPath: options.allProjects ? null : cwd,
    scope: options.allProjects ? "all-claude-projects" : "project",
    command: options.mode || "latest",
    pricingSource: "Anthropic public API pricing, USD per 1M tokens; defaults to Claude Sonnet 4 when a model cannot be inferred.",
    totals,
    insights,
    sessions,
  };
}

function getCursorSessionSummary(options = {}) {
  const cwd = options.cwd || process.cwd();
  const limit = options.limit || 20;
  const mode = options.mode || "latest";
  const cursorData = analyzeCursorSessions({ limit, cwd });
  cursorData.command = mode;
  cursorData.timeline = buildCursorSessionTimeline(cursorData);
  cursorData.diagnosis = buildCursorDiagnosis(cursorData);
  return cursorData;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getPositionals(args, valueFlags = new Set()) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (valueFlags.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-")) values.push(arg);
  }
  return values;
}

function isScopeToken(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,40}$/.test(String(value || ""));
}

function parseScopeAndTarget(args, valueFlags = new Set()) {
  const positional = getPositionals(args, valueFlags);
  if (!positional.length) return { scope: null, target: process.cwd() };
  if (positional.length >= 2 && isScopeToken(positional[0])) {
    return { scope: positional[0].toLowerCase(), target: positional[1] || process.cwd() };
  }
  if (isScopeToken(positional[0]) && ![".", ".."].includes(positional[0])) {
    return { scope: positional[0].toLowerCase(), target: process.cwd() };
  }
  return { scope: null, target: positional[0] || process.cwd() };
}

function writeLiveFile(root, relPath, contents) {
  const fullPath = path.join(root || process.cwd(), relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents, "utf8");
  return relPath;
}

function writeLiveGuardrails(summary) {
  const root = summary.scannedPath || process.cwd();
  const guardrailsPath = writeLiveFile(root, path.join(".prismo", "live-guardrails.md"), renderLiveGuardrails(summary));
  const rescuePath = writeLiveFile(root, path.join(".prismo", "live-rescue-prompt.md"), renderRescuePrompt(summary));
  return { guardrailsPath, rescuePath };
}

function writeContextThrottle(summary) {
  const root = summary.scannedPath || process.cwd();
  return writeLiveFile(root, path.join(".prismo", "live-context-throttle.md"), renderContextThrottle(summary));
}

function buildWatchEvent(summary) {
  const live = summary.live || buildLiveSessionView(summary);
  const active = live.activeSession;
  if (!active || live.liveAction.cause === "healthy" || live.liveAction.cause === "no-active-session") return null;
  const repeated = active.actionableRepeatedPaths || [];
  const artifacts = active.generatedArtifactGroups || [];
  const budget = live.budget || null;
  const signatureParts = [
    live.liveAction.cause,
    live.contextPressure,
    budget?.exceeded ? "budget-exceeded" : budget?.nearLimit ? "budget-near" : "budget-ok",
    repeated.slice(0, 3).map((item) => `${item.value}:${item.count}`).join("|"),
    artifacts.slice(0, 3).map((item) => `${item.type}:${item.count}`).join("|"),
  ];
  return {
    schemaVersion: 1,
    timestamp: summary.generatedAt,
    repo: summary.scannedPath,
    tool: active.tool,
    sessionId: active.sessionId,
    pressure: live.contextPressure,
    cause: live.liveAction.cause,
    confidence: live.liveAction.confidence,
    summary: live.liveAction.summary,
    tokens: active.tokens,
    recentContextGrowth: active.recentContextGrowth || 0,
    toolOutputTokens: active.estimatedToolTokens || 0,
    budget,
    warnings: live.warnings || [],
    shieldPlan: live.liveAction.shieldPlan || null,
    repeatedFiles: repeated.slice(0, 5),
    artifactGroups: artifacts.slice(0, 5),
    signature: signatureParts.join("::"),
  };
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

function writeWatchEvent(summary) {
  const event = buildWatchEvent(summary);
  if (!event) return null;
  const root = summary.scannedPath || process.cwd();
  const relPath = path.join(".prismo", "watch-events.jsonl");
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const last = readLastJsonLine(fullPath);
  if (last?.signature === event.signature) return relPath;
  fs.appendFileSync(fullPath, `${JSON.stringify(event)}\n`, "utf8");
  return relPath;
}

function renderWatchReport(summary) {
  if (summary.redactPaths) {
    const redacted = redactWatchPayload(toWatchJsonPayload(summary));
    return renderWatchReport({
      ...summary,
      scannedPath: redacted.scannedPath,
      sessions: redacted.sessions,
      live: redacted.live,
      redactPaths: false,
    });
  }
  const live = summary.live || buildLiveSessionView(summary);
  const active = live.activeSession;
  const lines = [];
  lines.push("# Prismo Watch Report");
  lines.push("");
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Repo: ${summary.scannedPath}`);
  lines.push("");
  lines.push("## Context Pressure");
  lines.push("");
  lines.push(`- Pressure: ${live.contextPressure}`);
  if (active) {
    lines.push(`- Session size: ${formatTokenCount(active.tokens)} tokens (${active.confidence})`);
    lines.push(`- Recent growth: +${formatTokenCount(active.recentContextGrowth || 0)} tokens`);
    lines.push(`- Tool/output tokens: ${formatTokenCount(active.estimatedToolTokens)}`);
    lines.push(`- Turns: ${active.turns}`);
    lines.push(`- Tool calls: ${active.toolCalls}`);
    if (active.model) lines.push(`- Model: ${active.model}`);
    if (active.updatedAt) lines.push(`- Updated: ${active.updatedAt}`);
  } else {
    lines.push("- No active local Codex/Claude Code session detected for this repo.");
  }
  lines.push("");
  lines.push("## Warnings");
  lines.push("");
  if (live.warnings.length) live.warnings.forEach((warning) => lines.push(`- ${warning}`));
  else lines.push("- No major context-pressure signals detected.");
  lines.push("");
  lines.push("## Do This Now");
  lines.push("");
  lines.push(`- Cause: ${live.liveAction.cause} (${live.liveAction.confidence} confidence)`);
  lines.push(`- ${live.liveAction.summary}`);
  live.liveAction.now.forEach((step) => lines.push(`- ${step}`));
  if (live.liveAction.shieldPlan) {
    lines.push(`- Shield noisy command output: \`${live.liveAction.shieldPlan.command}\``);
    lines.push(`- Search shielded output: \`${live.liveAction.shieldPlan.searchCommand}\``);
    lines.push(`- MCP workflow: \`${live.liveAction.shieldPlan.mcp.runTool}\` -> \`${live.liveAction.shieldPlan.mcp.searchTool}\``);
  }
  if (summary.guardrailsPath) {
    lines.push(`- Guardrails: ${summary.guardrailsPath}`);
    lines.push(`- Rescue prompt: ${summary.rescuePath}`);
  }
  if (summary.throttlePath) lines.push(`- Context throttle: ${summary.throttlePath}`);
  if (summary.firewallPath) lines.push(`- Context firewall: ${summary.firewallPath}`);
  if (summary.eventsPath) lines.push(`- Event log: ${summary.eventsPath}`);
  if (active) {
    lines.push("");
    lines.push("## Signals");
    lines.push("");
    const signals = [
      ...((active.actionableRepeatedPaths || getActionableRepeatedPaths(active)) || []).map((item) => `Repeated file: ${item.value} (${item.count}x)`),
      ...((active.generatedArtifactGroups || summarizeGeneratedArtifacts(active.generatedArtifacts || [])) || []).map((group) => `Generated artifacts likely entered context: ${group.type} (${group.count} mentions)`),
      ...(active.repeatedCommands || []).map((item) => `Repeated command: ${item.value} (${item.count}x)`),
    ];
    if (signals.length) signals.forEach((signal) => lines.push(`- ${signal}`));
    else lines.push("- No repeated path, generated artifact, or loop signals detected.");
    if (active.largestTextBlobs.length) {
      lines.push("");
      lines.push("## Largest Context Sources");
      lines.push("");
      active.largestTextBlobs.forEach((blob) => lines.push(`- ${blob.label}: ~${blob.tokens.toLocaleString()} tokens`));
    }
  }
  lines.push("");
  lines.push("## Suggested Action");
  lines.push("");
  lines.push(`Run: ${live.recommendedAction}`);
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("Prismo Watch uses local coding-agent logs. Exactness depends on which fields Codex or Claude Code wrote to disk, so warnings use likely/suspicious language when visibility is limited.");
  lines.push("");
  return lines.join("\n");
}

function writeWatchReport(summary) {
  const written = writeGeneratedFile(summary.scannedPath || process.cwd(), path.join(".prismo", "watch-report.md"), renderWatchReport(summary));
  return written.path;
}

function compactWatchSession(session) {
  return {
    tool: session.tool,
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    model: session.model,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    turns: session.turns,
    toolCalls: session.toolCalls,
    toolResults: session.toolResults,
    displayTokens: session.displayTokens,
    contextTokens: session.contextTokens,
    estimatedToolTokens: session.estimatedToolTokens,
    exactInputTokens: session.exactInputTokens || 0,
    exactOutputTokens: session.exactOutputTokens || 0,
    exactCacheReadTokens: session.exactCacheReadTokens || 0,
    exactCacheCreationTokens: session.exactCacheCreationTokens || 0,
    exactTotalTokens: session.exactTotalTokens || 0,
    exactAvailable: session.exactAvailable,
    confidence: session.confidence,
    contextRisk: session.contextRisk,
    recentContextGrowth: session.recentContextGrowth || 0,
    repeatedPathMentions: session.repeatedPathMentions || [],
    actionableRepeatedPaths: getActionableRepeatedPaths(session, 5),
    generatedArtifacts: session.generatedArtifacts || [],
    generatedArtifactGroups: summarizeGeneratedArtifacts(session.generatedArtifacts || [], 5),
    repeatedCommands: session.repeatedCommands || [],
    loopSuspicion: Boolean(session.loopSuspicion),
    loopConfidence: session.loopConfidence || "low",
    largestTextBlobs: session.largestTextBlobs || [],
  };
}

function compactUsageSummary(summary) {
  if (!summary) return null;
  return {
    generatedAt: summary.generatedAt,
    scannedPath: summary.scannedPath,
    tool: summary.tool,
    confidence: summary.confidence,
    totals: summary.totals,
    sources: summary.sources,
    sessions: (summary.sessions || []).map(compactWatchSession),
    multiAgent: summary.multiAgent || ((summary.sessions || []).length > 1 ? buildMultiAgentView(summary) : null),
  };
}

function redactPathValue(value) {
  const text = String(value || "");
  if (!text) return text;
  const normalized = text.replace(/\\/g, "/");
  const cwd = String(process.cwd() || "").replace(/\\/g, "/");
  if (cwd && normalized.startsWith(`${cwd}/`)) return normalized.slice(cwd.length + 1);
  if (normalized.startsWith("/")) return path.basename(normalized);
  return normalized.replace(/^Users\/[^/]+\//, "").replace(/^home\/[^/]+\//, "");
}

function redactWatchPayload(payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  clone.scannedPath = clone.scannedPath ? "[repo]" : clone.scannedPath;
  const redactItems = (items) => (items || []).map((item) => ({ ...item, value: redactPathValue(item.value) }));
  const redactGroups = (groups) => (groups || []).map((group) => ({
    ...group,
    examples: (group.examples || []).map(redactPathValue),
  }));
  for (const session of clone.sessions || []) {
    session.cwd = session.cwd ? "[repo]" : session.cwd;
    session.repeatedPathMentions = redactItems(session.repeatedPathMentions);
    session.actionableRepeatedPaths = redactItems(session.actionableRepeatedPaths);
    session.generatedArtifacts = redactItems(session.generatedArtifacts);
    session.generatedArtifactGroups = redactGroups(session.generatedArtifactGroups);
  }
  if (clone.live?.activeSession) {
    clone.live.activeSession.cwd = clone.live.activeSession.cwd ? "[repo]" : clone.live.activeSession.cwd;
    clone.live.activeSession.repeatedPathMentions = redactItems(clone.live.activeSession.repeatedPathMentions);
    clone.live.activeSession.actionableRepeatedPaths = redactItems(clone.live.activeSession.actionableRepeatedPaths);
    clone.live.activeSession.generatedArtifacts = redactItems(clone.live.activeSession.generatedArtifacts);
    clone.live.activeSession.generatedArtifactGroups = redactGroups(clone.live.activeSession.generatedArtifactGroups);
  }
  if (clone.live?.warnings) {
    clone.live.warnings = clone.live.warnings.map((warning) => warning.replace(/Users\/[^ ]+/g, "[path]").replace(/\/Users\/[^ ]+/g, "[path]"));
  }
  return clone;
}

function toWatchJsonPayload(summary) {
  const payload = {
    schemaVersion: 1,
    generatedAt: summary.generatedAt,
    scannedPath: summary.scannedPath,
    tool: summary.tool,
    confidence: summary.confidence,
    totals: summary.totals,
    sources: summary.sources,
    sessions: summary.sessions.map(compactWatchSession),
    live: summary.live || buildLiveSessionView(summary),
    multiAgent: summary.multiAgent || (summary.agents ? buildMultiAgentView(summary) : null),
    auto: Boolean(summary.auto),
    rescuePrompt: summary.includeRescuePrompt ? renderRescuePrompt(summary) : null,
    guardrailsPath: summary.guardrailsPath || null,
    rescuePath: summary.rescuePath || null,
    throttlePath: summary.throttlePath || null,
    firewallPath: summary.firewallPath || null,
    eventsPath: summary.eventsPath || null,
    reportPath: summary.reportPath || null,
  };
  return summary.redactPaths ? redactWatchPayload(payload) : payload;
}

async function watchUsage(options = {}) {
  const intervalMs = options.intervalMs || 3000;
  const iterations = options.once ? 1 : Number.POSITIVE_INFINITY;
  for (let i = 0; i < iterations; i += 1) {
    const summary = getUsageSummary(options);
    summary.auto = Boolean(options.auto);
    summary.agents = Boolean(options.agents);
    summary.live = buildLiveSessionView(summary);
    if (options.agents) {
      summary.multiAgent = buildMultiAgentView(summary);
    }
    if (options.guardrails) {
      const written = writeLiveGuardrails(summary);
      summary.guardrailsPath = written.guardrailsPath;
      summary.rescuePath = written.rescuePath;
    }
    if (options.throttle) {
      summary.throttlePath = writeContextThrottle(summary);
    }
    if (options.updateFirewall) {
      const firewall = options.updateFirewall(summary);
      if (firewall && firewall.generatedFiles) summary.firewallPath = ".prismo/context-firewall.md";
    }
    if (options.events) {
      summary.eventsPath = writeWatchEvent(summary);
    }
    if (options.report) {
      summary.redactPaths = Boolean(options.redactPaths);
      summary.reportPath = writeWatchReport(summary);
    }
    summary.redactPaths = Boolean(options.redactPaths);
    summary.includeRescuePrompt = Boolean(options.rescue);
    if (options.agents && !options.json) {
      console.clear();
      console.log(renderMultiAgentWatchTerminal(summary));
      if (!options.once) console.log(`\nRefreshing every ${Math.round(intervalMs / 1000)}s. Press Ctrl+C to stop.`);
    } else if (options.rescue && !options.json) {
      console.log(renderRescuePrompt(summary));
    } else if (options.json) {
      console.log(JSON.stringify(toWatchJsonPayload(summary), null, 2));
    } else {
      console.clear();
      const terminalSummary = options.redactPaths ? { ...summary, ...redactWatchPayload(toWatchJsonPayload(summary)) } : summary;
      console.log(renderWatchTerminal(terminalSummary));
      if (options.guardrails) console.log(`\nGuardrails: ${summary.guardrailsPath}\nRescue prompt: ${summary.rescuePath}`);
      if (options.throttle) console.log(`\nContext throttle: ${summary.throttlePath}`);
      if (summary.firewallPath) console.log(`\nContext firewall: ${summary.firewallPath}`);
      if (options.events && summary.eventsPath) console.log(`\nEvent log: ${summary.eventsPath}`);
      if (options.report) console.log(`\nReport: ${summary.reportPath}`);
      if (!options.once) console.log(`\nRefreshing every ${Math.round(intervalMs / 1000)}s. Press Ctrl+C to stop.`);
    }
    if (i + 1 >= iterations) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}


  return {
    analyzeSessionFile,
    analyzeCursorSessions,
    buildCursorDiagnosis,
    buildCursorSessionTimeline,
    buildMultiAgentView,
    calculateClaudeCost,
    compactUsageSummary,
    formatMoney,
    formatTokenCount,
    getClaudeCodeCostSummary,
    getClaudeSessionFiles,
    getCodexSessionFiles,
    getCursorSessionSummary,
    getUsageSummary,
    getPositionals,
    parsePositiveInt,
    parseScopeAndTarget,
    renderClaudeCostTerminal,
    renderCursorTerminal,
    renderUsageTerminal,
    renderContextThrottle,
    buildWatchEvent,
    renderRescuePrompt,
    renderLiveGuardrails,
    renderWatchReport,
    renderWatchTerminal,
    toWatchJsonPayload,
    watchUsage,
    writeContextThrottle,
    writeLiveGuardrails,
    writeWatchEvent,
    writeWatchReport,
  };
};
