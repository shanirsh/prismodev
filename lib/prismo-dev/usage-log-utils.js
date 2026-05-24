module.exports = function createUsageLogUtils(deps) {
  const {
    fs,
    path,
    GENERATED_ARTIFACT_PATTERNS,
    readIfText,
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

  return {
    addUsage,
    collectText,
    extractCommandCandidates,
    extractMentionedPaths,
    getActionableRepeatedPaths,
    incrementMap,
    isGeneratedArtifactPath,
    listFilesRecursive,
    normalizeMentionedPath,
    parseJsonl,
    summarizeGeneratedArtifacts,
    topCountEntries,
    totalUsageTokens,
  };
};
