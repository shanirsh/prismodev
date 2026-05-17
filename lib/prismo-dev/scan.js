module.exports = function createScan(deps) {
  const {
    fs,
    os,
    path,
    HIGH_RISK_DIRS,
    HIGH_RISK_FILE_NAMES,
    BINARY_EXTENSIONS,
    SOURCE_EXTENSIONS,
    INSTRUCTION_FILES,
    DEFAULT_CLAUDEIGNORE,
    NPX_COMMAND,
    estimateTokens,
    readIfText,
    detectFrameworks,
    getUsageSummary,
    getClaudeSessionFiles,
    getCodexSessionFiles,
    compactUsageSummary,
    formatTokenCount,
  } = deps;

function normalizeRel(value) {
  return value.split(path.sep).join("/");
}

function readIgnoreFile(root, fileName) {
  const filePath = path.join(root, fileName);
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.replace(/^!/, ""));
}

function patternMatches(pattern, relPath, isDir = false) {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\//, "");
  const normalizedRel = normalizeRel(relPath);
  const dirRel = isDir && !normalizedRel.endsWith("/") ? `${normalizedRel}/` : normalizedRel;

  if (!normalizedPattern) return false;
  if (normalizedPattern.endsWith("/")) {
    const base = normalizedPattern.slice(0, -1);
    return (
      normalizedRel === base ||
      normalizedRel.startsWith(`${base}/`) ||
      normalizedRel.endsWith(`/${base}`) ||
      normalizedRel.includes(`/${base}/`) ||
      dirRel.includes(`/${base}/`)
    );
  }
  if (normalizedPattern.startsWith("*.")) {
    return normalizedRel.endsWith(normalizedPattern.slice(1));
  }
  if (normalizedPattern.includes("*")) {
    const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`(^|/)${escaped}$`).test(normalizedRel);
  }
  return (
    normalizedRel === normalizedPattern ||
    dirRel === normalizedPattern ||
    normalizedRel.startsWith(`${normalizedPattern}/`) ||
    normalizedRel.endsWith(`/${normalizedPattern}`)
  );
}

function isIgnored(relPath, patterns, isDir = false) {
  return patterns.some((pattern) => patternMatches(pattern, relPath, isDir));
}

function getFileKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return "binary";
  if (name.endsWith(".log") || name.includes("log")) return "log";
  if (ext === ".json") return "json";
  if (name.endsWith(".min.js") || name.endsWith(".min.css")) return "minified";
  if (HIGH_RISK_FILE_NAMES.has(name)) return "lock/generated";
  return SOURCE_EXTENSIONS.has(ext) ? "source" : "text";
}

function isLikelyAppRoute(relPath) {
  const segments = relPath.split("/");
  const hasRouteGrouping = segments.some((s) => /^\(.*\)$/.test(s) || /^\[.*\]$/.test(s));
  const underAppDir = segments[0] === "app" || segments.some((s, i) => i < segments.length - 1 && (s === "app" || s === "pages" || s === "routes"));
  return hasRouteGrouping || (underAppDir && segments.length >= 3);
}

function walkRepo(root, ignorePatterns) {
  const files = [];
  const highRiskDirs = [];
  const stack = [root];
  const rootReal = fs.realpathSync(root);

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relPath = normalizeRel(path.relative(root, fullPath));
      if (!relPath || relPath === ".git") continue;
      if (relPath.startsWith(".git/")) continue;

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        const exposed = !isIgnored(relPath, ignorePatterns, true);
        if (HIGH_RISK_DIRS.includes(entry.name) && !isLikelyAppRoute(relPath)) {
          highRiskDirs.push({ path: relPath, exposed });
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (!fs.realpathSync(fullPath).startsWith(rootReal)) continue;

      const kind = getFileKind(fullPath);
      files.push({
        path: relPath,
        fullPath,
        size: stat.size,
        kind,
        ignored: isIgnored(relPath, ignorePatterns, false),
      });
    }
  }

  return { files, highRiskDirs };
}

function scanInstructionFiles(root) {
  const results = [];
  for (const rel of INSTRUCTION_FILES) {
    const filePath = path.join(root, rel);
    if (!fs.existsSync(filePath)) continue;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;
    const text = readIfText(filePath) || "";
    results.push({
      path: rel,
      size: stat.size,
      tokens: estimateTokens(text || stat.size),
      isClaude: path.basename(rel).toLowerCase() === "claude.md",
    });
  }
  return results;
}

function countJsonObjectKeys(value, keyName) {
  if (!value || typeof value !== "object") return 0;
  let count = 0;
  if (value[keyName] && typeof value[keyName] === "object") {
    count += Array.isArray(value[keyName]) ? value[keyName].length : Object.keys(value[keyName]).length;
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") count += countJsonObjectKeys(child, keyName);
  }
  return count;
}

function scanClaudeConfig(root) {
  const candidates = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(os.homedir(), ".claude.json"),
    path.join(root, ".claude", "settings.json"),
    path.join(root, ".claude.json"),
  ];
  const found = [];
  let mcpServers = 0;
  let hooks = 0;
  let pluginRefs = 0;

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    const text = readIfText(filePath);
    if (!text) continue;
    const rel = filePath.startsWith(root) ? normalizeRel(path.relative(root, filePath)) : filePath;
    found.push(rel);
    try {
      const json = JSON.parse(text);
      mcpServers += countJsonObjectKeys(json, "mcpServers");
      hooks += countJsonObjectKeys(json, "hooks");
    } catch {
      mcpServers += (text.match(/mcpServers|mcp_servers|mcp-server/g) || []).length;
      hooks += (text.match(/hooks|hook/g) || []).length;
    }
    pluginRefs += (text.match(/plugin|skill/gi) || []).length;
  }

  return { files: found, mcpServers, hooks, pluginRefs };
}

function scanCodexConfig(root) {
  const candidates = [
    path.join(root, ".codex", "config.toml"),
    path.join(os.homedir(), ".codex", "config.toml"),
    path.join(root, "AGENTS.md"),
  ];
  const found = [];
  let mcpServers = 0;

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    const text = readIfText(filePath);
    if (!text) continue;
    found.push(filePath.startsWith(root) ? normalizeRel(path.relative(root, filePath)) : filePath);
    mcpServers += (text.match(/\[mcp|mcp_servers|mcp-server|server\]/gi) || []).length;
  }
  return { files: found, mcpServers };
}

function commandExists(command) {
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? [command, `${command}.cmd`, `${command}.exe`, `${command}.ps1`] : [command];
  return pathEntries.some((entry) => names.some((name) => fs.existsSync(path.join(entry, name))));
}

function pathExistsAny(paths) {
  return paths.some((candidate) => fs.existsSync(candidate));
}

function detectOptimizationStack(root, claudeConfig, codexConfig) {
  const projectClaudePlugin = fs.existsSync(path.join(root, ".claude-plugin")) || fs.existsSync(path.join(root, ".claude", "settings.json"));
  const projectMana = fs.existsSync(path.join(root, ".mana-mcp.json")) || fs.existsSync(path.join(os.homedir(), ".mana"));
  const projectHeadroom = fs.existsSync(path.join(root, ".headroom")) || fs.existsSync(path.join(os.homedir(), ".headroom"));
  const projectDistill = fs.existsSync(path.join(os.homedir(), ".config", "distill")) || commandExists("distill");
  const projectRtk = fs.existsSync(path.join(root, ".rtk")) || commandExists("rtk");

  const tools = {
    rtk: { detected: projectRtk, source: projectRtk ? "binary-or-project-config" : "not-detected" },
    headroom: { detected: projectHeadroom || commandExists("headroom"), source: projectHeadroom ? "local-config" : commandExists("headroom") ? "binary" : "not-detected" },
    distill: { detected: projectDistill, source: projectDistill ? "binary-or-user-config" : "not-detected" },
    mana: { detected: projectMana || commandExists("mana"), source: projectMana ? "local-config" : commandExists("mana") ? "binary" : "not-detected" },
  };

  return {
    tools,
    claudeHooks: claudeConfig.hooks,
    claudeMcpServers: claudeConfig.mcpServers,
    codexMcpServers: codexConfig.mcpServers,
    claudePluginDetected: projectClaudePlugin,
    mcpServerTotal: claudeConfig.mcpServers + codexConfig.mcpServers,
    detectedTools: Object.entries(tools).filter(([, value]) => value.detected).map(([name]) => name),
  };
}

function detectAgentReadiness(root, claudeConfig, codexConfig, realUsage) {
  const claudeHome = process.env.PRISMO_CLAUDE_HOME || path.join(os.homedir(), ".claude");
  const codexHome = process.env.PRISMO_CODEX_HOME || path.join(os.homedir(), ".codex");
  const cursorPaths = [
    path.join(root, ".cursor"),
    path.join(root, ".cursorrules"),
    path.join(os.homedir(), ".cursor"),
    path.join(os.homedir(), ".config", "Cursor"),
  ];
  const usageSources = new Set(realUsage && realUsage.sources ? realUsage.sources : []);

  const claudeSessionFiles = getClaudeSessionFiles(root);
  const codexSessionFiles = getCodexSessionFiles();

  return {
    claudeCode: {
      detected: claudeConfig.files.length > 0 || fs.existsSync(claudeHome) || claudeSessionFiles.length > 0,
      configFiles: claudeConfig.files,
      localLogsFound: claudeSessionFiles.length > 0 || usageSources.has("claude-code"),
      mcpServers: claudeConfig.mcpServers,
      hooks: claudeConfig.hooks,
      exactProxyTracking: "limited-for-subscription-mode",
      recommendedMode: "local-log-and-repo-scan",
    },
    codex: {
      detected: codexConfig.files.length > 0 || fs.existsSync(codexHome) || codexSessionFiles.length > 0,
      configFiles: codexConfig.files,
      localLogsFound: codexSessionFiles.length > 0 || usageSources.has("codex"),
      mcpServers: codexConfig.mcpServers,
      exactProxyTracking: "available-when-using-api-key-base-url-mode",
      recommendedMode: "prismo-proxy-for-api-mode-or-local-log-watch",
    },
    cursor: {
      detected: pathExistsAny(cursorPaths),
      configFiles: cursorPaths.filter((candidate) => fs.existsSync(candidate)),
      localLogsFound: false,
      exactProxyTracking: "available-only-if-configured-for-openai-compatible-base-url",
      recommendedMode: "repo-scan-and-prismo-proxy-when-supported",
    },
    localUsageLogsAvailable: Boolean((realUsage && realUsage.sessions.length) || claudeSessionFiles.length || codexSessionFiles.length),
    exactProxyTrackingAvailable: true,
    notes: [
      "Exact tracking is available when a tool sends OpenAI/Anthropic API traffic through Prismo.",
      "Subscription coding-agent sessions usually require local-log visibility unless the tool supports a custom base URL.",
    ],
  };
}

function detectToolOutputRisk({ exposedLargeFiles, exposedHighRiskDirs, highRiskDirs }) {
  const noisyDirs = highRiskDirs.filter((dir) => ["coverage", "test-results", "playwright-report", "logs", "dist", "build", ".next"].some((name) => dir.path.split("/").includes(name)));
  const exposedNoisyDirs = exposedHighRiskDirs.filter((dir) => noisyDirs.some((candidate) => candidate.path === dir.path));
  const noisyFiles = exposedLargeFiles.filter((file) => ["log", "json", "minified", "lock/generated"].includes(file.kind) || /\.(log|json|ndjson|out|trace|har)$/i.test(file.path));
  const estimatedExposureTokens = estimateTokens(noisyFiles.reduce((sum, file) => sum + file.size, 0));
  let level = "Low";
  if (exposedNoisyDirs.length >= 3 || noisyFiles.length >= 3 || estimatedExposureTokens >= 250000) level = "High";
  else if (exposedNoisyDirs.length || noisyFiles.length || estimatedExposureTokens >= 50000) level = "Medium";

  return {
    level,
    exposedNoisyDirectories: exposedNoisyDirs.map((dir) => dir.path),
    noisyDirectoriesDetected: noisyDirs.map((dir) => ({ path: dir.path, exposed: dir.exposed })),
    exposedNoisyFiles: noisyFiles.map((file) => ({
      path: file.path,
      kind: file.kind,
      sizeBytes: file.size,
      estimatedTokensIfRead: estimateTokens(file.size),
    })),
    estimatedExposureTokens,
    summary:
      level === "High"
        ? "Large logs, test reports, build output, or generated files are exposed to coding-agent reads."
        : level === "Medium"
          ? "Some noisy tool-output artifacts are present and may enter context during broad exploration."
          : "No major exposed tool-output artifacts detected.",
  };
}

function buildProxyTrackingReadiness({ codexConfig, claudeConfig, realUsage }) {
  return {
    exactApiTracking: {
      available: true,
      description: "Available for apps and coding tools that send OpenAI or Anthropic API traffic through the Prismo base URL.",
    },
    codingAgentBaseUrlMode: {
      codex: codexConfig.files.length ? "possible-if-using-api-key-mode" : "not-detected",
      claudeCode: "limited-for-subscription-sessions",
      cursor: "possible-if-configured-for-openai-compatible-provider",
    },
    localEstimateTracking: {
      available: true,
      logsFound: Boolean(realUsage && realUsage.sessions.length),
      description: "Available for subscription coding tools when local Codex/Claude Code logs exist; accuracy depends on token fields exposed by those tools.",
    },
    unsupported: [
      "Exact billing for hidden subscription sessions without provider traffic, API keys, or local token fields.",
      "Prompt interception or tool rewriting is not enabled by PrismoDev Scan.",
    ],
  };
}

function checkUrlReachable(url, timeoutMs = 650) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ url, reachable: false, error: "invalid-url" });
      return;
    }
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.request(
      {
        method: "GET",
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname === "/" ? "/health" : parsed.pathname,
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        resolve({ url, reachable: response.statusCode >= 200 && response.statusCode < 500, statusCode: response.statusCode });
      }
    );
    request.on("timeout", () => {
      request.destroy();
      resolve({ url, reachable: false, error: "timeout" });
    });
    request.on("error", (error) => {
      resolve({ url, reachable: false, error: error.code || error.message });
    });
    request.end();
  });
}

async function runSetup(rootDir = process.cwd(), options = {}) {
  const scan = scanRepo(rootDir, { includeUsage: true, usageLimit: options.limit || 3 });
  const proxyUrl = options.proxyUrl || DEFAULT_PRISMO_PROXY_URL;
  const proxy = options.skipProxyCheck
    ? { url: proxyUrl, reachable: false, skipped: true }
    : await checkUrlReachable(proxyUrl, options.timeoutMs || 650);

  const modes = [
    {
      id: "local-log-tracking",
      label: "Local log tracking",
      status: scan.agentReadiness.localUsageLogsAvailable ? "available" : "limited",
      description: "Reads local Codex/Claude Code session logs when present. Good for subscription coding tools when exact proxy traffic is unavailable.",
    },
    {
      id: "exact-api-proxy",
      label: "Exact API proxy tracking",
      status: proxy.reachable ? "available" : "proxy-not-running",
      description: "Exact tokens, costs, routing, budgets, and analytics when app or coding-tool traffic uses the Prismo OpenAI/Anthropic base URL.",
    },
    {
      id: "codex-base-url",
      label: "Codex API/base-url mode",
      status: scan.agentReadiness.codex.detected ? "possible" : "not-detected",
      description: "Use Prismo for exact tracking when Codex is running with API-key/base-url compatible traffic.",
    },
    {
      id: "claude-subscription",
      label: "Claude subscription sessions",
      status: scan.agentReadiness.claudeCode.detected ? "local-estimates-only" : "not-detected",
      description: "Claude Code subscription traffic is not exact unless it can be routed through Prismo; use local logs and repo diagnostics otherwise.",
    },
  ];

  const recommended = [];
  recommended.push(`${NPX_COMMAND} watch`);
  if (!scan.hasClaudeIgnore) recommended.push(`${NPX_COMMAND} scan --fix`);
  recommended.push(`${NPX_COMMAND} optimize`);
  if (proxy.reachable) {
    recommended.push(`OPENAI_BASE_URL=${proxyUrl.replace(/\/$/, "")}/v1 codex`);
  } else {
    recommended.push("Start the Prismo proxy, then route API-mode tools through its OpenAI/Anthropic base URL.");
  }

  return {
    scannedPath: scan.root,
    generatedAt: new Date().toISOString(),
    prismoProxy: proxy,
    detected: {
      claudeCode: scan.agentReadiness.claudeCode,
      codex: scan.agentReadiness.codex,
      cursor: scan.agentReadiness.cursor,
      optimizationStack: scan.optimizationStack,
      localUsageLogsAvailable: scan.agentReadiness.localUsageLogsAvailable,
    },
    trackingModes: modes,
    recommendedCommands: Array.from(new Set(recommended)).slice(0, 5),
    caveats: [
      "Prismo can track exact usage only when traffic flows through the Prismo proxy.",
      "Subscription coding tools may expose local logs, but those are local visibility signals rather than provider billing records.",
      "Setup is read-only and does not modify Claude, Codex, Cursor, MCP, shell, or Prismo config.",
    ],
  };
}

function renderSetupTerminal(result) {
  const lines = [];
  lines.push("");
  lines.push(color("PrismoDev Setup", "bold"));
  lines.push("");
  lines.push(`Repo: ${result.scannedPath}`);
  lines.push(`Prismo proxy: ${result.prismoProxy.reachable ? "running" : "not reachable"} (${result.prismoProxy.url})`);
  if (result.prismoProxy.statusCode) lines.push(`Proxy status: HTTP ${result.prismoProxy.statusCode}`);
  lines.push("");
  lines.push("Detected:");
  lines.push(`- Claude Code: ${result.detected.claudeCode.detected ? "detected" : "not detected"}; logs: ${result.detected.claudeCode.localLogsFound ? "found" : "not found"}; MCP: ${result.detected.claudeCode.mcpServers}; hooks: ${result.detected.claudeCode.hooks}`);
  lines.push(`- Codex: ${result.detected.codex.detected ? "detected" : "not detected"}; logs: ${result.detected.codex.localLogsFound ? "found" : "not found"}; MCP: ${result.detected.codex.mcpServers}`);
  lines.push(`- Cursor: ${result.detected.cursor.detected ? "detected" : "not detected"}`);
  const detectedTools = result.detected.optimizationStack.detectedTools;
  lines.push(`- Optimization tools: ${detectedTools.length ? detectedTools.join(", ") : "none detected"}`);
  lines.push("");
  lines.push("Tracking Modes:");
  result.trackingModes.forEach((mode, index) => {
    lines.push(`${index + 1}. ${mode.label}: ${mode.status}`);
    lines.push(`   ${mode.description}`);
  });
  lines.push("");
  lines.push("Recommended:");
  result.recommendedCommands.forEach((command, index) => lines.push(`${index + 1}. ${command}`));
  lines.push("");
  lines.push("Notes:");
  result.caveats.forEach((caveat) => lines.push(`- ${caveat}`));
  return lines.join("\n");
}

function classifyLargeFiles(files) {
  return files
    .filter((file) => file.kind !== "binary" && file.size >= 500 * 1024)
    .sort((a, b) => b.size - a.size)
    .map((file) => ({
      path: file.path,
      size: file.size,
      mb: file.size / (1024 * 1024),
      kind: file.kind,
      ignored: file.ignored,
    }));
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function estimateClaudeInstructionImpact(tokens) {
  if (!tokens || tokens <= 800) return null;
  const extra = Math.max(0, tokens - 800);
  const avgTurnsPerSession = 40;
  const costPer1kInput = 0.003;
  const sessionCost = ((extra * avgTurnsPerSession) / 1000) * costPer1kInput;
  const monthlyCost = sessionCost * 30;
  return `Estimated cost: ~$${sessionCost.toFixed(2)}/session ($${monthlyCost.toFixed(2)}/month at 1 session/day). ${extra.toLocaleString()} extra tokens loading every turn above the ~800 token baseline.`;
}

function estimateLargeFileImpact(files) {
  if (!files.length) return null;
  const totalTokens = files.reduce((sum, file) => sum + estimateTokens(file.size), 0);
  return `Likely avoidable token exposure: up to ~${totalTokens.toLocaleString()} tokens if these files are read into agent context.`;
}

function estimateRiskyDirImpact(dirs) {
  if (!dirs.length) return null;
  return "Likely avoidable token exposure: generated/cache directories can create high repo-read risk when agents explore broadly.";
}

function estimateMcpImpact(count) {
  if (!count || count < 5) return null;
  return "Possible baseline/tool overhead: many MCP servers can expand tool choice and produce extra tool traffic.";
}

function severityWeight(severity) {
  return severity === "critical" ? 10 : severity === "high" ? 6 : severity === "medium" ? 4 : 2;
}

function severityRank(severity) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[severity] ?? 4;
}

function addIssue(issues, severity, category, title, description, recommendation, estimatedTokenImpact = null) {
  issues.push({
    severity,
    category,
    title,
    description,
    recommendation,
    estimatedTokenImpact,
  });
}

function buildRecommendations({ hasClaudeIgnore, gitignorePatterns, exposedHighRiskDirs, largeFiles, instructionFiles, claudeConfig, toolOutputRisk, agentReadiness }) {
  const recs = [];
  if (!hasClaudeIgnore) {
    recs.push("Create .claudeignore with generated/cache folders and large artifacts excluded.");
  }
  if (gitignorePatterns.length && !hasClaudeIgnore) {
    recs.push("Use .gitignore as the baseline for .claudeignore, then add AI-specific exclusions.");
  }
  if (exposedHighRiskDirs.length) {
    recs.push(`Ignore generated/cache folders: ${exposedHighRiskDirs.slice(0, 8).map((d) => `${d.path}/`).join(", ")}.`);
  }
  if (largeFiles.some((file) => !file.ignored)) {
    recs.push("Avoid loading large logs, JSON dumps, coverage reports, and minified assets into coding-agent context.");
  }
  if (toolOutputRisk && toolOutputRisk.level !== "Low") {
    recs.push("Use command-output filtering or narrower shell commands for noisy tests, logs, diffs, and generated reports.");
  }
  if (instructionFiles.some((file) => file.isClaude && file.tokens > 1500)) {
    recs.push("Review CLAUDE.md for content that could move to linked docs; keep persistent instructions focused on durable rules.");
  }
  if (claudeConfig.mcpServers >= 5) {
    recs.push("Disable MCP servers that are not needed for the current project or task.");
  }
  recs.push("Start fresh sessions for unrelated tasks and compact long sessions when context growth accelerates.");
  recs.push("Use cheaper/faster models for mechanical edits, formatting, and low-risk refactors.");
  if (agentReadiness && (agentReadiness.codex.detected || agentReadiness.claudeCode.detected)) {
    recs.push("Run `npx getprismo watch` for local coding-session visibility while working.");
  }
  recs.push("Route API-mode coding tools through Prismo when they support custom OpenAI/Anthropic base URLs for exact cost tracking.");
  return Array.from(new Set(recs));
}

function scoreScan(issues, stats, context = {}) {
  const issuePenalty = issues.reduce((sum, issue) => sum + severityWeight(issue.severity), 0);
  const repoPenalty =
    (stats.totalFiles > 2500 ? 4 : 0) +
    (stats.exposedLargeFiles > 10 ? 4 : 0) +
    (stats.exposedHighRiskDirs > 4 ? 4 : 0);
  const toolOutputPenalty = context.toolOutputRisk && context.toolOutputRisk.level === "High" ? 8 : context.toolOutputRisk && context.toolOutputRisk.level === "Medium" ? 4 : 0;
  const readinessCredit = context.agentReadiness && context.agentReadiness.localUsageLogsAvailable ? 3 : 0;
  const proxyCredit = context.proxyTrackingReadiness && context.proxyTrackingReadiness.exactApiTracking.available ? 2 : 0;

  let score = 100 - issuePenalty - repoPenalty - toolOutputPenalty + readinessCredit + proxyCredit;
  score = Math.max(0, Math.min(100, score));

  const risk = score >= 80 ? "Low" : score >= 55 ? "Medium" : "High";
  const avoidableWaste = risk === "Low" ? "5-15%" : risk === "Medium" ? "20-40%" : "40-65%";
  return { score, risk, avoidableWaste };
}

function getTopTokenLeaks(issues, limit = 5) {
  return [...issues]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, limit)
    .map((issue) => issue.title);
}

function getNextCommands(result, scope = null) {
  const commands = [];
  if (!result.hasClaudeIgnore || result.issues.some((issue) => ["instruction_file", "codex_config"].includes(issue.category))) {
    commands.push(`${NPX_COMMAND} scan --fix`);
  }
  commands.push(`${NPX_COMMAND} optimize`);
  if (scope) commands.push(`${NPX_COMMAND} context ${scope}`);
  else commands.push(result.stats.sourceFiles ? `${NPX_COMMAND} context` : `${NPX_COMMAND} --help`);
  if (result.realUsage && result.realUsage.sessions.length) commands.push(`${NPX_COMMAND} usage --limit 3`);
  else commands.push(`${NPX_COMMAND} scan --usage`);
  return Array.from(new Set(commands)).slice(0, 4);
}

function estimateExposedContextTokens(result) {
  if (!result) return 0;
  const largeFileTokens = (result.exposedLargeFiles || []).reduce((sum, file) => sum + estimateTokens(file.size), 0);
  const riskyDirTokens = (result.exposedHighRiskDirs || []).length * 50000;
  const instructionExcessTokens = (result.instructionFiles || []).reduce((sum, file) => sum + Math.max(0, (file.tokens || 0) - 500), 0);
  const toolOutputTokens = result.toolOutputRisk && result.toolOutputRisk.level === "High" ? 50000 : result.toolOutputRisk && result.toolOutputRisk.level === "Medium" ? 20000 : 0;
  return largeFileTokens + riskyDirTokens + instructionExcessTokens + toolOutputTokens;
}

function calculateReductionPercent(beforeTokens, afterTokens) {
  if (!beforeTokens || beforeTokens <= 0) return 0;
  const reduction = Math.max(0, beforeTokens - Math.max(0, afterTokens || 0));
  return Math.round((reduction / beforeTokens) * 100);
}

function chooseRecommendedScope(ctx) {
  if (ctx.scope) return ctx.scope;
  if (ctx.frameworks.some((name) => ["Next.js", "React", "Vite"].includes(name))) return "frontend";
  if (ctx.frameworks.some((name) => ["FastAPI", "Django", "Flask", "Python"].includes(name))) return "backend";
  return null;
}

function toJsonPayload(result) {
  const payload = {
    schemaVersion: 1,
    score: result.score,
    riskLevel: result.risk,
    estimatedAvoidableWasteRange: result.avoidableWaste,
    detectedFrameworks: result.frameworks,
    stats: result.stats,
    issues: result.issues,
    recommendations: result.recommendations,
    largeFiles: result.largeFiles.map((file) => ({
      path: file.path,
      sizeBytes: file.size,
      sizeLabel: formatBytes(file.size),
      kind: file.kind,
      ignored: file.ignored,
      estimatedTokensIfRead: estimateTokens(file.size),
    })),
    riskyDirectories: result.highRiskDirs.map((dir) => ({
      path: dir.path,
      exposed: dir.exposed,
    })),
    instructionFiles: result.instructionFiles.map((file) => ({
      path: file.path,
      sizeBytes: file.size,
      estimatedTokens: file.tokens,
      type: file.isClaude ? "claude" : file.path === "AGENTS.md" || file.path.startsWith(".codex/") ? "codex" : "general",
    })),
    claudeFindings: {
      hasClaudeMd: result.instructionFiles.some((file) => file.isClaude),
      hasClaudeIgnore: result.hasClaudeIgnore,
      configFiles: result.claudeConfig.files,
      mcpServers: result.claudeConfig.mcpServers,
      hooks: result.claudeConfig.hooks,
      pluginRefs: result.claudeConfig.pluginRefs,
    },
    codexFindings: {
      configFiles: result.codexConfig.files,
      mcpServers: result.codexConfig.mcpServers,
      hasAgentsMd: result.instructionFiles.some((file) => file.path === "AGENTS.md"),
      hasCodexDirectory: fs.existsSync(path.join(result.root, ".codex")),
      hasOpenAiDirectory: fs.existsSync(path.join(result.root, ".openai")),
    },
    cursorFindings: {
      hasCursorIgnore: result.hasCursorIgnore,
      hasCursorDirectory: fs.existsSync(path.join(result.root, ".cursor")),
    },
    agentReadiness: result.agentReadiness,
    optimizationStack: result.optimizationStack,
    toolOutputRisk: result.toolOutputRisk,
    proxyTrackingReadiness: result.proxyTrackingReadiness,
    suggestedClaudeIgnore: result.recommendedClaudeIgnore,
    suggestedCursorIgnore: result.recommendedCursorIgnore,
    nextCommands: getNextCommands(result),
    generatedAt: result.generatedAt,
    scannedPath: result.root,
  };
  if (result.realUsage) payload.realUsage = compactUsageSummary(result.realUsage);
  return payload;
}

function addRealUsageIssues(issues, usage) {
  if (!usage || !usage.sessions.length) return;
  const total = usage.totals.displayTokens || 0;
  const exact = usage.totals.exactTokens || 0;
  const toolTokens = usage.totals.toolTokens || 0;
  const highRiskSessions = usage.sessions.filter((session) => session.contextRisk === "High");

  if (total >= 1000000) {
    addIssue(
      issues,
      total >= 10000000 ? "high" : "medium",
      "repo_size",
      `Recent local AI sessions used ${formatTokenCount(total)} tokens`,
      exact ? "Prismo found exact token counts in local Codex/Claude Code session logs." : "Prismo estimated usage from local session text because exact token fields were unavailable.",
      "Use Prismo Optimize context packs, compact long sessions, and start fresh sessions for unrelated tasks.",
      exact
        ? `Actual local usage observed: ${total.toLocaleString()} tokens across ${usage.sessions.length} recent session(s).`
        : `Estimated local usage observed: ${total.toLocaleString()} tokens across ${usage.sessions.length} recent session(s).`
    );
  }

  if (toolTokens >= 50000) {
    addIssue(
      issues,
      toolTokens >= 150000 ? "high" : "medium",
      "mcp_tooling",
      `Tool output/context contributed about ${formatTokenCount(toolTokens)} tokens`,
      "Large tool results and repeated command output can dominate coding-agent context.",
      "Prefer targeted file reads and summarize long logs before pasting or loading them.",
      `Local session estimate: about ${toolTokens.toLocaleString()} tool/output tokens in recent sessions.`
    );
  }

  if (highRiskSessions.length) {
    addIssue(
      issues,
      "medium",
      "repo_size",
      `${highRiskSessions.length} recent session${highRiskSessions.length === 1 ? "" : "s"} reached high context risk`,
      "Long-running sessions tend to accumulate stale context, repeated reads, and tool output.",
      "Start a new session after major task boundaries and use scoped `.prismo/*-context.md` files.",
      "Actual/observed local sessions crossed Prismo's high context-risk threshold."
    );
  }
}

function buildRealUsageRecommendations(usage) {
  if (!usage || !usage.sessions.length) return [];
  const recs = [];
  if (usage.totals.displayTokens >= 1000000) {
    recs.push("Use real session usage as the primary optimization signal; prioritize reducing the largest recent sessions first.");
    recs.push("Run `prismo optimize` and start coding sessions from `.prismo/architecture-summary.md` instead of broad repo exploration.");
  }
  if (usage.totals.toolTokens >= 50000) {
    recs.push("Reduce large tool outputs by narrowing commands, reading smaller file ranges, and summarizing logs before loading them.");
  }
  if (usage.sessions.some((session) => session.turns >= 25)) {
    recs.push("Split long-running coding sessions at task boundaries to prevent context accumulation.");
  }
  return recs;
}

function scanRepo(rootDir = process.cwd(), options = {}) {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root)) {
    throw new Error(`Path not found: ${root}`);
  }
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch (error) {
    throw new Error(`Cannot access path: ${root}. ${error.message}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Expected a directory to scan, got: ${root}`);
  }
  const hasGitignore = fs.existsSync(path.join(root, ".gitignore"));
  const hasClaudeIgnore = fs.existsSync(path.join(root, ".claudeignore"));
  const hasCursorIgnore = fs.existsSync(path.join(root, ".cursorignore"));
  const repoDetected = fs.existsSync(path.join(root, ".git")) || fs.existsSync(path.join(root, "package.json")) || fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "go.mod")) || fs.existsSync(path.join(root, "Cargo.toml"));
  const gitignorePatterns = readIgnoreFile(root, ".gitignore");
  const claudeIgnorePatterns = readIgnoreFile(root, ".claudeignore");
  const cursorIgnorePatterns = readIgnoreFile(root, ".cursorignore");
  const combinedIgnorePatterns = Array.from(new Set([...gitignorePatterns, ...claudeIgnorePatterns, ...cursorIgnorePatterns]));

  const { files, highRiskDirs } = walkRepo(root, combinedIgnorePatterns);
  const frameworks = detectFrameworks(root, { files });
  const instructionFiles = scanInstructionFiles(root);
  const largeFiles = classifyLargeFiles(files);
  const exposedLargeFiles = largeFiles.filter((file) => !file.ignored);
  const exposedHighRiskDirs = highRiskDirs.filter((dir) => dir.exposed);
  const ignoredHighRiskDirs = highRiskDirs.filter((dir) => !dir.exposed);
  const claudeConfig = scanClaudeConfig(root);
  const codexConfig = scanCodexConfig(root);

  const issues = [];

  const claudeFile = instructionFiles.find((file) => file.isClaude);
  if (claudeFile && claudeFile.tokens > 3000) {
    addIssue(
      issues,
      "high",
      "instruction_file",
      `CLAUDE.md is ~${claudeFile.tokens.toLocaleString()} tokens`,
      "Large persistent instruction files raise baseline token usage every turn in Claude Code sessions.",
      "Move implementation details and long context into linked docs; keep CLAUDE.md focused on durable rules.",
      estimateClaudeInstructionImpact(claudeFile.tokens)
    );
  } else if (claudeFile && claudeFile.tokens > 1500) {
    addIssue(
      issues,
      "medium",
      "instruction_file",
      `CLAUDE.md is ~${claudeFile.tokens.toLocaleString()} tokens`,
      "Persistent instructions above ~1500 tokens add recurring baseline cost to every turn.",
      "Review whether all content needs to be persistent or if some can move to on-demand docs.",
      estimateClaudeInstructionImpact(claudeFile.tokens)
    );
  } else if (claudeFile && claudeFile.tokens > 800) {
    addIssue(
      issues,
      "low",
      "instruction_file",
      `CLAUDE.md is ~${claudeFile.tokens.toLocaleString()} tokens`,
      "Instruction file is moderately sized.",
      "Keep CLAUDE.md focused on durable project rules.",
      estimateClaudeInstructionImpact(claudeFile.tokens)
    );
  }

  for (const file of instructionFiles.filter((item) => !item.isClaude && item.tokens > 2000)) {
    const isReadme = file.path.toLowerCase().startsWith("readme");
    const isCodex = file.path.toLowerCase().includes("codex") || file.path === "AGENTS.md";
    if (isReadme && file.tokens <= 5000) {
      addIssue(
        issues,
        "low",
        "instruction_file",
        `${file.path} is ~${file.tokens.toLocaleString()} tokens`,
        "Agents may read this file for project context during exploration.",
        "Consider adding a shorter project summary in CLAUDE.md or .prismo/ context packs for focused sessions.",
        `Potential savings estimate: reduce repeated baseline context by trimming or splitting this ~${file.tokens.toLocaleString()} token file.`
      );
    } else {
      addIssue(
        issues,
        "medium",
        isCodex ? "codex_config" : "instruction_file",
        `${file.path} is ~${file.tokens.toLocaleString()} tokens`,
        isReadme
          ? "Very large README files may be fully loaded by agents during project exploration."
          : "Large instruction/readme files may be repeatedly loaded by coding agents.",
        isReadme
          ? "Ensure agents use .prismo/ context packs instead of loading the full README into every session."
          : "Split long context into task-specific docs and reference only what is needed.",
        `Potential savings estimate: reduce repeated baseline context by trimming or splitting this ~${file.tokens.toLocaleString()} token file.`
      );
    }
  }

  for (const file of instructionFiles.filter((item) => !item.isClaude && item.tokens > 500 && item.tokens <= 2000)) {
    const isReadme = file.path.toLowerCase().startsWith("readme");
    if (isReadme) continue;
    addIssue(
      issues,
      "low",
      file.path.toLowerCase().includes("codex") || file.path === "AGENTS.md" ? "codex_config" : "instruction_file",
      `${file.path} is ~${file.tokens.toLocaleString()} tokens`,
      "Moderately large project instructions can become recurring baseline context in coding-agent workflows.",
      "Keep persistent instructions concise and move task-specific notes into separate docs.",
      `Potential savings estimate: review this ~${file.tokens.toLocaleString()} token file for repeated context bloat.`
    );
  }

  if (!hasClaudeIgnore) {
    addIssue(
      issues,
      exposedHighRiskDirs.length > 5 && exposedLargeFiles.length > 3 ? "critical" : "high",
      "ignore_file",
      ".claudeignore not found",
      "Claude Code-style workflows may expose generated files, caches, and logs unless they are ignored.",
      "Create .claudeignore using the generated suggestions.",
      exposedHighRiskDirs.length || exposedLargeFiles.length
        ? "Likely avoidable token exposure: missing ignore coverage plus exposed large/generated files increases broad repo-read risk."
        : "Potential savings estimate: prevents generated files and logs from entering future agent context."
    );
  }

  if (!hasGitignore) {
    addIssue(
      issues,
      "medium",
      "ignore_file",
      ".gitignore not found",
      "Missing .gitignore makes it harder to infer generated or irrelevant files.",
      "Create .gitignore and mirror relevant entries into .claudeignore.",
      "Potential savings estimate: better ignore baselines reduce accidental generated-file exposure."
    );
  }

  if (exposedHighRiskDirs.length) {
    addIssue(
      issues,
      exposedHighRiskDirs.length > 5 && !hasClaudeIgnore ? "critical" : exposedHighRiskDirs.length > 3 ? "high" : "medium",
      "risky_directory",
      `${exposedHighRiskDirs.length} token-bloat director${exposedHighRiskDirs.length === 1 ? "y" : "ies"} may be visible`,
      exposedHighRiskDirs.slice(0, 8).map((dir) => `${dir.path}/`).join(", "),
      "Ignore generated/cache/build folders for coding-agent workflows.",
      estimateRiskyDirImpact(exposedHighRiskDirs)
    );
  }

  if (exposedLargeFiles.length) {
    addIssue(
      issues,
      exposedLargeFiles.some((file) => file.size >= 1024 * 1024) ? "high" : "medium",
      "large_file",
      `${exposedLargeFiles.length} exposed large file${exposedLargeFiles.length === 1 ? "" : "s"} detected`,
      exposedLargeFiles.slice(0, 6).map((file) => `${file.path} (${formatBytes(file.size)})`).join(", "),
      "Avoid loading large artifacts directly; add generated/log files to .claudeignore.",
      estimateLargeFileImpact(exposedLargeFiles)
    );
  }

  if (claudeConfig.mcpServers >= 5) {
    addIssue(
      issues,
      "medium",
      "mcp_tooling",
      `${claudeConfig.mcpServers} MCP servers detected in Claude config`,
      "Many active MCP servers can increase tool overhead and agent search space.",
      "Disable MCP servers not needed for the current repo.",
      estimateMcpImpact(claudeConfig.mcpServers)
    );
  }

  if (claudeConfig.hooks >= 5) {
    addIssue(
      issues,
      "low",
      "claude_config",
      `${claudeConfig.hooks} Claude hooks detected`,
      "Large hook setups can add workflow overhead or noisy tool results.",
      "Keep hooks scoped to the current workflow.",
      "Possible workflow overhead: hook output can add noisy tool results if it is too broad."
    );
  }

  if (codexConfig.mcpServers >= 5) {
    addIssue(
      issues,
      "medium",
      "codex_config",
      `${codexConfig.mcpServers} MCP/tool references detected in Codex config`,
      "Large tool surfaces can add overhead in OpenAI/Codex workflows.",
      "Keep Codex tools scoped to the task.",
      estimateMcpImpact(codexConfig.mcpServers)
    );
  }

  if (!repoDetected) {
    addIssue(
      issues,
      "low",
      "repo_size",
      "No common repo marker detected",
      "Prismo did not find .git, package.json, pyproject.toml, go.mod, or Cargo.toml at the scan root.",
      "Run Prismo from the repository root for the most useful results.",
      "No token estimate; this is an onboarding/setup warning."
    );
  }

  const realUsage = options.includeUsage ? getUsageSummary({ tool: options.usageTool || "all", cwd: root, limit: options.usageLimit || 5 }) : null;
  addRealUsageIssues(issues, realUsage);
  const optimizationStack = detectOptimizationStack(root, claudeConfig, codexConfig);
  const agentReadiness = detectAgentReadiness(root, claudeConfig, codexConfig, realUsage);
  const toolOutputRisk = detectToolOutputRisk({ exposedLargeFiles, exposedHighRiskDirs, highRiskDirs });
  const proxyTrackingReadiness = buildProxyTrackingReadiness({ codexConfig, claudeConfig, realUsage });

  if (toolOutputRisk.level !== "Low") {
    addIssue(
      issues,
      toolOutputRisk.level === "High" ? "high" : "medium",
      "large_file",
      `Tool output risk is ${toolOutputRisk.level}`,
      toolOutputRisk.summary,
      "Use narrower commands, summarize logs, and ignore generated test/build output before loading it into coding agents.",
      toolOutputRisk.estimatedExposureTokens
        ? `Likely avoidable token exposure: up to ~${toolOutputRisk.estimatedExposureTokens.toLocaleString()} tokens from exposed noisy artifacts.`
        : "Potential savings estimate: prevents noisy command/file output from becoming recurring context."
    );
  }

  if (optimizationStack.mcpServerTotal >= 8) {
    addIssue(
      issues,
      "medium",
      "mcp_tooling",
      `${optimizationStack.mcpServerTotal} total MCP/tool servers detected`,
      "Large tool surfaces can increase tool-choice overhead across Claude Code and Codex-style workflows.",
      "Disable MCP servers not needed for the current repo or current task.",
      estimateMcpImpact(optimizationStack.mcpServerTotal)
    );
  }

  const sourceFiles = files.filter((file) => file.kind === "source").length;
  const stats = {
    totalFiles: files.length,
    sourceFiles,
    largeFiles: largeFiles.length,
    exposedLargeFiles: exposedLargeFiles.length,
    highRiskDirs: highRiskDirs.length,
    exposedHighRiskDirs: exposedHighRiskDirs.length,
    ignoredHighRiskDirs: ignoredHighRiskDirs.length,
  };
  if (stats.totalFiles === 0) {
    addIssue(
      issues,
      "low",
      "repo_size",
      "Folder is empty",
      "There are no files to scan, so Prismo can only provide setup guidance.",
      "Run Prismo inside a project after files have been added.",
      "No token estimate; no AI-readable files were found."
    );
  }
  if (stats.totalFiles > 10000) {
    addIssue(
      issues,
      "medium",
      "repo_size",
      `Huge repo surface detected (${stats.totalFiles.toLocaleString()} files)`,
      "Very large repos increase broad exploration risk for coding agents.",
      "Use scoped context packs and ignore generated/vendor folders aggressively.",
      "Likely avoidable token exposure: large repos make repeated discovery more expensive."
    );
  }
  const score = scoreScan(issues, stats, { toolOutputRisk, agentReadiness, proxyTrackingReadiness });
  const largeFileSuggestions = exposedLargeFiles
    .filter((file) => file.size >= 1024 * 1024 || ["log", "json", "minified", "lock/generated"].includes(file.kind))
    .map((file) => file.path);
  const recommendedClaudeIgnore = Array.from(new Set([
    ...DEFAULT_CLAUDEIGNORE,
    ...gitignorePatterns.filter((line) => !line.startsWith("!")),
    ...largeFileSuggestions,
  ]));
  const recommendedCursorIgnore = Array.from(new Set([
    ...recommendedClaudeIgnore,
    ".prismo/",
    "prismo-dev-report.md",
    "prismo-optimized-CLAUDE.template.md",
    "prismo-AGENTS-recommendations.md",
  ]));
  const recommendations = buildRecommendations({
    hasClaudeIgnore,
    gitignorePatterns,
    exposedHighRiskDirs,
    largeFiles,
    instructionFiles,
    claudeConfig,
    toolOutputRisk,
    agentReadiness,
  });
  buildRealUsageRecommendations(realUsage).forEach((rec) => recommendations.push(rec));

  return {
    root,
    score: score.score,
    risk: score.risk,
    avoidableWaste: score.avoidableWaste,
    issues,
    recommendations,
    realUsage,
    agentReadiness,
    optimizationStack,
    toolOutputRisk,
    proxyTrackingReadiness,
    frameworks,
    files,
    instructionFiles,
    largeFiles,
    exposedLargeFiles,
    highRiskDirs,
    exposedHighRiskDirs,
    ignoredHighRiskDirs,
    claudeConfig,
    codexConfig,
    stats,
    hasGitignore,
    hasClaudeIgnore,
    hasCursorIgnore,
    repoDetected,
    recommendedClaudeIgnore,
    recommendedCursorIgnore,
    topTokenLeaks: getTopTokenLeaks(issues),
    generatedAt: new Date().toISOString(),
  };
}

  return {
    calculateReductionPercent,
    chooseRecommendedScope,
    estimateExposedContextTokens,
    formatBytes,
    getNextCommands,
    getTopTokenLeaks,
    normalizeRel,
    renderSetupTerminal,
    runSetup,
    scanRepo,
    toJsonPayload,
  };
};
