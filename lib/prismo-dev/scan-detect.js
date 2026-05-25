module.exports = function createScanDetect(deps) {
  const { fs, http, https, os, path, readIfText, estimateTokens, getClaudeSessionFiles, getCodexSessionFiles, normalizeRel } = deps;

  let cursorSessionsModule = null;
  function getCursorModule() {
    if (!cursorSessionsModule) {
      cursorSessionsModule = require("./cursor-sessions")({ fs, os, path, estimateTokens });
    }
    return cursorSessionsModule;
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
    const packageText = readIfText(path.join(root, "package.json"), 512 * 1024) || "";
    const readmeText = readIfText(path.join(root, "README.md"), 512 * 1024) || "";
    const projectText = `${packageText}\n${readmeText}`.toLowerCase();
    const hasText = (pattern) => pattern.test(projectText);

    const tools = {
      rtk: { detected: projectRtk, source: projectRtk ? "binary-or-project-config" : "not-detected" },
      headroom: { detected: projectHeadroom || commandExists("headroom"), source: projectHeadroom ? "local-config" : commandExists("headroom") ? "binary" : "not-detected" },
      distill: { detected: projectDistill, source: projectDistill ? "binary-or-user-config" : "not-detected" },
      mana: { detected: projectMana || commandExists("mana"), source: projectMana ? "local-config" : commandExists("mana") ? "binary" : "not-detected" },
      contextMode: { detected: commandExists("context-mode") || hasText(/context-mode/), source: commandExists("context-mode") ? "binary" : hasText(/context-mode/) ? "project-reference" : "not-detected" },
      leanCtx: { detected: commandExists("lean-ctx") || hasText(/lean-ctx|lean ctx/), source: commandExists("lean-ctx") ? "binary" : hasText(/lean-ctx|lean ctx/) ? "project-reference" : "not-detected" },
      repomix: { detected: commandExists("repomix") || hasText(/repomix/), source: commandExists("repomix") ? "binary" : hasText(/repomix/) ? "project-reference" : "not-detected" },
      codegraph: { detected: commandExists("codegraph") || hasText(/codegraph|codebase-memory-mcp|jcodemunch|sigmap/), source: commandExists("codegraph") ? "binary" : hasText(/codegraph|codebase-memory-mcp|jcodemunch|sigmap/) ? "project-reference" : "not-detected" },
      tokf: { detected: commandExists("tokf") || hasText(/tokf/), source: commandExists("tokf") ? "binary" : hasText(/tokf/) ? "project-reference" : "not-detected" },
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
    const cursorHome = process.env.PRISMO_CURSOR_HOME || path.join(os.homedir(), ".cursor");
    const cursorPaths = [
      path.join(root, ".cursor"),
      path.join(root, ".cursorrules"),
      cursorHome,
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
      cursor: (() => {
        const detected = pathExistsAny(cursorPaths);
        const cursorMod = getCursorModule();
        const dbAvailable = cursorMod.isSqlite3Available() && fs.existsSync(path.join(cursorHome, "ai-tracking", "ai-code-tracking.db"));
        const dbStats = dbAvailable ? cursorMod.getAiTrackingDbStats() : null;
        const workspace = detected ? cursorMod.getCursorWorkspaceForProject(root) : null;
        const composers = dbAvailable ? cursorMod.getCursorComposerHeaders() : [];
        return {
          detected,
          configFiles: cursorPaths.filter((candidate) => fs.existsSync(candidate)),
          localLogsFound: dbAvailable && (dbStats ? (dbStats.ai_code_hashes + dbStats.scored_commits + dbStats.conversation_summaries) > 0 : false),
          dbAvailable,
          dbStats,
          workspace,
          totalSessions: composers.length,
          activeSessions: composers.filter((c) => !c.isArchived).length,
          exactProxyTracking: "available-only-if-configured-for-openai-compatible-base-url",
          recommendedMode: dbAvailable ? "cursor-tracking-db-and-repo-scan" : "repo-scan-and-prismo-proxy-when-supported",
        };
      })(),
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

  function detectOperationalNoise(files) {
    const candidates = files
      .filter((file) => !file.ignored && file.size >= 16 * 1024 && file.kind !== "binary")
      .filter((file) => /\.(json|jsonl|ndjson|log|md|txt)$/i.test(file.path) || /(events?|inbox|calendar|github|issues?|heartbeat|poll|source-stream|session-dump|activity|notifications?)/i.test(file.path))
      .slice(0, 120);
    const findings = [];

    for (const file of candidates) {
      const text = readIfText(file.fullPath, 512 * 1024) || "";
      if (!text) continue;
      const signals = [];
      const timestampCount = (text.match(/\b20\d{2}-\d{2}-\d{2}[T ][0-2]\d:/g) || []).length;
      const emailCount = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).length;
      const eventKeyCount = (text.match(/"(event|type|timestamp|created_at|updated_at|attendees|organizer|sender|subject|body|issue|pull_request|repository|payload)"\s*:/gi) || []).length;
      const markdownEventCount = (text.match(/\b(calendar|inbox|email|github|issue|pull request|notification|attendee|heartbeat|poll(ed|ing)?)\b/gi) || []).length;
      const repeatedObjectCount = (text.match(/^\s*\{.*\}\s*$/gm) || []).length;

      if (timestampCount >= 12) signals.push(`${timestampCount} timestamps`);
      if (emailCount >= 8) signals.push(`${emailCount} email-like strings`);
      if (eventKeyCount >= 30) signals.push(`${eventKeyCount} event-shaped JSON keys`);
      if (markdownEventCount >= 20) signals.push(`${markdownEventCount} operational keywords`);
      if (repeatedObjectCount >= 15) signals.push(`${repeatedObjectCount} JSONL-style objects`);

      if (signals.length >= 2 || eventKeyCount >= 60 || (timestampCount >= 20 && markdownEventCount >= 15)) {
        findings.push({
          path: file.path,
          sizeBytes: file.size,
          estimatedTokensIfRead: estimateTokens(file.size),
          signals: signals.slice(0, 4),
        });
      }
    }

    const estimatedExposureTokens = findings.reduce((sum, item) => sum + item.estimatedTokensIfRead, 0);
    let level = "Low";
    if (findings.length >= 3 || estimatedExposureTokens >= 150000) level = "High";
    else if (findings.length || estimatedExposureTokens >= 25000) level = "Medium";

    return {
      level,
      files: findings.slice(0, 12),
      estimatedExposureTokens,
      summary:
        level === "High"
          ? "Operational source-stream dumps may be leaking inbox/calendar/GitHub-style noise back into coding context."
          : level === "Medium"
            ? "Possible operational source-stream dumps detected; these can become second-order context leaks."
            : "No obvious operational source-stream dumps detected.",
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

  return {
    buildProxyTrackingReadiness,
    checkUrlReachable,
    detectAgentReadiness,
    detectOperationalNoise,
    detectOptimizationStack,
    detectToolOutputRisk,
    scanClaudeConfig,
    scanCodexConfig,
  };
};
