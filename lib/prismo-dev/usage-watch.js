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

function listFilesRecursive(root, predicate = () => true, limit = 300) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length && files.length < limit) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  return files.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
}

function parseJsonl(filePath, maxLines = 20000) {
  const text = readIfText(filePath, 30 * 1024 * 1024);
  if (!text) return [];
  const rows = [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(Math.max(0, lines.length - maxLines))) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Local tool logs can contain partial writes while a session is active.
    }
  }
  return rows;
}

function collectText(value, options = {}, depth = 0) {
  if (value == null || depth > 8) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => collectText(item, options, depth + 1)).join("\n");
  if (typeof value !== "object") return "";

  const skipKeys = new Set(["signature", "encrypted_content", "image_url", "data", "auth", "api_key", "token"]);
  const parts = [];
  for (const [key, child] of Object.entries(value)) {
    if (skipKeys.has(key)) continue;
    parts.push(collectText(child, options, depth + 1));
  }
  return parts.filter(Boolean).join("\n");
}

function addUsage(target, usage) {
  if (!usage || typeof usage !== "object") return;
  target.inputTokens += Number(usage.input_tokens || usage.prompt_tokens || 0);
  target.outputTokens += Number(usage.output_tokens || usage.completion_tokens || 0);
  target.cacheReadTokens += Number(usage.cache_read_input_tokens || 0);
  target.cacheCreationTokens += Number(usage.cache_creation_input_tokens || 0);
}

function totalUsageTokens(usage) {
  if (!usage) return 0;
  return (
    Number(usage.input_tokens || usage.prompt_tokens || 0) +
    Number(usage.output_tokens || usage.completion_tokens || 0) +
    Number(usage.cache_read_input_tokens || 0) +
    Number(usage.cache_creation_input_tokens || 0)
  );
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

function getSessionRisk(tokens, toolTokens) {
  if (tokens >= 200000 || toolTokens >= 75000) return "High";
  if (tokens >= 60000 || toolTokens >= 20000) return "Medium";
  return "Low";
}

function incrementMap(map, key, amount = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
}

function normalizeMentionedPath(value, cwd = "") {
  let normalized = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^[`'"]+|[`'",:;)\]}]+$/g, "")
    .trim();
  normalized = normalized.replace(/^[ MADRCU?!]{1,4}\s+(?=\/|Users\/|home\/)/, "");
  const normalizedCwd = String(cwd || "").replace(/\\/g, "/");
  const wasAbsolute = normalized.startsWith("/");
  if (wasAbsolute && normalizedCwd && !normalized.startsWith(`${normalizedCwd}/`) && normalized !== normalizedCwd) {
    return "";
  }
  if (normalizedCwd && normalized.startsWith(normalizedCwd)) {
    normalized = normalized.slice(normalizedCwd.length);
  }
  normalized = normalized.replace(/^\.?\//, "");
  if (normalizedCwd) {
    const repoName = path.basename(normalizedCwd);
    const repoIndex = normalized.indexOf(`${repoName}/`);
    if (repoIndex >= 0) normalized = normalized.slice(repoIndex + repoName.length + 1);
  }
  return normalized;
}

function isGeneratedArtifactPath(relPath) {
  const normalized = normalizeMentionedPath(relPath);
  return GENERATED_ARTIFACT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function looksLikeUsefulPath(relPath) {
  const normalized = normalizeMentionedPath(relPath);
  if (!normalized || normalized.startsWith("http") || normalized.includes("://")) return false;
  if (normalized.length < 3 || normalized.split("/").some((part) => !part || part.length > 120)) return false;
  if (/^(Users|home|var|tmp|private|Volumes)\//i.test(normalized)) return false;
  if (/^(Users|home|var|tmp|Downloads|Code|Projects)$/i.test(normalized)) return false;
  if (isGeneratedArtifactPath(normalized)) return true;
  if (/\.[A-Za-z0-9]{1,12}$/.test(normalized)) return true;
  return /(^|\/)(src|app|lib|backend|frontend|tests|docs|scripts|components|pages|routes|api)\//.test(normalized);
}

function extractMentionedPaths(text, cwd = "") {
  const found = new Set();
  const source = String(text || "");
  const pathPattern = /(?:^|[\s"'`])((?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@+-]+\.[A-Za-z0-9]{1,12})/g;
  const filePattern = /(?:^|[\s"'`])((?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|coverage-final\.json|tsconfig\.json|pyproject\.toml|requirements\.txt|README\.md|CLAUDE\.md|AGENTS\.md))/g;
  for (const pattern of [pathPattern, filePattern]) {
    let match;
    while ((match = pattern.exec(source))) {
      const rel = normalizeMentionedPath(match[1], cwd);
      if (!looksLikeUsefulPath(rel)) continue;
      if (cwd && !isGeneratedArtifactPath(rel) && !fs.existsSync(path.join(cwd, rel))) continue;
      found.add(rel);
    }
  }
  return Array.from(found);
}

function normalizeCommand(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[;|&]+$/g, "")
    .trim()
    .slice(0, 160);
}

function isShellCommand(value) {
  return /^(npm|pnpm|yarn|bun|pytest|python3?|node|npx|uv|ruff|cargo|go|make|git|cd|rm|cp|mv|sed|rg|grep|find|cat)\b/.test(String(value || "").trim());
}

function extractCommandCandidates(row, text) {
  const commands = [];
  const directInputs = [
    row.payload?.input,
    row.payload?.arguments,
    row.message?.input,
    row.message?.arguments,
  ];
  for (const input of directInputs) {
    if (typeof input === "string") commands.push(input);
    else if (input && typeof input === "object") {
      for (const value of Object.values(input)) {
        if (typeof value === "string") commands.push(value);
      }
    }
  }
  const toolItems = Array.isArray(row.message?.content) ? row.message.content : [];
  for (const item of toolItems) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.input === "string") commands.push(item.input);
    if (item.input && typeof item.input === "object") {
      for (const value of Object.values(item.input)) {
        if (typeof value === "string") commands.push(value);
      }
    }
  }
  if (/tool_use|function_call/i.test(row.type || row.payload?.type || "")) {
    const commandPattern = /\b(?:npm|pnpm|yarn|bun|pytest|python3?|node|npx|uv|ruff|cargo|go test|make|git)\b[^\n\r"`']{0,140}/g;
    for (const match of String(text || "").matchAll(commandPattern)) {
      commands.push(match[0]);
    }
  }
  return Array.from(new Set(commands.map(normalizeCommand).filter((cmd) => cmd.length >= 3 && /\s/.test(cmd) && isShellCommand(cmd))));
}

function topCountEntries(map, limit = 5, minCount = 2) {
  return Object.entries(map || {})
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function isExpectedRepeatedPath(value) {
  const normalized = normalizeMentionedPath(value).toLowerCase();
  return ["claude.md", "agents.md", "readme.md"].includes(normalized) || normalized.endsWith("/readme.md");
}

function getActionableRepeatedPaths(session, limit = 3) {
  return (session.repeatedPathMentions || [])
    .filter((item) => !isExpectedRepeatedPath(item.value))
    .filter((item) => !isGeneratedArtifactPath(item.value))
    .slice(0, limit);
}

function summarizeGeneratedArtifacts(items = [], limit = 4) {
  const groups = new Map();
  for (const item of items) {
    const value = normalizeMentionedPath(item.value);
    let key = "generated files";
    if (value.includes("__pycache__/") || value.endsWith(".pyc")) key = "__pycache__";
    else if (value.includes("node_modules/")) key = "node_modules";
    else if (/package-lock\.json|pnpm-lock\.yaml|yarn\.lock$/i.test(value)) key = "lockfiles";
    else if (value.includes("/dist/") || value.startsWith("dist/")) key = "dist";
    else if (value.includes("/build/") || value.startsWith("build/")) key = "build";
    else if (value.includes("/coverage/") || value.startsWith("coverage/")) key = "coverage";
    else if (/(^|\/)assets\/[^/]+-[A-Za-z0-9_-]{6,}\.(js|css|map)$/i.test(value)) key = "hashed assets";
    const current = groups.get(key) || { type: key, count: 0, examples: [] };
    current.count += Number(item.count || 1);
    if (current.examples.length < 2) current.examples.push(value);
    groups.set(key, current);
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count).slice(0, limit);
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

function percentOf(part, total) {
  if (!total) return 0;
  return Math.round((Number(part || 0) / total) * 100);
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
    summary.live = buildLiveSessionView(summary);
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
    if (options.rescue && !options.json) {
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
    calculateClaudeCost,
    compactUsageSummary,
    formatMoney,
    formatTokenCount,
    getClaudeCodeCostSummary,
    getClaudeSessionFiles,
    getCodexSessionFiles,
    getUsageSummary,
    getPositionals,
    parsePositiveInt,
    parseScopeAndTarget,
    renderClaudeCostTerminal,
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
