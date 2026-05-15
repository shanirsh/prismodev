const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

const HIGH_RISK_DIRS = [
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".cache",
  "logs",
  "test-results",
  "playwright-report",
  "tmp",
  "temp",
];

const HIGH_RISK_FILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "coverage-final.json",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".tgz",
  ".mp4",
  ".mov",
  ".mp3",
  ".wav",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pyc",
  ".class",
  ".wasm",
  ".sqlite",
  ".sqlite3",
  ".db",
  ".bin",
]);

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".m",
  ".mm",
  ".scala",
  ".sh",
  ".sql",
  ".css",
  ".scss",
  ".html",
  ".vue",
  ".svelte",
]);

const INSTRUCTION_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "README.md",
  "README",
  ".openai/instructions.md",
  ".codex/AGENTS.md",
  ".codex/instructions.md",
  ".codex/config.toml",
];

const DEFAULT_CLAUDEIGNORE = [
  "node_modules/",
  ".next/",
  "dist/",
  "build/",
  "coverage/",
  ".turbo/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "pycache/",
  ".pytest_cache/",
  ".cache/",
  "logs/",
  "*.log",
  "*.lock",
  "*.tmp",
  "*.min.js",
  "*.min.css",
  "coverage-final.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "test-results/",
  "playwright-report/",
];

const NPX_COMMAND = "npx getprismo";
const DEFAULT_PRISMO_PROXY_URL = process.env.PRISMO_PROXY_URL || "http://localhost:8000";

function shouldUseColor() {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

const colorCodes = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

function color(text, tone, enabled = shouldUseColor()) {
  if (!enabled || !colorCodes[tone]) return text;
  return `${colorCodes[tone]}${text}${colorCodes.reset}`;
}

function severityIcon(severity) {
  if (severity === "critical") return "[critical]";
  if (severity === "high") return "[high]";
  if (severity === "medium") return "[medium]";
  return "[low]";
}

function severityColor(severity) {
  if (severity === "critical" || severity === "high") return "red";
  if (severity === "medium") return "yellow";
  return "cyan";
}

function printStep(label, json = false) {
  if (json) return () => {};
  process.stderr.write(`${color("...", "cyan")} ${label}`);
  return (status = "done") => {
    process.stderr.write(` ${color(`[${status}]`, status === "done" ? "green" : "yellow")}\n`);
  };
}

function estimateTokens(textOrBytes) {
  const length = typeof textOrBytes === "string" ? textOrBytes.length : Number(textOrBytes || 0);
  return Math.ceil(length / 4);
}

function readIfText(filePath, maxBytes = 2 * 1024 * 1024) {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return null;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > maxBytes) return null;

  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

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
        if (HIGH_RISK_DIRS.includes(entry.name)) {
          highRiskDirs.push({ path: relPath, exposed });
          // Never descend into bulky generated/cache folders; existence is enough.
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
  if (!tokens || tokens <= 500) return null;
  const extra = Math.max(0, tokens - 500);
  return `Potential savings estimate: about ${extra.toLocaleString()} persistent instruction tokens per turn if trimmed near 500 tokens.`;
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
  if (instructionFiles.some((file) => file.isClaude && file.tokens > 500)) {
    recs.push("Trim CLAUDE.md to project rules only; move long implementation notes into docs referenced on demand.");
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

function toJsonPayload(result) {
  const payload = {
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
    agentReadiness: result.agentReadiness,
    optimizationStack: result.optimizationStack,
    toolOutputRisk: result.toolOutputRisk,
    proxyTrackingReadiness: result.proxyTrackingReadiness,
    suggestedClaudeIgnore: result.recommendedClaudeIgnore,
    nextCommands: getNextCommands(result),
    generatedAt: result.generatedAt,
    scannedPath: result.root,
  };
  if (result.realUsage) payload.realUsage = result.realUsage;
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
  const repoDetected = fs.existsSync(path.join(root, ".git")) || fs.existsSync(path.join(root, "package.json")) || fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "go.mod")) || fs.existsSync(path.join(root, "Cargo.toml"));
  const gitignorePatterns = readIgnoreFile(root, ".gitignore");
  const claudeIgnorePatterns = readIgnoreFile(root, ".claudeignore");
  const combinedIgnorePatterns = Array.from(new Set([...gitignorePatterns, ...claudeIgnorePatterns]));

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
  if (claudeFile && claudeFile.tokens > 2000) {
    addIssue(
      issues,
      "high",
      "instruction_file",
      `CLAUDE.md is ~${claudeFile.tokens.toLocaleString()} tokens`,
      "Large persistent instruction files can raise baseline token usage in Claude Code-style workflows.",
      "Trim CLAUDE.md under 500 tokens and link to longer docs only when needed.",
      estimateClaudeInstructionImpact(claudeFile.tokens)
    );
  } else if (claudeFile && claudeFile.tokens > 500) {
    addIssue(
      issues,
      "medium",
      "instruction_file",
      `CLAUDE.md is ~${claudeFile.tokens.toLocaleString()} tokens`,
      "This is above the recommended persistent-instruction budget.",
      "Keep CLAUDE.md focused on durable project rules.",
      estimateClaudeInstructionImpact(claudeFile.tokens)
    );
  }

  for (const file of instructionFiles.filter((item) => !item.isClaude && item.tokens > 2000)) {
    addIssue(
      issues,
      "medium",
      file.path.toLowerCase().includes("codex") || file.path === "AGENTS.md" ? "codex_config" : "instruction_file",
      `${file.path} is ~${file.tokens.toLocaleString()} tokens`,
      "Large instruction/readme files may be repeatedly loaded by coding agents.",
      "Split long context into task-specific docs and reference only what is needed.",
      `Potential savings estimate: reduce repeated baseline context by trimming or splitting this ~${file.tokens.toLocaleString()} token file.`
    );
  }

  for (const file of instructionFiles.filter((item) => !item.isClaude && item.tokens > 500 && item.tokens <= 2000)) {
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
    repoDetected,
    recommendedClaudeIgnore,
    topTokenLeaks: getTopTokenLeaks(issues),
    generatedAt: new Date().toISOString(),
  };
}

function renderTerminalReport(result, options = {}) {
  const reportEnabled = options.reportEnabled !== false;
  const useColor = options.color !== false;
  const riskTone = result.risk === "High" ? "red" : result.risk === "Medium" ? "yellow" : "green";
  const lines = [];
  lines.push("");
  lines.push(color("PrismoDev", "bold", useColor));
  lines.push("");
  lines.push(`Score: ${color(`${result.score}/100`, riskTone, useColor)}  |  Risk: ${color(result.risk, riskTone, useColor)}  |  Token leaks: ${result.issues.length}`);
  lines.push(`Estimated avoidable waste: ${result.avoidableWaste}`);
  lines.push("");
  lines.push(color("Top Token Leaks", "bold", useColor));
  if (!result.topTokenLeaks.length) {
    lines.push("1. [ok] No major token leaks detected");
  } else {
    result.topTokenLeaks.forEach((leak, index) => lines.push(`${index + 1}. ${leak}`));
  }
  lines.push("");
  const nextCommands = getNextCommands(result, options.scope);
  lines.push(color("Top Fix", "bold", useColor));
  lines.push(`Run: ${nextCommands[0]}`);
  if (nextCommands[1]) lines.push(`Then: ${nextCommands[1]}`);
  if (nextCommands[2]) lines.push(`Then: ${nextCommands[2]}`);
  lines.push("");
  lines.push(color("Scan Context", "bold", useColor));
  lines.push(`- Files scanned: ${result.stats.totalFiles.toLocaleString()}`);
  lines.push(`- Source files: ${result.stats.sourceFiles.toLocaleString()}`);
  lines.push(`- Large files: ${result.stats.largeFiles.toLocaleString()} (${result.stats.exposedLargeFiles} exposed)`);
  lines.push(`- Risky directories: ${result.stats.highRiskDirs} (${result.stats.exposedHighRiskDirs} exposed)`);
  lines.push(`- Repo detected: ${result.repoDetected ? "yes" : "no"}`);
  if (result.realUsage && result.realUsage.sessions.length) {
    lines.push(`- Real local usage: ${formatTokenCount(result.realUsage.totals.displayTokens)} tokens across ${result.realUsage.sessions.length} session(s)`);
    lines.push(`- Usage confidence: ${result.realUsage.confidence}`);
  } else if (result.realUsage) {
    lines.push("- Real local usage: no matching local Codex/Claude Code sessions found for this repo");
  }
  lines.push("");
  lines.push(color("Coding Agent Readiness", "bold", useColor));
  lines.push(`- Claude Code: ${result.agentReadiness.claudeCode.detected ? "detected" : "not detected"}; logs: ${result.agentReadiness.claudeCode.localLogsFound ? "found" : "not found"}; MCP: ${result.agentReadiness.claudeCode.mcpServers}; hooks: ${result.agentReadiness.claudeCode.hooks}`);
  lines.push(`- Codex: ${result.agentReadiness.codex.detected ? "detected" : "not detected"}; logs: ${result.agentReadiness.codex.localLogsFound ? "found" : "not found"}; MCP: ${result.agentReadiness.codex.mcpServers}`);
  lines.push(`- Cursor: ${result.agentReadiness.cursor.detected ? "detected" : "not detected"}`);
  lines.push("");
  lines.push(color("Optimization Stack", "bold", useColor));
  const stack = result.optimizationStack;
  lines.push(`- RTK: ${stack.tools.rtk.detected ? "detected" : "not detected"}`);
  lines.push(`- Headroom: ${stack.tools.headroom.detected ? "detected" : "not detected"}`);
  lines.push(`- Distill: ${stack.tools.distill.detected ? "detected" : "not detected"}`);
  lines.push(`- Mana: ${stack.tools.mana.detected ? "detected" : "not detected"}`);
  lines.push(`- Claude hooks: ${stack.claudeHooks}; MCP servers: ${stack.mcpServerTotal}`);
  lines.push("");
  lines.push(color("Tool Output Risk", "bold", useColor));
  lines.push(`- Level: ${result.toolOutputRisk.level}`);
  lines.push(`- ${result.toolOutputRisk.summary}`);
  if (result.toolOutputRisk.exposedNoisyDirectories.length) lines.push(`- Exposed noisy dirs: ${result.toolOutputRisk.exposedNoisyDirectories.slice(0, 6).join(", ")}`);
  if (result.toolOutputRisk.exposedNoisyFiles.length) lines.push(`- Exposed noisy files: ${result.toolOutputRisk.exposedNoisyFiles.slice(0, 4).map((file) => file.path).join(", ")}`);
  lines.push("");
  lines.push(color("Prismo Proxy Tracking", "bold", useColor));
  lines.push("- Exact API tracking: available when traffic uses the Prismo OpenAI/Anthropic base URL");
  lines.push(`- Codex API/base-url mode: ${result.proxyTrackingReadiness.codingAgentBaseUrlMode.codex}`);
  lines.push(`- Claude Code subscription mode: ${result.proxyTrackingReadiness.codingAgentBaseUrlMode.claudeCode}`);
  lines.push("- Subscription sessions: local-log visibility when available, not guaranteed billing accuracy");
  lines.push("");
  lines.push(color("Issues", "bold", useColor));
  if (!result.issues.length) {
    lines.push("- [ok] No major token-waste risks detected.");
  } else {
    for (const issue of result.issues.slice(0, 8)) {
      const icon = color(severityIcon(issue.severity), severityColor(issue.severity), useColor);
      lines.push(`- ${icon} ${issue.title}. ${issue.description}`);
      if (issue.estimatedTokenImpact) lines.push(`  ${issue.estimatedTokenImpact}`);
    }
  }
  lines.push("");
  lines.push(color("Recommended Fixes", "bold", useColor));
  result.recommendations.forEach((rec, index) => lines.push(`${index + 1}. ${rec}`));
  lines.push("");
  lines.push(result.realUsage && result.realUsage.sessions.length
    ? "Usage findings come from local Codex/Claude Code logs when exact token fields are available; repo-risk estimates remain heuristic."
    : result.realUsage
      ? "No matching local usage sessions were found; repo-risk estimates remain heuristic."
    : "Potential savings estimates are heuristic and local-only, not provider billing data.");
  lines.push("");
  lines.push(reportEnabled ? "Report: prismo-dev-report.md" : "Report: skipped (--no-report)");
  return lines.join("\n");
}

function renderSimpleScanReport(result) {
  const lines = [];
  const topLeaks = result.topTokenLeaks.length ? result.topTokenLeaks.slice(0, 4) : ["No major token-waste risks detected."];
  const nextCommands = getNextCommands(result);
  lines.push("");
  lines.push("PrismoDev Simple Scan");
  lines.push("");
  lines.push(`Result: ${result.risk} token-waste risk (${result.score}/100)`);
  lines.push(`What it means: Prismo found ${result.issues.length} thing${result.issues.length === 1 ? "" : "s"} that could make Claude Code, Codex, or Cursor use extra context.`);
  if (result.realUsage && result.realUsage.sessions.length) {
    lines.push(`Recent local usage: ${formatTokenCount(result.realUsage.totals.displayTokens)} tokens from local coding-agent logs.`);
  } else if (result.realUsage) {
    lines.push("Recent local usage: no matching Codex or Claude Code session logs found for this repo.");
  }
  lines.push("");
  lines.push("Main things to fix:");
  topLeaks.forEach((leak, index) => lines.push(`${index + 1}. ${leak}`));
  lines.push("");
  lines.push("Best next step:");
  lines.push(`${nextCommands[0]}`);
  if (nextCommands[1]) lines.push(`After that: ${nextCommands[1]}`);
  lines.push("");
  lines.push("Plain English:");
  lines.push("PrismoDev checks your project locally. It does not need API keys, does not connect to OpenAI or Anthropic, and does not change your code unless you run --fix.");
  lines.push("");
  return lines.join("\n");
}

function renderMarkdownReport(result) {
  const lines = [];
  lines.push("# PrismoDev Report");
  lines.push("");
  lines.push("## Executive Summary");
  lines.push("");
  lines.push(`- **Score:** ${result.score}/100`);
  lines.push(`- **Risk Level:** ${result.risk}`);
  lines.push(`- **Token Leaks Found:** ${result.issues.length}`);
  lines.push(`- **Estimated Avoidable Waste:** ${result.avoidableWaste}`);
  lines.push(`- **Repo:** \`${result.root}\``);
  lines.push(`- **Generated At:** ${result.generatedAt}`);
  if (result.realUsage) {
    lines.push(`- **Real Local Usage:** ${result.realUsage.totals.displayTokens.toLocaleString()} tokens across ${result.realUsage.sessions.length} session(s)`);
    lines.push(`- **Usage Confidence:** ${result.realUsage.confidence}`);
  }
  lines.push("");
  lines.push("Estimates are based on local file-size and configuration heuristics. They are not provider billing data and are not guaranteed savings.");
  lines.push("");
  lines.push("## Top Token Leaks");
  lines.push("");
  if (!result.topTokenLeaks.length) {
    lines.push("1. No major token leaks detected.");
  } else {
    result.topTokenLeaks.forEach((leak, index) => lines.push(`${index + 1}. ${leak}`));
  }
  lines.push("");
  lines.push("## Repo Context");
  lines.push("");
  lines.push(`- Total files scanned: ${result.stats.totalFiles}`);
  lines.push(`- Source files: ${result.stats.sourceFiles}`);
  lines.push(`- Large files: ${result.stats.largeFiles}`);
  lines.push(`- Exposed large files: ${result.stats.exposedLargeFiles}`);
  lines.push(`- Token-bloat directories: ${result.stats.highRiskDirs}`);
  lines.push(`- Exposed token-bloat directories: ${result.stats.exposedHighRiskDirs}`);
  lines.push("");
  lines.push("## Coding Agent Readiness");
  lines.push("");
  lines.push(`- Claude Code detected: ${result.agentReadiness.claudeCode.detected ? "yes" : "no"}`);
  lines.push(`  - Local logs found: ${result.agentReadiness.claudeCode.localLogsFound ? "yes" : "no"}`);
  lines.push(`  - MCP servers: ${result.agentReadiness.claudeCode.mcpServers}; hooks: ${result.agentReadiness.claudeCode.hooks}`);
  lines.push(`  - Exact proxy tracking: ${result.agentReadiness.claudeCode.exactProxyTracking}`);
  lines.push(`- Codex detected: ${result.agentReadiness.codex.detected ? "yes" : "no"}`);
  lines.push(`  - Local logs found: ${result.agentReadiness.codex.localLogsFound ? "yes" : "no"}`);
  lines.push(`  - MCP servers: ${result.agentReadiness.codex.mcpServers}`);
  lines.push(`  - Exact proxy tracking: ${result.agentReadiness.codex.exactProxyTracking}`);
  lines.push(`- Cursor detected: ${result.agentReadiness.cursor.detected ? "yes" : "no"}`);
  lines.push(`  - Exact proxy tracking: ${result.agentReadiness.cursor.exactProxyTracking}`);
  lines.push("");
  lines.push("## Optimization Stack");
  lines.push("");
  lines.push(`- RTK: ${result.optimizationStack.tools.rtk.detected ? "detected" : "not detected"}`);
  lines.push(`- Headroom: ${result.optimizationStack.tools.headroom.detected ? "detected" : "not detected"}`);
  lines.push(`- Distill: ${result.optimizationStack.tools.distill.detected ? "detected" : "not detected"}`);
  lines.push(`- Mana: ${result.optimizationStack.tools.mana.detected ? "detected" : "not detected"}`);
  lines.push(`- Claude hooks: ${result.optimizationStack.claudeHooks}`);
  lines.push(`- Total MCP/tool servers: ${result.optimizationStack.mcpServerTotal}`);
  lines.push("");
  lines.push("## Tool Output Risk");
  lines.push("");
  lines.push(`- Level: ${result.toolOutputRisk.level}`);
  lines.push(`- ${result.toolOutputRisk.summary}`);
  if (result.toolOutputRisk.exposedNoisyDirectories.length) {
    lines.push(`- Exposed noisy directories: ${result.toolOutputRisk.exposedNoisyDirectories.map((dir) => `\`${dir}/\``).join(", ")}`);
  }
  if (result.toolOutputRisk.exposedNoisyFiles.length) {
    result.toolOutputRisk.exposedNoisyFiles.slice(0, 20).forEach((file) => {
      lines.push(`- \`${file.path}\` - ${formatBytes(file.sizeBytes)} - ~${file.estimatedTokensIfRead.toLocaleString()} tokens if read`);
    });
  }
  lines.push("");
  lines.push("## Prismo Proxy Tracking Readiness");
  lines.push("");
  lines.push("- Exact API tracking: available when app/tool traffic uses the Prismo OpenAI/Anthropic base URL.");
  lines.push(`- Codex API/base-url mode: ${result.proxyTrackingReadiness.codingAgentBaseUrlMode.codex}.`);
  lines.push(`- Claude Code subscription mode: ${result.proxyTrackingReadiness.codingAgentBaseUrlMode.claudeCode}.`);
  lines.push("- Local estimate tracking: available from local Codex/Claude Code logs when those logs exist.");
  lines.push("- Unsupported: exact billing for hidden subscription sessions without provider traffic, API keys, or local token fields.");
  lines.push("");
  if (result.realUsage) {
    lines.push("## Real Local Usage");
    lines.push("");
    lines.push(`- Tool scope: ${result.realUsage.tool}`);
    lines.push(`- Displayed tokens: ${result.realUsage.totals.displayTokens.toLocaleString()}`);
    lines.push(`- Exact local-log tokens: ${result.realUsage.totals.exactTokens.toLocaleString()}`);
    lines.push(`- Estimated tool/output tokens: ${result.realUsage.totals.toolTokens.toLocaleString()}`);
    lines.push(`- Confidence: ${result.realUsage.confidence}`);
    lines.push("");
    result.realUsage.sessions.slice(0, 5).forEach((session, index) => {
      lines.push(`${index + 1}. ${session.tool} - ${session.title || session.sessionId}`);
      lines.push(`   - Tokens: ${session.displayTokens.toLocaleString()} (${session.confidence})`);
      lines.push(`   - Risk: ${session.contextRisk}; turns: ${session.turns}; tools: ${session.toolCalls}`);
      if (session.cwd) lines.push(`   - CWD: \`${session.cwd}\``);
    });
    lines.push("");
  }
  lines.push("## Issues");
  lines.push("");
  if (!result.issues.length) {
    lines.push("- No major token-waste risks detected.");
  } else {
    for (const issue of result.issues) {
      lines.push(`- **${issue.severity.toUpperCase()}** / \`${issue.category}\`: ${issue.title}`);
      lines.push(`  - ${issue.description}`);
      lines.push(`  - Fix: ${issue.recommendation}`);
      if (issue.estimatedTokenImpact) lines.push(`  - ${issue.estimatedTokenImpact}`);
    }
  }
  lines.push("");
  lines.push("## Claude Code Findings");
  lines.push("");
  lines.push(`- CLAUDE.md found: ${result.instructionFiles.some((file) => file.isClaude) ? "yes" : "no"}`);
  lines.push(`- .claudeignore found: ${result.hasClaudeIgnore ? "yes" : "no"}`);
  lines.push(`- Claude config files found: ${result.claudeConfig.files.length ? result.claudeConfig.files.map((file) => `\`${file}\``).join(", ") : "none"}.`);
  lines.push(`- MCP servers detected: ${result.claudeConfig.mcpServers}. Hooks detected: ${result.claudeConfig.hooks}. Plugin/skill references: ${result.claudeConfig.pluginRefs}.`);
  lines.push("- Keep `CLAUDE.md` under 500 tokens when possible.");
  lines.push("- Move long implementation notes into separate docs and reference them only when needed.");
  lines.push("- Create `.claudeignore` to hide generated files, caches, logs, coverage, and lock files.");
  lines.push("");
  lines.push("## OpenAI/Codex Findings");
  lines.push("");
  lines.push(`- AGENTS.md found: ${result.instructionFiles.some((file) => file.path === "AGENTS.md") ? "yes" : "no"}`);
  lines.push(`- Codex config files found: ${result.codexConfig.files.length ? result.codexConfig.files.map((file) => `\`${file}\``).join(", ") : "none"}.`);
  lines.push(`- Codex MCP/tool references detected: ${result.codexConfig.mcpServers}.`);
  lines.push("- Keep `AGENTS.md` and `.codex/` instructions concise and task-oriented.");
  lines.push("- Avoid pasting giant logs or generated JSON into Codex sessions.");
  lines.push("- Use cheaper/faster models for mechanical edits and low-risk refactors.");
  lines.push("");
  lines.push("## Large Files");
  lines.push("");
  if (!result.largeFiles.length) {
    lines.push("- No large text-like files over 500 KB detected.");
  } else {
    result.largeFiles.slice(0, 40).forEach((file) => {
      lines.push(`- \`${file.path}\` - ${formatBytes(file.size)} - ${file.kind}${file.ignored ? " - ignored" : ""}`);
    });
  }
  lines.push("");
  lines.push("## Risky Directories");
  lines.push("");
  if (!result.highRiskDirs.length) {
    lines.push("- No common token-bloat directories detected.");
  } else {
    result.highRiskDirs.forEach((dir) => {
      lines.push(`- \`${dir.path}/\`${dir.exposed ? " - exposed" : " - ignored"}`);
    });
  }
  lines.push("");
  lines.push("## Recommended .claudeignore");
  lines.push("");
  lines.push("```gitignore");
  result.recommendedClaudeIgnore.forEach((line) => lines.push(line));
  lines.push("```");
  lines.push("");
  lines.push("## Recommended Next Steps");
  lines.push("");
  result.recommendations.forEach((rec, index) => lines.push(`${index + 1}. ${rec}`));
  lines.push("");
  lines.push("## Disclaimer");
  lines.push("");
  lines.push("PrismoDev is a fast local scanner. It does not connect to Anthropic, OpenAI, Claude Code, Codex, Cursor, or billing accounts. Token and savings estimates are heuristic and should be treated as directional diagnostics only.");
  lines.push("");
  return lines.join("\n");
}

function backupIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.${stamp}.bak`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function writeReport(result) {
  const reportPath = path.join(result.root, "prismo-dev-report.md");
  const backupPath = backupIfExists(reportPath);
  fs.writeFileSync(reportPath, renderMarkdownReport(result), "utf8");
  return { reportPath, backupPath };
}

function renderClaudeTemplate(result) {
  const claudeFile = result.instructionFiles.find((file) => file.isClaude);
  return [
    "# Prismo Optimized CLAUDE.md Template",
    "",
    "Use this as a concise replacement draft. Review manually before changing your real CLAUDE.md.",
    "",
    "## Project Rules",
    "",
    "- Keep changes scoped to the requested task.",
    "- Prefer existing project patterns and tests.",
    "- Do not load generated files, logs, coverage reports, or build artifacts unless explicitly needed.",
    "- Reference long docs only when the task requires them.",
    "",
    "## Token Hygiene",
    "",
    "- Keep persistent instructions under roughly 500 tokens.",
    "- Move long implementation notes into separate docs.",
    "- Start a fresh session for unrelated work.",
    "",
    claudeFile ? `Original CLAUDE.md estimate: ~${claudeFile.tokens.toLocaleString()} tokens.` : "",
    "",
  ].join("\n");
}

function renderAgentsRecommendations(result) {
  const codexIssues = result.issues.filter((issue) => issue.category === "codex_config" || issue.title.includes("AGENTS.md"));
  return [
    "# Prismo AGENTS.md / Codex Recommendations",
    "",
    "Review these suggestions manually before changing AGENTS.md or .codex configuration.",
    "",
    "## Findings",
    "",
    ...(codexIssues.length
      ? codexIssues.map((issue) => `- ${issue.title}: ${issue.recommendation}`)
      : ["- No major Codex-specific risks detected, but keeping persistent instructions concise is still recommended."]),
    "",
    "## Suggested Practices",
    "",
    "- Keep AGENTS.md focused on durable project rules.",
    "- Move task-specific context into separate docs.",
    "- Avoid pasting giant logs, generated JSON, lockfiles, and coverage reports into Codex sessions.",
    "- Scope MCP/tool configuration to the current project.",
    "",
  ].join("\n");
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function findRepoFiles(result, predicate, limit = 40) {
  return result.files
    ? result.files.filter((file) => !file.ignored && file.kind !== "binary" && predicate(file.path, file)).slice(0, limit)
    : [];
}

function detectFrameworks(root, result) {
  const frameworks = new Set();
  const packageFiles = findRepoFiles(result, (rel) => path.basename(rel) === "package.json" && !rel.includes("node_modules/"), 12);
  for (const file of packageFiles) {
    const pkg = safeReadJson(path.join(root, file.path));
    const deps = { ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) };
    if (deps.next) frameworks.add("Next.js");
    if (deps.react) frameworks.add("React");
    if (deps.express) frameworks.add("Express");
    if (deps["@nestjs/core"]) frameworks.add("NestJS");
    if (deps.prisma || deps["@prisma/client"]) frameworks.add("Prisma");
    if (deps.tailwindcss) frameworks.add("Tailwind");
    if (deps.typescript) frameworks.add("TypeScript");
    if (pkg) frameworks.add("Node.js");
  }

  const textFiles = new Map(result.files.map((file) => [file.path, file]));
  const requirements = [...textFiles.keys()].filter((rel) => rel.endsWith("requirements.txt"));
  for (const rel of requirements) {
    const text = readIfText(path.join(root, rel)) || "";
    if (/fastapi/i.test(text)) frameworks.add("FastAPI");
    if (/django/i.test(text)) frameworks.add("Django");
    if (/flask/i.test(text)) frameworks.add("Flask");
    if (/psycopg2|asyncpg|sqlalchemy/i.test(text)) frameworks.add("PostgreSQL");
    if (/redis/i.test(text)) frameworks.add("Redis");
    frameworks.add("Python");
  }

  if ([...textFiles.keys()].some((rel) => rel.endsWith("pyproject.toml"))) frameworks.add("Python");
  if ([...textFiles.keys()].some((rel) => rel.endsWith("Cargo.toml"))) frameworks.add("Rust");
  if ([...textFiles.keys()].some((rel) => rel.endsWith("go.mod"))) frameworks.add("Go");
  if ([...textFiles.keys()].some((rel) => rel.endsWith("docker-compose.yml") || rel.endsWith("docker-compose.yaml"))) frameworks.add("Docker");
  if ([...textFiles.keys()].some((rel) => rel.includes("prisma/schema.prisma"))) frameworks.add("Prisma");
  if ([...textFiles.keys()].some((rel) => rel.includes("next.config."))) frameworks.add("Next.js");
  if ([...textFiles.keys()].some((rel) => rel.includes("vite.config."))) frameworks.add("Vite");
  if ([...textFiles.keys()].some((rel) => rel.includes("tailwind.config."))) frameworks.add("Tailwind");
  if ([...textFiles.keys()].some((rel) => rel.endsWith("tsconfig.json"))) frameworks.add("TypeScript");
  if ([...textFiles.keys()].some((rel) => rel.includes("alembic/") || rel.endsWith("alembic.ini"))) frameworks.add("Alembic");
  if ([...textFiles.keys()].some((rel) => /postgres|postgresql/i.test(rel))) frameworks.add("PostgreSQL");
  return Array.from(frameworks).sort();
}

function topLevelDirectories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function hasPath(result, matcher) {
  return result.files.some((file) => matcher(file.path));
}

function detectEntrypoints(result) {
  const candidates = [
    "backend/app/main.py",
    "backend/main.py",
    "app/main.py",
    "main.py",
    "frontend/src/app/page.tsx",
    "frontend/src/app/layout.tsx",
    "src/app/page.tsx",
    "src/main.tsx",
    "src/index.tsx",
    "server.js",
    "index.js",
    "docker/docker-compose.yml",
    "docker-compose.yml",
  ];
  const paths = new Set(result.files.map((file) => file.path));
  return candidates.filter((candidate) => paths.has(candidate));
}

function detectBackendPaths(result) {
  return {
    api: findRepoFiles(result, (rel) => /backend\/.*(router|routes|api)\//.test(rel) || /backend\/.*(router|routes).*\.py$/.test(rel), 20).map((f) => f.path),
    services: findRepoFiles(result, (rel) => /backend\/.*(service|services|application)/.test(rel), 20).map((f) => f.path),
    models: findRepoFiles(result, (rel) => /backend\/.*models\.py$/.test(rel) || /backend\/.*schema/.test(rel), 20).map((f) => f.path),
    db: findRepoFiles(result, (rel) => /backend\/.*(db|database|alembic|migrations)/.test(rel), 20).map((f) => f.path),
    config: findRepoFiles(result, (rel) => /backend\/.*(config|settings|env).*\.py$/.test(rel) || rel.endsWith("backend/requirements.txt"), 20).map((f) => f.path),
    auth: findRepoFiles(result, (rel) => /backend\/.*auth/.test(rel), 20).map((f) => f.path),
  };
}

function detectFrontendPaths(result) {
  return {
    app: findRepoFiles(result, (rel) => /frontend\/src\/app\//.test(rel) || /src\/app\//.test(rel), 24).map((f) => f.path),
    components: findRepoFiles(result, (rel) => /frontend\/src\/components\//.test(rel) || /src\/components\//.test(rel), 20).map((f) => f.path),
    apiClient: findRepoFiles(result, (rel) => /frontend\/src\/(lib|hooks)\/.*(api|client|query|finops)/.test(rel), 20).map((f) => f.path),
    styling: findRepoFiles(result, (rel) => /tailwind\.config|globals\.css|\.module\.css|frontend\/src\/app\/globals/.test(rel), 20).map((f) => f.path),
    state: findRepoFiles(result, (rel) => /providers\.tsx|react-query|use[A-Z].*\.ts/.test(rel), 20).map((f) => f.path),
  };
}

function createOptimizeContext(rootDir = process.cwd(), scope = null) {
  const scan = scanRepo(rootDir);
  const root = scan.root;
  const frameworks = detectFrameworks(root, scan);
  const folders = topLevelDirectories(root);
  const entrypoints = detectEntrypoints(scan);
  const backendDetected = folders.includes("backend") || frameworks.some((name) => ["FastAPI", "Django", "Flask"].includes(name));
  const frontendDetected = folders.includes("frontend") || frameworks.some((name) => ["Next.js", "React", "Vite"].includes(name));
  const backend = detectBackendPaths(scan);
  const frontend = detectFrontendPaths(scan);
  const warnings = [];
  if (scan.exposedLargeFiles.length) warnings.push(`${scan.exposedLargeFiles.length} exposed large file(s) may bloat AI context.`);
  if (!scan.hasClaudeIgnore) warnings.push(".claudeignore is missing.");
  if (scan.exposedHighRiskDirs.length) warnings.push(`${scan.exposedHighRiskDirs.length} generated/cache directories may be visible.`);

  const suggestions = [
    "Use .prismo/architecture-summary.md as first-pass repo context instead of asking agents to explore broadly.",
    "Keep CLAUDE.md and AGENTS.md concise; link to generated summaries when deeper context is needed.",
    "Use scoped context packs for focused work, especially frontend/backend/auth tasks.",
    "Keep generated files, logs, coverage, build output, and lockfiles out of coding-agent context.",
  ];

  return {
    root,
    scope,
    scan,
    frameworks,
    folders,
    entrypoints,
    backendDetected,
    frontendDetected,
    backend,
    frontend,
    warnings,
    suggestions,
    estimatedContextReduction: scan.avoidableWaste,
    generatedAt: new Date().toISOString(),
  };
}

function mdList(items, empty = "None detected.") {
  if (!items || !items.length) return `- ${empty}`;
  return items.map((item) => `- \`${item}\``).join("\n");
}

function proseList(items, empty = "none detected") {
  return items && items.length ? items.join(", ") : empty;
}

function renderArchitectureSummary(ctx) {
  const apiLayer = ctx.backend.api.slice(0, 6);
  const dbLayer = ctx.backend.db.slice(0, 6);
  const frontendLayer = ctx.frontend.app.slice(0, 6);
  const readOrder = [
    "- Start here.",
    ctx.backendDetected ? "- For backend work, read `.prismo/backend-summary.md` next." : null,
    ctx.frontendDetected ? "- For frontend work, read `.prismo/frontend-summary.md` next." : null,
    "- Then inspect only the files directly relevant to the task.",
    "- Avoid broad recursive reads unless the task truly needs a repo-wide audit.",
  ].filter(Boolean);
  return [
    "# Architecture Summary",
    "",
    "Use this file as the first repo-context attachment for Claude Code, Codex, Cursor, and similar tools. It is intentionally concise so agents do not have to rediscover the project from scratch.",
    "",
    "## Detected Frameworks",
    "",
    mdList(ctx.frameworks, "No common framework markers detected."),
    "",
    "## Major Folders",
    "",
    mdList(ctx.folders),
    "",
    "## Likely Architecture",
    "",
    `- Frontend detected: ${ctx.frontendDetected ? "yes" : "no"}`,
    `- Backend detected: ${ctx.backendDetected ? "yes" : "no"}`,
    `- API layer likely lives in: ${apiLayer.map((p) => `\`${p}\``).join(", ") || "not detected"}`,
    `- Database/migration layer likely lives in: ${dbLayer.map((p) => `\`${p}\``).join(", ") || "not detected"}`,
    `- Frontend routes/app surface likely lives in: ${frontendLayer.map((p) => `\`${p}\``).join(", ") || "not detected"}`,
    "",
    "## Recommended Read Order",
    "",
    readOrder.join("\n"),
    "",
    "## Key Entrypoints",
    "",
    mdList(ctx.entrypoints),
    "",
    "## Context Risks",
    "",
    ctx.warnings.length ? ctx.warnings.map((warning) => `- ${warning}`).join("\n") : "- No major local context risks detected.",
    "",
    "## AI Workflow Notes",
    "",
    "- Prefer this summary before broad repo reads.",
    "- Use scoped context files for focused tasks.",
    "- Avoid generated folders, caches, logs, coverage output, and large analysis files.",
    "",
  ].join("\n");
}

function renderBackendSummary(ctx) {
  return [
    "# Backend Summary",
    "",
    "Only reasonably inferable backend structure is listed here.",
    "",
    "## API / Router Files",
    "",
    mdList(ctx.backend.api),
    "",
    "## Services / Application Logic",
    "",
    mdList(ctx.backend.services),
    "",
    "## Models / Schemas",
    "",
    mdList(ctx.backend.models),
    "",
    "## Database / Migration Layer",
    "",
    mdList(ctx.backend.db),
    "",
    "## Auth-Related Paths",
    "",
    mdList(ctx.backend.auth),
    "",
    "## Config / Environment Hints",
    "",
    mdList(ctx.backend.config),
    "",
  ].join("\n");
}

function renderFrontendSummary(ctx) {
  return [
    "# Frontend Summary",
    "",
    "Only reasonably inferable frontend structure is listed here.",
    "",
    "## App / Routing Surface",
    "",
    mdList(ctx.frontend.app),
    "",
    "## Components",
    "",
    mdList(ctx.frontend.components),
    "",
    "## API Clients / Data Hooks",
    "",
    mdList(ctx.frontend.apiClient),
    "",
    "## State / Providers",
    "",
    mdList(ctx.frontend.state),
    "",
    "## Styling",
    "",
    mdList(ctx.frontend.styling),
    "",
  ].join("\n");
}

function renderRecommendedClaude(ctx) {
  const commands = [];
  const importantPaths = [
    "- `.prismo/architecture-summary.md`",
    ctx.backendDetected ? "- `.prismo/backend-summary.md`" : null,
    ctx.frontendDetected ? "- `.prismo/frontend-summary.md`" : null,
  ].filter(Boolean);
  if (hasPath(ctx.scan, (rel) => rel === "package.json")) {
    commands.push("npm run scan");
    commands.push("npm run test:scan");
  }
  if (hasPath(ctx.scan, (rel) => rel === "frontend/package.json")) commands.push("cd frontend && npm run test");
  if (hasPath(ctx.scan, (rel) => rel === "backend/pytest.ini" || rel.startsWith("backend/tests/"))) commands.push("cd backend && pytest");
  return [
    "# CLAUDE.md",
    "",
    "Keep context small. Start with `.prismo/architecture-summary.md`; use scoped `.prismo/*-summary.md` files only when relevant.",
    "",
    "## Commands",
    "",
    ...(commands.length ? commands.map((cmd) => `- \`${cmd}\``) : ["- Check package-specific scripts before running tests."]),
    "",
    "## Architecture",
    "",
    `- Frameworks: ${ctx.frameworks.join(", ") || "not detected"}.`,
    `- Backend: ${ctx.backendDetected ? "see `.prismo/backend-summary.md`" : "not detected"}.`,
    `- Frontend: ${ctx.frontendDetected ? "see `.prismo/frontend-summary.md`" : "not detected"}.`,
    `- Entrypoints: ${proseList(ctx.entrypoints)}.`,
    "",
    "## Rules",
    "",
    "- Do not read generated folders, logs, coverage reports, build output, or lockfiles unless explicitly needed.",
    "- Prefer existing project patterns and narrow edits.",
    "- Use focused context packs for auth/frontend/backend tasks.",
    "- Keep long implementation notes out of persistent instructions.",
    "- Summarize any extra files opened before making broad changes.",
    "",
    "## Important Paths",
    "",
    importantPaths.join("\n"),
    "",
  ].join("\n");
}

function renderRecommendedAgents(ctx) {
  return [
    "# AGENTS.md",
    "",
    "Use `.prismo/architecture-summary.md` first to avoid repeated broad repo exploration. Keep this file durable and short; task-specific details belong in the prompt or scoped context files.",
    "",
    "## Repo Structure",
    "",
    mdList(ctx.folders),
    "",
    "## Conventions",
    "",
    "- Keep changes scoped and follow nearby patterns.",
    "- Use generated `.prismo/*-summary.md` files as compact context.",
    "- Do not load generated artifacts, logs, coverage, caches, binary/media files, or lockfiles by default.",
    "- For focused work, request or attach the relevant scoped context pack.",
    "- Prefer small file reads and targeted searches before opening large documents.",
    "- Call out uncertainty instead of inferring architecture that is not present in the repo.",
    "",
    "## Suggested Workflow",
    "",
    "1. Read `.prismo/architecture-summary.md`.",
    "2. Read the scoped context file for the task, if one exists.",
    "3. Inspect only relevant source files.",
    "4. Run the narrowest useful tests.",
    "",
    "## Important Paths",
    "",
    mdList([".prismo/architecture-summary.md", ".prismo/recommended-.claudeignore", ".prismo/optimize-report.md"]),
    "",
  ].join("\n");
}

function renderGitignoreAdditions(ctx) {
  const additions = [
    ".prismo/*.bak",
    "logs/",
    "test-results/",
    "playwright-report/",
    "*.tmp",
    "*.bak",
  ];
  for (const file of ctx.scan.exposedLargeFiles) {
    if (file.size >= 1024 * 1024) additions.push(file.path);
  }
  return Array.from(new Set(additions)).join("\n") + "\n";
}

function renderOptimizeReport(ctx, generatedFiles) {
  return [
    "# Prismo Optimize Report",
    "",
    "## Executive Summary",
    "",
    `- Estimated context reduction: ${ctx.estimatedContextReduction}`,
    `- Frameworks detected: ${ctx.frameworks.join(", ") || "none"}`,
    `- Generated at: ${ctx.generatedAt}`,
    "",
    "## AI Context Risk Areas",
    "",
    ctx.warnings.length ? ctx.warnings.map((warning) => `- ${warning}`).join("\n") : "- No major local context risks detected.",
    "",
    "## Token-Heavy Directories",
    "",
    mdList(ctx.scan.highRiskDirs.map((dir) => `${dir.path}/${dir.exposed ? " (exposed)" : " (ignored)"}`)),
    "",
    "## Optimization Suggestions",
    "",
    ctx.suggestions.map((suggestion, index) => `${index + 1}. ${suggestion}`).join("\n"),
    "",
    "## Generated Files",
    "",
    mdList(generatedFiles),
    "",
    "## Workflow Improvements",
    "",
    "- Start Claude Code/Codex with architecture-summary.md instead of asking for a broad repo scan.",
    "- Use frontend/backend/auth context packs for scoped tasks.",
    "- Keep persistent instruction files under roughly 500 tokens.",
    "- Avoid pasting giant logs directly into AI coding sessions.",
    "",
  ].join("\n");
}

function renderScopedContext(ctx, scope) {
  const scopeLower = scope.toLowerCase();
  const relevant = ctx.scan.files
    .filter((file) => {
      const rel = file.path.toLowerCase();
      if (scopeLower === "frontend") return rel.includes("frontend/") || rel.includes("src/app/") || rel.includes("src/components/");
      if (scopeLower === "backend") return rel.includes("backend/") || rel.includes("app/modules/") || rel.includes("app/shared/");
      if (scopeLower === "auth") return rel.includes("auth") || rel.includes("supabase") || rel.includes("login") || rel.includes("signup");
      return rel.includes(scopeLower);
    })
    .filter((file) => file.kind !== "binary")
    .slice(0, 60)
    .map((file) => file.path);

  return [
    `# ${scope.charAt(0).toUpperCase()}${scope.slice(1)} Context`,
    "",
    "Use this as a focused context pack for AI coding workflows.",
    "",
    "## Relevant Files",
    "",
    mdList(relevant),
    "",
    "## Notes",
    "",
    "- This file is generated from deterministic path heuristics.",
    "- Verify flow details in source before making behavioral changes.",
    "- Keep follow-up context narrow; do not attach generated files or logs unless needed.",
    "- If this context pack is too broad, search within the listed files before opening all of them.",
    "",
  ].join("\n");
}

function getContextFileForScope(ctx, scope) {
  if (!scope) return ".prismo/architecture-summary.md";
  const normalized = scope.toLowerCase();
  if (normalized === "frontend") return ".prismo/frontend-context.md";
  if (normalized === "backend") return ".prismo/backend-context.md";
  if (normalized === "auth") return ".prismo/auth-context.md";
  return `.prismo/${normalized}-context.md`;
}

function renderStarterPrompt(ctx, scope = null) {
  const contextFile = getContextFileForScope(ctx, scope);
  const supporting = [];
  if (!scope) {
    if (ctx.backendDetected) supporting.push(".prismo/backend-summary.md");
    if (ctx.frontendDetected) supporting.push(".prismo/frontend-summary.md");
  } else if (scope === "frontend") {
    supporting.push(".prismo/frontend-summary.md");
  } else if (scope === "backend") {
    supporting.push(".prismo/backend-summary.md");
  } else if (scope === "auth") {
    supporting.push(".prismo/architecture-summary.md");
  }

  const lines = [
    "Use Prismo's compact repo context before exploring files.",
    `Start with ${contextFile}.`,
  ];
  if (supporting.length) lines.push(`Also use ${supporting.join(" and ")} if needed.`);
  lines.push("Only inspect files directly relevant to the task.");
  lines.push("Do not read generated folders, logs, coverage reports, node_modules, .next, dist, build, cache folders, lockfiles, or large analysis files unless I explicitly ask.");
  lines.push("Before editing, summarize the small set of files you actually inspected and why.");
  return lines.join(" ");
}

function renderContextCommand(ctx, scope = null) {
  const label = scope ? `${scope.charAt(0).toUpperCase()}${scope.slice(1)} Context Prompt` : "Project Context Prompt";
  const contextFile = getContextFileForScope(ctx, scope);
  const existing = fs.existsSync(path.join(ctx.root, contextFile));
  return [
    `# Prismo ${label}`,
    "",
    renderStarterPrompt(ctx, scope),
    "",
    "## Context Files",
    "",
    `- ${contextFile}${existing ? "" : " (run `prismo optimize" + (scope ? ` ${scope}` : "") + "` to generate)"}`,
    !scope && ctx.backendDetected ? "- .prismo/backend-summary.md" : "",
    !scope && ctx.frontendDetected ? "- .prismo/frontend-summary.md" : "",
    scope === "frontend" ? "- .prismo/frontend-summary.md" : "",
    scope === "backend" ? "- .prismo/backend-summary.md" : "",
    "",
    "## Copy/Paste Task Wrapper",
    "",
    "```text",
    `${renderStarterPrompt(ctx, scope)}\n\nTask: <describe the change here>`,
    "```",
    "",
  ].filter(Boolean).join("\n");
}

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
  };
  const seenUsage = new Set();
  let codexCumulative = null;

  for (const row of rows) {
    const timestamp = row.timestamp || row.payload?.started_at || row.message?.timestamp;
    if (timestamp && !session.startedAt) session.startedAt = timestamp;
    if (timestamp) session.updatedAt = timestamp;

    const meta = row.payload?.type === "session_meta" ? row.payload : row.type === "session_meta" ? row.payload : null;
    if (meta) {
      session.sessionId = meta.id || session.sessionId;
      session.cwd = meta.cwd || session.cwd;
      session.model = meta.model || meta.model_slug || session.model;
    }
    if (row.payload?.type === "token_count" && row.payload?.info?.total_token_usage) {
      codexCumulative = row.payload.info.total_token_usage;
    }
    if (row.type === "event_msg" && row.payload?.type === "token_count" && row.payload?.info?.total_token_usage) {
      codexCumulative = row.payload.info.total_token_usage;
    }
    if (row.type === "ai-title" && row.aiTitle) session.title = row.aiTitle;

    const msg = row.message || row.payload;
    const role = msg?.role || row.payload?.role;
    const text = collectText(msg);
    const tokens = estimateTokens(text);
    if (tokens > 0) {
      session.largestTextBlobs.push({
        label: row.type || row.payload?.type || "event",
        tokens,
      });
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
    confidence: selected.every((session) => session.exactAvailable) && selected.length ? "exact-local-log" : "mixed-or-estimated",
    totals,
    sources,
    sessions: selected,
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

function formatTokenCount(value) {
  const n = Number(value || 0);
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
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

function buildLiveWarnings(activeSession, summary) {
  const warnings = [];
  if (!activeSession) {
    warnings.push("No active local session detected for this repo yet.");
    return warnings;
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
  if (warnings.some((warning) => warning.includes("Tool/output"))) return `${NPX_COMMAND} context`;
  if (activeSession.contextRisk === "High") return "Start a fresh coding-agent session before the next unrelated task.";
  if (activeSession.turns >= 20) return `${NPX_COMMAND} optimize`;
  return `${NPX_COMMAND} scan --usage`;
}

function buildLiveSessionView(summary) {
  const activeSession = summary.sessions[0] || null;
  const warnings = buildLiveWarnings(activeSession, summary);
  const topTools = getTopToolNames(activeSession);
  const largestTextBlobs = activeSession ? activeSession.largestTextBlobs || [] : [];
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
          topTools,
          largestTextBlobs,
        }
      : null,
    highestRisk: summary.sessions.reduce((risk, session) => (getRiskRank(session.contextRisk) > getRiskRank(risk) ? session.contextRisk : risk), "Low"),
    warnings,
    recommendedAction: getRecommendedWatchAction(activeSession, warnings),
    nextCommands: Array.from(new Set([
      `${NPX_COMMAND} context`,
      `${NPX_COMMAND} optimize`,
      `${NPX_COMMAND} scan --usage`,
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

function renderWatchTerminal(summary) {
  const live = summary.live || buildLiveSessionView(summary);
  const active = live.activeSession;
  const lines = [];
  lines.push("");
  lines.push(color("Prismo Watch", "bold"));
  lines.push("");
  if (!active) {
    lines.push("Active Session");
    lines.push("- No local Codex/Claude Code session detected for this repo yet.");
    lines.push("");
    lines.push("Next Action");
    lines.push(`Run: ${live.recommendedAction}`);
    lines.push("");
    lines.push("Tip: start Codex or Claude Code in this repo, then keep this watch open.");
    return lines.join("\n");
  }
  lines.push("Active Session");
  lines.push(`Source: ${active.tool}`);
  lines.push(`Tokens: ${formatTokenCount(active.tokens)} (${active.confidence})`);
  if (active.contextTokens && active.contextTokens !== active.tokens) lines.push(`Context tokens observed: ${formatTokenCount(active.contextTokens)}`);
  lines.push(`Context Risk: ${active.contextRisk}`);
  lines.push(`Tool/output tokens: ${formatTokenCount(active.estimatedToolTokens)}`);
  lines.push(`Turns: ${active.turns}  |  Tool calls: ${active.toolCalls}`);
  if (active.model) lines.push(`Model: ${active.model}`);
  if (active.updatedAt) lines.push(`Updated: ${active.updatedAt}`);
  lines.push("");
  lines.push("Live Warnings");
  live.warnings.forEach((warning) => lines.push(`- ${warning}`));
  lines.push("");
  if (active.largestTextBlobs.length) {
    lines.push("Largest Context Sources");
    active.largestTextBlobs.slice(0, 4).forEach((blob) => lines.push(`- ${blob.label}: ~${blob.tokens.toLocaleString()} tokens`));
    lines.push("");
  }
  if (active.topTools.length) {
    lines.push("Top Tools");
    active.topTools.forEach((tool) => lines.push(`- ${tool.name}: ${tool.count}`));
    lines.push("");
  }
  lines.push("Next Action");
  lines.push(`Run: ${live.recommendedAction}`);
  lines.push("");
  lines.push("Useful Commands");
  live.nextCommands.forEach((command) => lines.push(`- ${command}`));
  lines.push("");
  lines.push("Local estimates come from available coding-agent session logs; exact billing requires traffic routed through Prismo.");
  return lines.join("\n");
}

async function watchUsage(options = {}) {
  const intervalMs = options.intervalMs || 3000;
  const iterations = options.once ? 1 : Number.POSITIVE_INFINITY;
  for (let i = 0; i < iterations; i += 1) {
    const summary = getUsageSummary(options);
    summary.live = buildLiveSessionView(summary);
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.clear();
      console.log(renderWatchTerminal(summary));
      console.log(`\nRefreshing every ${Math.round(intervalMs / 1000)}s. Press Ctrl+C to stop.`);
    }
    if (i + 1 >= iterations) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function writeGeneratedFile(root, relPath, contents) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const backupPath = backupIfExists(fullPath);
  fs.writeFileSync(fullPath, contents, "utf8");
  return { path: relPath, backupPath };
}

function runOptimize(rootDir = process.cwd(), options = {}) {
  const ctx = createOptimizeContext(rootDir, options.scope || null);
  const generated = [];
  const pending = [
    ["architecture-summary.md", renderArchitectureSummary(ctx)],
    ["recommended-CLAUDE.md", renderRecommendedClaude(ctx)],
    ["recommended-AGENTS.md", renderRecommendedAgents(ctx)],
    ["recommended-.claudeignore", `${ctx.scan.recommendedClaudeIgnore.join("\n")}\n`],
    ["recommended-.gitignore-additions", renderGitignoreAdditions(ctx)],
  ];
  if (ctx.backendDetected) pending.push(["backend-summary.md", renderBackendSummary(ctx)]);
  if (ctx.frontendDetected) pending.push(["frontend-summary.md", renderFrontendSummary(ctx)]);
  if (ctx.scope) pending.push([`${ctx.scope.toLowerCase()}-context.md`, renderScopedContext(ctx, ctx.scope)]);

  for (const [name, contents] of pending) {
    const written = writeGeneratedFile(ctx.root, path.join(".prismo", name), contents);
    generated.push(written.path);
  }
  const report = renderOptimizeReport(ctx, [...generated, ".prismo/optimize-report.md"]);
  const writtenReport = writeGeneratedFile(ctx.root, path.join(".prismo", "optimize-report.md"), report);
  generated.push(writtenReport.path);

  return {
    root: ctx.root,
    scope: ctx.scope,
    frameworks: ctx.frameworks,
    generatedFiles: generated,
    warnings: ctx.warnings,
    riskScore: ctx.scan.score,
    estimatedContextReduction: ctx.estimatedContextReduction,
    optimizationSuggestions: ctx.suggestions,
    starterPrompt: renderStarterPrompt(ctx, ctx.scope),
    generatedAt: ctx.generatedAt,
  };
}

function renderOptimizeTerminal(result) {
  const lines = [];
  lines.push("");
  lines.push(color("Prismo Optimize", "bold"));
  lines.push("");
  lines.push("Detected:");
  if (result.frameworks.length) result.frameworks.forEach((name) => lines.push(`- ${name}`));
  else lines.push("- No common framework markers detected");
  lines.push("");
  lines.push("Generated:");
  result.generatedFiles.forEach((file) => lines.push(`- [ok] ${file}`));
  lines.push("");
  lines.push("Optimization Opportunities:");
  if (result.warnings.length) result.warnings.forEach((warning) => lines.push(`- ${warning}`));
  else lines.push("- Use generated context packs to reduce repeated repo exploration");
  result.optimizationSuggestions.slice(0, 4).forEach((suggestion) => lines.push(`- ${suggestion}`));
  lines.push("");
  lines.push(`Estimated Context Reduction: ${result.estimatedContextReduction}`);
  lines.push("");
  lines.push("Next Command:");
  lines.push(`${NPX_COMMAND} context${result.scope ? ` ${result.scope}` : ""}`);
  lines.push("");
  lines.push("Starter Prompt:");
  lines.push(result.starterPrompt);
  lines.push("");
  lines.push("Files are recommendations/templates only. No CLAUDE.md, AGENTS.md, .gitignore, or .claudeignore files were overwritten.");
  return lines.join("\n");
}

function createDemoResult() {
  const issues = [
    {
      severity: "critical",
      category: "repo_size",
      title: "Recent local AI sessions used 2.40M tokens",
      description: "Prismo found exact token counts in local coding-agent logs.",
      recommendation: "Use compact context packs and split long sessions at task boundaries.",
      estimatedTokenImpact: "Actual local usage observed: 2,400,000 tokens across 3 recent sessions.",
    },
    {
      severity: "high",
      category: "large_file",
      title: "Large exposed file detected",
      description: "logs/debug-output.json (6.8 MB)",
      recommendation: "Ignore or summarize large logs before loading them into an agent.",
      estimatedTokenImpact: "Likely avoidable token exposure: up to ~1,700,000 tokens if read into context.",
    },
    {
      severity: "medium",
      category: "instruction_file",
      title: "CLAUDE.md is ~1,900 tokens",
      description: "Persistent instructions are larger than the recommended baseline.",
      recommendation: "Trim CLAUDE.md under 500 tokens and link to details only when needed.",
      estimatedTokenImpact: "Potential savings estimate: about 1,400 persistent instruction tokens per turn.",
    },
  ];
  return {
    root: "/demo/prismo-app",
    score: 58,
    risk: "Medium",
    avoidableWaste: "20-40%",
    issues,
    recommendations: [
      "Create .claudeignore with generated/cache folders and large artifacts excluded.",
      "Run `prismo optimize` to generate compact context files.",
      "Start coding sessions from `.prismo/architecture-summary.md` instead of broad repo exploration.",
      "Split long-running coding sessions at task boundaries.",
    ],
    realUsage: {
      tool: "all",
      confidence: "exact-local-log",
      totals: { sessions: 3, displayTokens: 2400000, estimatedTokens: 180000, exactTokens: 2400000, toolTokens: 95000 },
      sessions: [{}, {}, {}],
    },
    stats: { totalFiles: 842, sourceFiles: 318, largeFiles: 4, exposedLargeFiles: 2, highRiskDirs: 7, exposedHighRiskDirs: 3 },
    agentReadiness: {
      claudeCode: { detected: true, localLogsFound: true, mcpServers: 4, hooks: 2, exactProxyTracking: "limited-for-subscription-mode" },
      codex: { detected: true, localLogsFound: true, mcpServers: 1, exactProxyTracking: "available-when-using-api-key-base-url-mode" },
      cursor: { detected: false, exactProxyTracking: "available-only-if-configured-for-openai-compatible-base-url" },
      localUsageLogsAvailable: true,
    },
    optimizationStack: {
      tools: {
        rtk: { detected: false },
        headroom: { detected: false },
        distill: { detected: false },
        mana: { detected: false },
      },
      claudeHooks: 2,
      mcpServerTotal: 5,
    },
    toolOutputRisk: {
      level: "High",
      summary: "Large logs, test reports, build output, or generated files are exposed to coding-agent reads.",
      exposedNoisyDirectories: ["logs", "coverage"],
      exposedNoisyFiles: [{ path: "logs/debug-output.json" }],
    },
    proxyTrackingReadiness: {
      codingAgentBaseUrlMode: {
        codex: "possible-if-using-api-key-mode",
        claudeCode: "limited-for-subscription-sessions",
      },
    },
    topTokenLeaks: getTopTokenLeaks(issues),
    hasClaudeIgnore: false,
    repoDetected: true,
  };
}

function renderDemoTerminal() {
  return [
    renderTerminalReport(createDemoResult(), { reportEnabled: false }),
    "",
    "Try it on your repo:",
    `1. ${NPX_COMMAND} scan --usage`,
    `2. ${NPX_COMMAND} scan --fix`,
    `3. ${NPX_COMMAND} optimize`,
    `4. ${NPX_COMMAND} context frontend`,
  ].join("\n");
}

function runDevFlow(rootDir = process.cwd(), options = {}) {
  const root = path.resolve(rootDir);
  const scanDone = printStep("Scanning repo and local usage", options.json);
  const scan = scanRepo(root, { includeUsage: true, usageLimit: options.limit || 3 });
  scanDone();
  const initialContext = createOptimizeContext(root);
  const scope = initialContext.frameworks.some((name) => ["Next.js", "React", "Vite"].includes(name)) ? "frontend" : null;
  const optimizeDone = printStep("Generating compact context files", options.json);
  const optimize = runOptimize(root, { scope });
  optimizeDone();
  const ctx = createOptimizeContext(root, scope);
  const prompt = renderContextCommand(ctx, scope);
  return {
    scan,
    optimize,
    scope,
    prompt,
    nextCommands: getNextCommands(scan, scope),
  };
}

function renderDevTerminal(result) {
  const lines = [];
  lines.push("");
  lines.push(color("PrismoDev", "bold"));
  lines.push("");
  lines.push(`Score: ${result.scan.score}/100  |  Risk: ${result.scan.risk}  |  Token leaks: ${result.scan.issues.length}`);
  if (result.scan.realUsage && result.scan.realUsage.sessions.length) {
    lines.push(`Real local usage: ${formatTokenCount(result.scan.realUsage.totals.displayTokens)} tokens (${result.scan.realUsage.confidence})`);
  } else if (result.scan.realUsage) {
    lines.push("Real local usage: no matching local sessions found for this repo");
  }
  lines.push("");
  lines.push("Generated:");
  result.optimize.generatedFiles.slice(0, 8).forEach((file) => lines.push(`- ${file}`));
  lines.push("");
  lines.push("Next Commands:");
  result.nextCommands.forEach((cmd, index) => lines.push(`${index + 1}. ${cmd}`));
  lines.push("");
  lines.push("Paste-ready prompt:");
  lines.push(renderStarterPrompt(createOptimizeContext(result.optimize.root, result.scope), result.scope));
  lines.push("");
  return lines.join("\n");
}

function applyFixes(result) {
  const actions = [];
  const claudeIgnorePath = path.join(result.root, ".claudeignore");
  const suggestedClaudeIgnorePath = path.join(result.root, ".claudeignore.prismo-suggested");
  if (!result.hasClaudeIgnore) {
    fs.writeFileSync(claudeIgnorePath, `${result.recommendedClaudeIgnore.join("\n")}\n`, "utf8");
    actions.push("Created .claudeignore");
  } else {
    const backupPath = backupIfExists(suggestedClaudeIgnorePath);
    fs.writeFileSync(suggestedClaudeIgnorePath, `${result.recommendedClaudeIgnore.join("\n")}\n`, "utf8");
    actions.push("Created .claudeignore.prismo-suggested because .claudeignore already exists");
    if (backupPath) actions.push(`Backed up existing .claudeignore.prismo-suggested to ${path.basename(backupPath)}`);
  }
  const report = writeReport(result);
  actions.push(`Generated ${path.basename(report.reportPath)}`);
  if (report.backupPath) actions.push(`Backed up existing report to ${path.basename(report.backupPath)}`);

  const claudeFile = result.instructionFiles.find((file) => file.isClaude);
  if (claudeFile && claudeFile.tokens > 500) {
    const templatePath = path.join(result.root, "prismo-optimized-CLAUDE.template.md");
    const backupPath = backupIfExists(templatePath);
    fs.writeFileSync(templatePath, renderClaudeTemplate(result), "utf8");
    actions.push("Generated prismo-optimized-CLAUDE.template.md");
    if (backupPath) actions.push(`Backed up existing CLAUDE template to ${path.basename(backupPath)}`);
  }

  const hasCodexRisk = result.issues.some((issue) => issue.category === "codex_config");
  if (hasCodexRisk || result.instructionFiles.some((file) => file.path === "AGENTS.md" || file.path.startsWith(".codex/"))) {
    const codexPath = path.join(result.root, "prismo-AGENTS-recommendations.md");
    const backupPath = backupIfExists(codexPath);
    fs.writeFileSync(codexPath, renderAgentsRecommendations(result), "utf8");
    actions.push("Generated prismo-AGENTS-recommendations.md");
    if (backupPath) actions.push(`Backed up existing AGENTS recommendations to ${path.basename(backupPath)}`);
  }
  return actions;
}

function printHelp() {
  console.log(`Prismo CLI

Usage:
  prismo dev [path]
  prismo setup [--json] [--proxy-url URL] [path]
  prismo scan [--fix] [--json] [--usage] [--simple] [--no-report] [path]
  prismo optimize [scope] [--json] [path]
  prismo context [scope] [--json] [path]
  prismo usage [codex|claude|all] [--json] [--limit N] [path]
  prismo watch [codex|claude|all] [--json] [--once] [--interval N] [path]
  prismo demo

Commands:
  dev         Guided flow: scan, optimize, and print a paste-ready context prompt.
  scan        Run PrismoDev for Claude Code, Codex, Cursor, and AI coding workflows.
  optimize    Generate lightweight AI-readable project context files in .prismo/.
  context     Print a copy-pasteable compact context prompt for AI coding tools.
  usage       Read local Codex/Claude Code session logs and summarize token usage.
  watch       Refresh local session usage in the terminal.
  demo        Show sample output without needing a messy repo.
  setup       Detect coding tools, tracking modes, local logs, and Prismo proxy readiness.

Options:
  --fix       Safely create .claudeignore if missing and generate the report.
  --json      Output valid JSON only for CI or future dashboard ingestion.
  --usage     Include real local Codex/Claude Code session usage in scan diagnostics.
  --simple    Print a plain-English scan summary for first-time or non-technical users.
  --no-report Do not write prismo-dev-report.md.
  --limit N   Number of recent local sessions to show.
  --interval N Refresh interval in seconds for watch mode.
  --proxy-url URL Prismo proxy URL to check during setup.
  --once      Run watch mode once, useful for tests and scripts.
  --help      Show this help.
`);
}

function printCommandHelp(command) {
  const help = {
    scan: `PrismoDev

Usage:
  prismo scan [--fix] [--json] [--usage] [--simple] [--no-report] [--limit N] [path]

Examples:
  prismo scan
  prismo scan --usage
  prismo scan --simple
  prismo scan --fix
  prismo scan --usage --json --no-report

Notes:
  --usage reads local Codex/Claude Code logs when present.
  --simple keeps the output short and does not write a report unless combined with --fix.
  --fix creates safe recommendation files and never overwrites CLAUDE.md or AGENTS.md.`,
    optimize: `Prismo Optimize

Usage:
  prismo optimize [auth|frontend|backend] [--json] [path]

Examples:
  prismo optimize
  prismo optimize frontend

Output:
  Generates compact AI context files in .prismo/.`,
    context: `Prismo Context

Usage:
  prismo context [auth|frontend|backend] [--json] [path]

Examples:
  prismo context
  prismo context frontend

Output:
  Prints a paste-ready prompt for Codex, Claude Code, Cursor, and similar tools.`,
    usage: `Prismo Usage

Usage:
  prismo usage [codex|claude|all] [--json] [--limit N] [path]

Examples:
  prismo usage
  prismo usage codex --json
  prismo usage claude --limit 3`,
    watch: `Prismo Watch

Usage:
  prismo watch [codex|claude|all] [--json] [--once] [--interval N] [path]

Examples:
  prismo watch codex
  prismo watch claude --once --json`,
    dev: `PrismoDev

Usage:
  prismo dev [--json] [--limit N] [path]

Flow:
  1. Scan repo and local usage.
  2. Generate .prismo/ optimized context files.
  3. Print a paste-ready prompt.`,
    setup: `PrismoDev Setup

Usage:
  prismo setup [--json] [--proxy-url URL] [--limit N] [path]

Examples:
  prismo setup
  prismo setup --json
  prismo setup --proxy-url http://localhost:8000

Output:
  Detects Claude Code, Codex, Cursor, local logs, optimization stack, and Prismo proxy readiness.
  This command is read-only and does not modify coding-tool config.`,
    demo: `Prismo Demo

Usage:
  prismo demo

Shows sample PrismoDev output without reading local files.
Good first command for people who want to see the value before scanning a repo.`,
  };
  console.log(help[command] || "Unknown command. Try: prismo --help");
}

async function runCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    printCommandHelp(command);
    return;
  }
  if (!["dev", "setup", "scan", "optimize", "context", "usage", "watch", "demo"].includes(command)) {
    throw new Error(`Unknown command: ${command}. Try: prismo dev, prismo setup, prismo scan, prismo optimize, prismo context, or prismo usage`);
  }

  if (command === "demo") {
    console.log(renderDemoTerminal());
    return;
  }

  if (command === "dev") {
    const json = rest.includes("--json");
    const limitIndex = rest.indexOf("--limit");
    const target = getPositionals(rest, new Set(["--limit"]))[0] || process.cwd();
    const result = runDevFlow(target, {
      json,
      limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 3),
    });
    if (json) {
      console.log(JSON.stringify({
        score: result.scan.score,
        riskLevel: result.scan.risk,
        tokenLeaks: result.scan.issues.length,
        realUsage: result.scan.realUsage,
        generatedFiles: result.optimize.generatedFiles,
        nextCommands: result.nextCommands,
        prompt: renderStarterPrompt(createOptimizeContext(result.optimize.root, result.scope), result.scope),
        scannedPath: result.scan.root,
        generatedAt: result.scan.generatedAt,
      }, null, 2));
      return;
    }
    console.log(renderDevTerminal(result));
    return;
  }

  if (command === "setup") {
    const json = rest.includes("--json");
    const limitIndex = rest.indexOf("--limit");
    const proxyIndex = rest.indexOf("--proxy-url");
    const target = getPositionals(rest, new Set(["--limit", "--proxy-url"]))[0] || process.cwd();
    const result = await runSetup(target, {
      limit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 3),
      proxyUrl: proxyIndex >= 0 ? rest[proxyIndex + 1] : DEFAULT_PRISMO_PROXY_URL,
      skipProxyCheck: rest.includes("--skip-proxy-check"),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(renderSetupTerminal(result));
    return;
  }

  if (command === "usage" || command === "watch") {
    const json = rest.includes("--json");
    const knownTools = new Set(["codex", "claude", "all"]);
    const positional = getPositionals(rest, new Set(["--limit", "--interval"]));
    const tool = positional[0] && knownTools.has(positional[0].toLowerCase()) ? positional[0].toLowerCase() : "all";
    const target = tool === "all" ? positional[0] || process.cwd() : positional[1] || process.cwd();
    const limitIndex = rest.indexOf("--limit");
    const intervalIndex = rest.indexOf("--interval");
    const limit = parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5);
    const intervalMs = parsePositiveInt(intervalIndex >= 0 ? rest[intervalIndex + 1] : null, 3) * 1000;
    const usageOptions = {
      tool,
      cwd: path.resolve(target),
      limit,
      json,
      once: rest.includes("--once"),
      intervalMs,
    };

    if (command === "watch") {
      await watchUsage(usageOptions);
      return;
    }

    const summary = getUsageSummary(usageOptions);
    if (json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(renderUsageTerminal(summary));
    return;
  }

  if (command === "context") {
    const json = rest.includes("--json");
    const positional = rest.filter((arg) => !arg.startsWith("-"));
    const knownScopes = new Set(["auth", "frontend", "backend"]);
    const scope = positional[0] && knownScopes.has(positional[0].toLowerCase()) ? positional[0].toLowerCase() : null;
    const target = scope ? positional[1] || process.cwd() : positional[0] || process.cwd();
    const ctx = createOptimizeContext(target, scope);
    const prompt = renderStarterPrompt(ctx, scope);
    const output = renderContextCommand(ctx, scope);
    if (json) {
      console.log(JSON.stringify({
        scope,
        prompt,
        contextFile: getContextFileForScope(ctx, scope),
        supportingFiles: [
          !scope && ctx.backendDetected ? ".prismo/backend-summary.md" : null,
          !scope && ctx.frontendDetected ? ".prismo/frontend-summary.md" : null,
          scope === "frontend" ? ".prismo/frontend-summary.md" : null,
          scope === "backend" ? ".prismo/backend-summary.md" : null,
        ].filter(Boolean),
        scannedPath: ctx.root,
        generatedAt: ctx.generatedAt,
      }, null, 2));
      return;
    }
    console.log(output);
    return;
  }

  if (command === "optimize") {
    const json = rest.includes("--json");
    const positional = rest.filter((arg) => !arg.startsWith("-"));
    const knownScopes = new Set(["auth", "frontend", "backend"]);
    const scope = positional[0] && knownScopes.has(positional[0].toLowerCase()) ? positional[0].toLowerCase() : null;
    const target = scope ? positional[1] || process.cwd() : positional[0] || process.cwd();
    const result = runOptimize(target, { scope });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(renderOptimizeTerminal(result));
    return;
  }

  const fix = rest.includes("--fix");
  const noReport = rest.includes("--no-report");
  const json = rest.includes("--json");
  const simple = rest.includes("--simple");
  const includeUsage = rest.includes("--usage");
  const limitIndex = rest.indexOf("--limit");
  const usageToolIndex = rest.indexOf("--usage-tool");
  const target = getPositionals(rest, new Set(["--limit", "--usage-tool"]))[0] || process.cwd();
  const scanDone = printStep(includeUsage ? "Scanning repo and local usage" : "Scanning repo", json || simple);
  const result = scanRepo(target, {
    includeUsage,
    usageLimit: parsePositiveInt(limitIndex >= 0 ? rest[limitIndex + 1] : null, 5),
    usageTool: usageToolIndex >= 0 ? rest[usageToolIndex + 1] : "all",
  });
  scanDone();

  if (json) {
    let fixActions = [];
    let report = null;
    if (fix) {
      fixActions = applyFixes(result);
    } else if (!noReport) {
      report = writeReport(result);
    }
    const payload = toJsonPayload(result);
    if (fixActions.length) payload.fixActions = fixActions;
    if (report) payload.reportPath = report.reportPath;
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (simple) {
    console.log(renderSimpleScanReport(result));
  } else {
    console.log(renderTerminalReport(result, { reportEnabled: !noReport || fix }));
  }

  if (fix) {
    const actions = applyFixes(result);
    console.log("\nFix Mode:");
    actions.forEach((action) => console.log(`- ${action}`));
  } else if (!noReport && !simple) {
    const report = writeReport(result);
    if (report.backupPath) {
      console.log(`\nExisting report backed up to ${path.basename(report.backupPath)}.`);
    }
  }
}

module.exports = {
  applyFixes,
  estimateTokens,
  renderMarkdownReport,
  renderSimpleScanReport,
  renderUsageTerminal,
  renderWatchTerminal,
  renderTerminalReport,
  runSetup,
  runOptimize,
  runCli,
  scanRepo,
  getUsageSummary,
  analyzeSessionFile,
  toJsonPayload,
  watchUsage,
  writeReport,
};
