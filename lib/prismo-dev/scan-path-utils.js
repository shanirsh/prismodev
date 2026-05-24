module.exports = function createScanPathUtils(deps) {
  const { fs, path } = deps;

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

  function ignoreSuggestionCovered(pattern, existingPatterns) {
    if (!pattern) return true;
    if (existingPatterns.includes(pattern)) return true;
    const sample = pattern
      .replace(/^\*\//, "")
      .replace(/^\*\*/, "sample")
      .replace(/\*/g, "sample")
      .replace(/\/$/, "");
    const isDir = pattern.endsWith("/") || pattern.endsWith("/**");
    return existingPatterns.some((existing) => {
      if (existing === pattern) return true;
      if (existing.endsWith("/") && pattern.startsWith(existing)) return true;
      return patternMatches(existing, sample, isDir);
    });
  }

  function missingIgnoreSuggestions(recommended, existingPatterns) {
    return recommended.filter((pattern) => !ignoreSuggestionCovered(pattern, existingPatterns));
  }

  const SESSION_NOISE_DIRS = new Set([
    ".next",
    ".nuxt",
    ".prismo",
    ".pytest_cache",
    ".turbo",
    "__pycache__",
    "build",
    "calendar-dumps",
    "coverage",
    "dist",
    "event-dumps",
    "events",
    "exports",
    "htmlcov",
    "inbox-dumps",
    "logs",
    "models",
    "node_modules",
    "out",
    "playwright-report",
    "session-dumps",
    "source-streams",
    "state-backups",
    "test-results",
    "tmp",
    "temp",
  ]);

  const SESSION_NOISE_FILE_NAMES = new Set([
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "coverage-final.json",
    "lcov.info",
  ]);

  const SESSION_NOISE_EXTENSIONS = new Set([
    ".db",
    ".jsonl",
    ".lock",
    ".log",
    ".sqlite",
    ".sqlite3",
  ]);

  function cleanSessionPath(value) {
    const text = String(value || "").trim().replace(/\\/g, "/");
    if (!text || /^https?:\/\//.test(text)) return null;
    const withoutQuotes = text.replace(/^["'`]+|["'`.,:;)\]]+$/g, "");
    if (!withoutQuotes || withoutQuotes.includes("\n")) return null;
    const markerIndex = withoutQuotes.indexOf("/Users/");
    if (markerIndex > 0) return withoutQuotes.slice(markerIndex);
    return withoutQuotes;
  }

  function sessionIgnorePatternForPath(value, root) {
    const cleaned = cleanSessionPath(value);
    if (!cleaned) return null;
    const rootNormalized = normalizeRel(root);
    let rel = cleaned;
    if (path.isAbsolute(cleaned)) {
      const normalized = normalizeRel(cleaned);
      if (!normalized.startsWith(`${rootNormalized}/`)) return null;
      rel = normalizeRel(path.relative(root, cleaned));
    }
    rel = normalizeRel(rel).replace(/^\.\//, "");
    if (!rel || rel === "." || rel.startsWith("../") || rel.includes("..")) return null;

    const segments = rel.split("/").filter(Boolean);
    if (!segments.length) return null;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (SESSION_NOISE_DIRS.has(segment)) {
        return `${segments.slice(0, index + 1).join("/")}/`;
      }
    }

    const fileName = segments[segments.length - 1];
    const lowerName = fileName.toLowerCase();
    const ext = path.extname(lowerName);
    if (SESSION_NOISE_FILE_NAMES.has(lowerName)) return fileName;
    if (SESSION_NOISE_EXTENSIONS.has(ext)) return rel;
    if (/_state\.json$/i.test(fileName)) return "*_state.json";
    if (/_tokens\.json$/i.test(fileName)) return "*_tokens.json";
    if (/_export\.json$/i.test(fileName)) return "*_export.json";
    if (/secret|credential|token/i.test(fileName) && /\.json$/i.test(fileName)) return rel;
    return null;
  }

  function buildSessionIgnoreSuggestions(realUsage, root) {
    if (!realUsage || !Array.isArray(realUsage.sessions)) return [];
    const byPattern = new Map();
    const add = (pattern, item, source, reason) => {
      if (!pattern) return;
      const existing = byPattern.get(pattern) || {
        pattern,
        source,
        reason,
        count: 0,
        examples: [],
      };
      existing.count += Number(item?.count || 1);
      const example = item?.value || item?.path || pattern;
      if (example && !existing.examples.includes(example) && existing.examples.length < 3) existing.examples.push(example);
      byPattern.set(pattern, existing);
    };

    for (const session of realUsage.sessions) {
      for (const item of session.generatedArtifacts || []) {
        add(sessionIgnorePatternForPath(item.value, root), item, session.tool || "session", "Generated artifact entered local session context.");
      }
      for (const item of session.repeatedPathMentions || []) {
        add(sessionIgnorePatternForPath(item.value, root), item, session.tool || "session", "Noisy path appeared repeatedly in local session context.");
      }
    }
    return Array.from(byPattern.values())
      .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern))
      .slice(0, 25);
  }

  return {
    buildSessionIgnoreSuggestions,
    isIgnored,
    missingIgnoreSuggestions,
    normalizeRel,
    readIgnoreFile,
  };
};
