module.exports = function createScan(deps) {
  const {
    fs,
    http,
    https,
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
    color,
  } = deps;

const {
  buildSessionIgnoreSuggestions,
  isIgnored,
  missingIgnoreSuggestions,
  normalizeRel,
  readIgnoreFile,
} = require("./scan-path-utils")({ fs, path });

const {
  addIssue,
  addRealUsageIssues,
  buildOptimizerFit,
  buildRecommendations,
  buildRealUsageRecommendations,
  calculateReductionPercent,
  chooseRecommendedScope,
  estimateClaudeInstructionImpact,
  estimateExposedContextTokens,
  estimateLargeFileImpact,
  estimateMcpImpact,
  estimateRiskyDirImpact,
  getNextCommands,
  getTopTokenLeaks,
  scoreScan,
} = require("./scan-score")({ estimateTokens, formatTokenCount, NPX_COMMAND });

const {
  buildProxyTrackingReadiness,
  checkUrlReachable,
  detectAgentReadiness,
  detectOperationalNoise,
  detectOptimizationStack,
  detectToolOutputRisk,
  scanClaudeConfig,
  scanCodexConfig,
} = require("./scan-detect")({ fs, http, https, os, path, readIfText, estimateTokens, getClaudeSessionFiles, getCodexSessionFiles, normalizeRel });

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
  const cursorInfo = result.detected.cursor;
  lines.push(`- Cursor: ${cursorInfo.detected ? "detected" : "not detected"}${cursorInfo.dbAvailable ? `; tracking DB: found (${cursorInfo.totalSessions} sessions, ${cursorInfo.activeSessions} active)` : ""}${cursorInfo.workspace ? `; workspace: matched` : ""}`);
  if (cursorInfo.dbStats) {
    lines.push(`  Tracking: ${cursorInfo.dbStats.scored_commits} scored commits, ${cursorInfo.dbStats.ai_code_hashes} code hashes, ${cursorInfo.dbStats.conversation_summaries} conversation summaries`);
  }
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
    operationalNoise: result.operationalNoise,
    optimizerFit: result.optimizerFit,
    sessionIgnoreSuggestions: result.sessionIgnoreSuggestions || [],
    proxyTrackingReadiness: result.proxyTrackingReadiness,
    suggestedClaudeIgnore: result.recommendedClaudeIgnore,
    suggestedCursorIgnore: result.recommendedCursorIgnore,
    missingClaudeIgnoreSuggestions: result.missingClaudeIgnoreSuggestions || [],
    missingCursorIgnoreSuggestions: result.missingCursorIgnoreSuggestions || [],
    nextCommands: getNextCommands(result),
    generatedAt: result.generatedAt,
    scannedPath: result.root,
  };
  if (result.realUsage) payload.realUsage = compactUsageSummary(result.realUsage);
  return payload;
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
  const sessionIgnoreSuggestions = buildSessionIgnoreSuggestions(realUsage, root);
  addRealUsageIssues(issues, realUsage);
  if (sessionIgnoreSuggestions.length) {
    addIssue(
      issues,
      "medium",
      "ignore_file",
      `${sessionIgnoreSuggestions.length} session-derived ignore suggestion${sessionIgnoreSuggestions.length === 1 ? "" : "s"}`,
      sessionIgnoreSuggestions.slice(0, 5).map((item) => `${item.pattern} (${item.count}x)`).join(", "),
      "Review the generated .claudeignore/.cursorignore suggestions from actual local session context.",
      "Likely avoidable token exposure: these paths already appeared in local coding-agent context."
    );
  }
  const optimizationStack = detectOptimizationStack(root, claudeConfig, codexConfig);
  const agentReadiness = detectAgentReadiness(root, claudeConfig, codexConfig, realUsage);

  if (agentReadiness.cursor.dbAvailable) {
    try {
      const cursorMod = require("./cursor-sessions")({ fs, os, path, estimateTokens });
      const tracked = cursorMod.getCursorTrackedFileContent(20);
      const cursorAiFiles = tracked.filter((f) => {
        const fullPath = path.join(root, f.gitPath);
        return fs.existsSync(fullPath);
      });
      if (cursorAiFiles.length >= 3) {
        addIssue(
          issues,
          "medium",
          "ai_generated_files",
          `${cursorAiFiles.length} AI-generated files still in repo (tracked by Cursor)`,
          cursorAiFiles.slice(0, 5).map((f) => `${f.gitPath} (${f.model || "unknown model"})`).join(", "),
          "Review AI-generated files for quality and whether they should remain in the project.",
          `AI-generated content may inflate context if agents re-read it. Run: npx getprismo cursor files`
        );
      }
    } catch {
      // Cursor data unavailable
    }
  }

  const toolOutputRisk = detectToolOutputRisk({ exposedLargeFiles, exposedHighRiskDirs, highRiskDirs });
  const operationalNoise = detectOperationalNoise(files);
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

  if (operationalNoise.level !== "Low") {
    addIssue(
      issues,
      operationalNoise.level === "High" ? "high" : "medium",
      "operational_noise",
      `${operationalNoise.files.length} source-stream dump${operationalNoise.files.length === 1 ? "" : "s"} may leak into context`,
      operationalNoise.files.slice(0, 5).map((file) => `${file.path} (${file.signals.join(", ")})`).join(", "),
      "Do not feed raw inbox/calendar/GitHub/event dumps back into coding sessions; summarize externally or add them to .claudeignore/.cursorignore.",
      operationalNoise.estimatedExposureTokens
        ? `Likely avoidable token exposure: up to ~${operationalNoise.estimatedExposureTokens.toLocaleString()} tokens from operational noise files.`
        : "Potential savings estimate: prevents source-stream dumps from becoming recurring context."
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
  const operationalNoiseSuggestions = operationalNoise.files.map((file) => file.path);
  const sessionIgnorePatterns = sessionIgnoreSuggestions.map((item) => item.pattern);
  const recommendedClaudeIgnore = Array.from(new Set([
    ...DEFAULT_CLAUDEIGNORE,
    ...gitignorePatterns.filter((line) => !line.startsWith("!")),
    ...largeFileSuggestions,
    ...operationalNoiseSuggestions,
    ...sessionIgnorePatterns,
  ]));
  const recommendedCursorIgnore = Array.from(new Set([
    ...recommendedClaudeIgnore,
    ".prismo/",
    "prismo-optimized-CLAUDE.template.md",
  ]));
  const missingClaudeIgnoreSuggestions = hasClaudeIgnore ? missingIgnoreSuggestions(recommendedClaudeIgnore, claudeIgnorePatterns) : recommendedClaudeIgnore;
  const missingCursorIgnoreSuggestions = hasCursorIgnore ? missingIgnoreSuggestions(recommendedCursorIgnore, cursorIgnorePatterns) : recommendedCursorIgnore;
  const recommendations = buildRecommendations({
    hasClaudeIgnore,
    gitignorePatterns,
    exposedHighRiskDirs,
    largeFiles,
    instructionFiles,
    claudeConfig,
    toolOutputRisk,
    operationalNoise,
    agentReadiness,
  });
  buildRealUsageRecommendations(realUsage).forEach((rec) => recommendations.push(rec));

  const scanResult = {
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
    operationalNoise,
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
    missingClaudeIgnoreSuggestions,
    missingCursorIgnoreSuggestions,
    sessionIgnoreSuggestions,
    topTokenLeaks: getTopTokenLeaks(issues),
    generatedAt: new Date().toISOString(),
  };
  scanResult.optimizerFit = buildOptimizerFit(scanResult);
  return scanResult;
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
