module.exports = function createUsageSessions(deps) {
  const {
    fs,
    os,
    path,
    GENERATED_ARTIFACT_PATTERNS,
    calculateClaudeCost,
    estimateTokens,
    readIfText,
  } = deps;

  const {
    addUsage,
    collectText,
    extractCommandCandidates,
    extractMentionedPaths,
    incrementMap,
    isGeneratedArtifactPath,
    listFilesRecursive,
    parseJsonl,
    topCountEntries,
    totalUsageTokens,
  } = require("./usage-log-utils")({
    fs,
    path,
    GENERATED_ARTIFACT_PATTERNS,
    readIfText,
  });

function getSessionRisk(tokens, toolTokens) {
  if (tokens >= 200000 || toolTokens >= 75000) return "High";
  if (tokens >= 60000 || toolTokens >= 20000) return "Medium";
  return "Low";
}
function analyzeSessionFile(filePath, tool) {
  const rows = parseJsonl(filePath);
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  const session = {
    tool,
    filePath,
    sessionId: path.basename(filePath).replace(/\.jsonl$/, ""),
    title: "",
    cwd: "",
    model: "",
    startedAt: null,
    updatedAt: stat ? new Date(stat.mtimeMs).toISOString() : null,
    turns: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedToolTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    exactInputTokens: 0,
    exactOutputTokens: 0,
    exactCacheReadTokens: 0,
    exactCacheCreationTokens: 0,
    exactTotalTokens: 0,
    exactAvailable: false,
    confidence: "estimated",
    largestTextBlobs: [],
    toolNames: {},
    pathMentions: {},
    generatedArtifactMentions: {},
    commandMentions: {},
    failureMentions: 0,
    eventTokenDeltas: [],
    exactTokenTimeline: [],
  };
  const seenUsage = new Set();
  let codexCumulative = null;

  for (const row of rows) {
    const timestamp = row.timestamp || row.payload?.started_at || row.message?.timestamp;
    if (timestamp && !session.startedAt) session.startedAt = timestamp;
    if (timestamp) session.updatedAt = timestamp;
    if (row.cwd && !session.cwd) session.cwd = row.cwd;

    const meta = row.payload?.type === "session_meta" ? row.payload : row.type === "session_meta" ? row.payload : null;
    if (meta) {
      session.sessionId = meta.id || session.sessionId;
      session.cwd = meta.cwd || session.cwd;
      session.model = meta.model || meta.model_slug || session.model;
    }
    if (row.payload?.type === "token_count" && row.payload?.info?.total_token_usage) {
      codexCumulative = row.payload.info.total_token_usage;
      session.exactTokenTimeline.push({
        total: Number(codexCumulative.total_tokens || 0),
        timestamp: timestamp || null,
      });
    }
    if (row.type === "event_msg" && row.payload?.type === "token_count" && row.payload?.info?.total_token_usage) {
      codexCumulative = row.payload.info.total_token_usage;
      session.exactTokenTimeline.push({
        total: Number(codexCumulative.total_tokens || 0),
        timestamp: timestamp || null,
      });
    }
    if (row.type === "ai-title" && row.aiTitle) session.title = row.aiTitle;

    const msg = row.message || row.payload;
    if (msg?.model && !session.model) session.model = msg.model;
    const role = msg?.role || row.payload?.role;
    const text = collectText(msg);
    const tokens = estimateTokens(text);
    if (tokens > 0) {
      session.largestTextBlobs.push({
        label: row.type || row.payload?.type || "event",
        tokens,
      });
      session.eventTokenDeltas.push({
        label: row.type || row.payload?.type || "event",
        tokens,
        timestamp: timestamp || null,
      });
    }
    for (const mentionedPath of extractMentionedPaths(text, session.cwd)) {
      incrementMap(session.pathMentions, mentionedPath);
      if (isGeneratedArtifactPath(mentionedPath)) incrementMap(session.generatedArtifactMentions, mentionedPath);
    }
    for (const command of extractCommandCandidates(row, text)) {
      incrementMap(session.commandMentions, command);
    }
    if (/\b(error|failed|failure|traceback|exception|exit code|non-zero|tests? failed)\b/i.test(text)) {
      session.failureMentions += 1;
    }
    if (role === "user" || row.type === "user" || row.payload?.role === "user") {
      session.userMessages += 1;
      session.estimatedInputTokens += tokens;
    } else if (role === "assistant" || row.type === "assistant" || row.payload?.role === "assistant") {
      session.assistantMessages += 1;
      session.estimatedOutputTokens += tokens;
    }

    const rowText = JSON.stringify(row);
    const toolUseMatches = rowText.match(/"tool_use"|function_call|"name":"([^"]+)"/g) || [];
    const toolResultMatches = rowText.match(/"tool_result"|function_call_output/g) || [];
    if (toolUseMatches.length) session.toolCalls += toolUseMatches.length;
    if (toolResultMatches.length) {
      session.toolResults += toolResultMatches.length;
      session.estimatedToolTokens += tokens;
    }
    const toolName = row.message?.content?.find?.((item) => item && item.type === "tool_use")?.name || row.payload?.name;
    if (toolName) session.toolNames[toolName] = (session.toolNames[toolName] || 0) + 1;

    const usage = row.message?.usage || row.payload?.usage;
    if (usage) {
      const key = `${row.requestId || ""}:${row.message?.id || ""}:${totalUsageTokens(usage)}`;
      if (!seenUsage.has(key)) {
        seenUsage.add(key);
        addUsage(session, usage);
      }
    }
  }

  if (codexCumulative) {
    session.exactInputTokens = Number(codexCumulative.input_tokens || 0);
    session.exactOutputTokens = Number(codexCumulative.output_tokens || 0);
    session.exactCacheReadTokens = Number(codexCumulative.cached_input_tokens || 0);
    session.exactTotalTokens = Number(codexCumulative.total_tokens || 0);
    session.exactAvailable = session.exactTotalTokens > 0;
  } else {
    session.exactInputTokens = session.inputTokens || 0;
    session.exactOutputTokens = session.outputTokens || 0;
    session.exactCacheReadTokens = session.cacheReadTokens || 0;
    session.exactCacheCreationTokens = session.cacheCreationTokens || 0;
    session.exactTotalTokens =
      session.exactInputTokens + session.exactOutputTokens + session.exactCacheReadTokens + session.exactCacheCreationTokens;
    session.exactAvailable = session.exactTotalTokens > 0;
  }

  session.turns = Math.max(session.userMessages, session.assistantMessages);
  session.estimatedTotalTokens = session.estimatedInputTokens + session.estimatedOutputTokens + session.estimatedToolTokens;
  session.exactActiveTokens = session.exactAvailable
    ? Math.max(session.exactInputTokens - session.exactCacheReadTokens, 0) + session.exactOutputTokens + (session.exactCacheCreationTokens || 0)
    : 0;
  session.contextTokens = session.exactAvailable ? session.exactTotalTokens : session.estimatedTotalTokens;
  session.displayTokens = session.exactAvailable ? session.exactActiveTokens : session.estimatedTotalTokens;
  session.confidence = session.exactAvailable ? "exact-local-log" : "estimated-local-log";
  session.contextRisk = getSessionRisk(session.displayTokens, session.estimatedToolTokens);
  if (session.exactTokenTimeline.length >= 2) {
    const last = session.exactTokenTimeline[session.exactTokenTimeline.length - 1];
    const prev = session.exactTokenTimeline[session.exactTokenTimeline.length - 2];
    session.recentContextGrowth = Math.max(0, (last.total || 0) - (prev.total || 0));
  } else {
    session.recentContextGrowth = session.eventTokenDeltas.slice(-3).reduce((sum, item) => sum + (item.tokens || 0), 0);
  }
  session.repeatedPathMentions = topCountEntries(session.pathMentions, 5, 4);
  session.generatedArtifacts = topCountEntries(session.generatedArtifactMentions, 5, 1);
  session.repeatedCommands = topCountEntries(session.commandMentions, 5, 3);
  session.loopSuspicion = session.repeatedCommands.length > 0 && (session.failureMentions >= 2 || session.toolResults >= 4 || session.turns >= 12);
  session.loopConfidence = !session.loopSuspicion
    ? "low"
    : session.failureMentions >= 2 && session.repeatedCommands[0]?.count >= 5
      ? "high"
      : "medium";
  session.cost = tool === "claude-code"
    ? calculateClaudeCost({
        inputTokens: session.exactInputTokens,
        outputTokens: session.exactOutputTokens,
        cacheCreationTokens: session.exactCacheCreationTokens,
        cacheReadTokens: session.exactCacheReadTokens,
      }, session.model)
    : null;
  session.largestTextBlobs = session.largestTextBlobs.sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  return session;
}
function getCodexSessionFiles() {
  const codexHome = process.env.PRISMO_CODEX_HOME || path.join(os.homedir(), ".codex");
  return listFilesRecursive(path.join(codexHome, "sessions"), (file) => file.endsWith(".jsonl"), 200);
}
function getClaudeSessionFiles(cwd = process.cwd()) {
  const claudeHome = process.env.PRISMO_CLAUDE_HOME || path.join(os.homedir(), ".claude");
  const candidates = [cwd];
  try {
    candidates.push(fs.realpathSync(cwd));
  } catch {
    // Keep the original cwd candidate when realpath is unavailable.
  }
  const files = [];
  for (const candidate of Array.from(new Set(candidates))) {
    const safeProject = candidate.replace(/[\/\\:]/g, "-").replace(/^-/, "-");
    const projectDir = path.join(claudeHome, "projects", safeProject);
    files.push(...listFilesRecursive(projectDir, (file) => file.endsWith(".jsonl"), 200));
  }
  return Array.from(new Set(files));
}
function getAllClaudeSessionFiles() {
  const claudeHome = process.env.PRISMO_CLAUDE_HOME || path.join(os.homedir(), ".claude");
  return listFilesRecursive(path.join(claudeHome, "projects"), (file) => file.endsWith(".jsonl"), 1000);
}
function sameResolvedPath(a, b) {
  if (!a || !b) return false;
  try {
    const resolvedA = fs.existsSync(a) ? fs.realpathSync(a) : path.resolve(a);
    const resolvedB = fs.existsSync(b) ? fs.realpathSync(b) : path.resolve(b);
    return resolvedA === resolvedB;
  } catch {
    return false;
  }
}
function getUsageSummary(options = {}) {
  const tool = options.tool || "all";
  const limit = options.limit || 5;
  const cwd = options.cwd || process.cwd();
  const sessions = [];
  if (tool === "all" || tool === "codex") {
    for (const file of getCodexSessionFiles().slice(0, Math.max(limit * 8, 20))) {
      const session = analyzeSessionFile(file, "codex");
      if (!session.cwd || sameResolvedPath(session.cwd, cwd)) sessions.push(session);
      if (sessions.filter((item) => item.tool === "codex").length >= limit) break;
    }
  }
  if (tool === "all" || tool === "claude") {
    for (const file of getClaudeSessionFiles(cwd).slice(0, limit)) {
      sessions.push(analyzeSessionFile(file, "claude-code"));
    }
  }
  sessions.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  const selected = sessions.slice(0, limit);
  const totals = selected.reduce(
    (acc, session) => {
      acc.displayTokens += session.displayTokens || 0;
      acc.contextTokens += session.contextTokens || 0;
      acc.estimatedTokens += session.estimatedTotalTokens || 0;
      acc.exactTokens += session.exactAvailable ? session.exactTotalTokens : 0;
      acc.toolTokens += session.estimatedToolTokens || 0;
      acc.sessions += 1;
      return acc;
    },
    { sessions: 0, displayTokens: 0, contextTokens: 0, estimatedTokens: 0, exactTokens: 0, toolTokens: 0 }
  );
  const sources = Array.from(new Set(selected.map((session) => session.tool).filter(Boolean)));
  return {
    generatedAt: new Date().toISOString(),
    scannedPath: cwd,
    tool,
    tokenBudget: options.tokenBudget || null,
    confidence: selected.every((session) => session.exactAvailable) && selected.length ? "exact-local-log" : "mixed-or-estimated",
    totals,
    sources,
    sessions: selected,
  };
}

  return {
    analyzeSessionFile,
    getAllClaudeSessionFiles,
    getClaudeSessionFiles,
    getCodexSessionFiles,
    getUsageSummary,
  };
};
