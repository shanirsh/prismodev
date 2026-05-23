module.exports = function createFixes(deps) {
  const { fs, path, backupIfExists, writeReport } = deps;

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

function readIgnoreLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/);
}

function normalizeRule(line) {
  return String(line || "").trim();
}

function stableBackup(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = `${filePath}.prismo-backup`;
  if (fs.existsSync(backupPath)) backupIfExists(backupPath);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function appendIgnoreSuggestions(result, options = {}) {
  const actions = [];
  const files = [
    {
      name: ".claudeignore",
      path: path.join(result.root, ".claudeignore"),
      suggestions: result.hasClaudeIgnore ? result.missingClaudeIgnoreSuggestions || [] : result.recommendedClaudeIgnore || [],
    },
    {
      name: ".cursorignore",
      path: path.join(result.root, ".cursorignore"),
      suggestions: result.hasCursorIgnore ? result.missingCursorIgnoreSuggestions || [] : result.recommendedCursorIgnore || [],
    },
  ];

  for (const file of files) {
    const existingLines = readIgnoreLines(file.path);
    const existingRules = new Set(existingLines.map(normalizeRule).filter((line) => line && !line.startsWith("#")));
    const missing = Array.from(new Set((file.suggestions || []).map(normalizeRule).filter(Boolean)))
      .filter((rule) => !existingRules.has(rule));

    if (!missing.length) {
      actions.push(`Skipped ${file.name}; existing rules already cover Prismo suggestions`);
      continue;
    }

    if (options.dryRun) {
      actions.push(`Would update ${file.name}: +${missing.join(", +")}`);
      continue;
    }

    const existed = fs.existsSync(file.path);
    const backupPath = stableBackup(file.path);
    const nextLines = existingLines.slice();
    while (nextLines.length && !nextLines[nextLines.length - 1].trim()) nextLines.pop();
    if (nextLines.length) nextLines.push("");
    nextLines.push("# Added by PrismoDev");
    missing.forEach((rule) => nextLines.push(rule));
    fs.writeFileSync(file.path, `${nextLines.join("\n")}\n`, "utf8");

    actions.push(`${existed ? "Updated" : "Created"} ${file.name}: +${missing.join(", +")}`);
    if (backupPath) actions.push(`Backup written: ${path.basename(backupPath)}`);
  }

  return actions;
}

function applyFixes(result, options = {}) {
  const actions = [];
  const dryRunPrefix = options.dryRun ? "Would create" : "Created";
  const ignoresOnly = Boolean(options.ignoresOnly);
  const claudeIgnorePath = path.join(result.root, ".claudeignore");
  const suggestedClaudeIgnorePath = path.join(result.root, ".claudeignore.prismo-suggested");
  const cursorIgnorePath = path.join(result.root, ".cursorignore");
  const suggestedCursorIgnorePath = path.join(result.root, ".cursorignore.prismo-suggested");
  if (!result.hasClaudeIgnore) {
    if (!options.dryRun) fs.writeFileSync(claudeIgnorePath, `${result.recommendedClaudeIgnore.join("\n")}\n`, "utf8");
    actions.push(`${dryRunPrefix} .claudeignore`);
  } else if (result.missingClaudeIgnoreSuggestions && result.missingClaudeIgnoreSuggestions.length === 0) {
    actions.push("Skipped .claudeignore.prismo-suggested because existing .claudeignore already covers Prismo recommendations");
  } else {
    const backupPath = options.dryRun ? null : backupIfExists(suggestedClaudeIgnorePath);
    const suggestions = result.missingClaudeIgnoreSuggestions || result.recommendedClaudeIgnore;
    if (!options.dryRun) fs.writeFileSync(suggestedClaudeIgnorePath, `${suggestions.join("\n")}\n`, "utf8");
    actions.push(`${dryRunPrefix} .claudeignore.prismo-suggested because .claudeignore already exists`);
    if (backupPath) actions.push(`Backed up existing .claudeignore.prismo-suggested to ${path.basename(backupPath)}`);
  }
  if (!result.hasCursorIgnore) {
    if (!options.dryRun) fs.writeFileSync(cursorIgnorePath, `${result.recommendedCursorIgnore.join("\n")}\n`, "utf8");
    actions.push(`${dryRunPrefix} .cursorignore`);
  } else if (result.missingCursorIgnoreSuggestions && result.missingCursorIgnoreSuggestions.length === 0) {
    actions.push("Skipped .cursorignore.prismo-suggested because existing .cursorignore already covers Prismo recommendations");
  } else {
    const backupPath = options.dryRun ? null : backupIfExists(suggestedCursorIgnorePath);
    const suggestions = result.missingCursorIgnoreSuggestions || result.recommendedCursorIgnore;
    if (!options.dryRun) fs.writeFileSync(suggestedCursorIgnorePath, `${suggestions.join("\n")}\n`, "utf8");
    actions.push(`${dryRunPrefix} .cursorignore.prismo-suggested because .cursorignore already exists`);
    if (backupPath) actions.push(`Backed up existing .cursorignore.prismo-suggested to ${path.basename(backupPath)}`);
  }
  if (ignoresOnly) return actions;

  const report = options.dryRun ? { reportPath: path.join(result.root, ".prismo", "prismo-dev-report.md"), backupPath: null } : writeReport(result);
  actions.push(`${options.dryRun ? "Would generate" : "Generated"} .prismo/${path.basename(report.reportPath)}`);
  if (report.backupPath) actions.push(`Backed up existing report to ${path.basename(report.backupPath)}`);

  const claudeFile = result.instructionFiles.find((file) => file.isClaude);
  if (claudeFile && claudeFile.tokens > 500) {
    const templatePath = path.join(result.root, "prismo-optimized-CLAUDE.template.md");
    const backupPath = options.dryRun ? null : backupIfExists(templatePath);
    if (!options.dryRun) fs.writeFileSync(templatePath, renderClaudeTemplate(result), "utf8");
    actions.push(`${options.dryRun ? "Would generate" : "Generated"} prismo-optimized-CLAUDE.template.md`);
    if (backupPath) actions.push(`Backed up existing CLAUDE template to ${path.basename(backupPath)}`);
  }

  const hasCodexRisk = result.issues.some((issue) => issue.category === "codex_config");
  if (hasCodexRisk || result.instructionFiles.some((file) => file.path === "AGENTS.md" || file.path.startsWith(".codex/"))) {
    const prismoDir = path.join(result.root, ".prismo");
    if (!options.dryRun) fs.mkdirSync(prismoDir, { recursive: true });
    const codexPath = path.join(prismoDir, "prismo-AGENTS-recommendations.md");
    const backupPath = options.dryRun ? null : backupIfExists(codexPath);
    if (!options.dryRun) fs.writeFileSync(codexPath, renderAgentsRecommendations(result), "utf8");
    actions.push(`${options.dryRun ? "Would generate" : "Generated"} .prismo/prismo-AGENTS-recommendations.md`);
    if (backupPath) actions.push(`Backed up existing AGENTS recommendations to ${path.basename(backupPath)}`);
  }
  return actions;
}

  return {
    appendIgnoreSuggestions,
    applyFixes,
    renderAgentsRecommendations,
    renderClaudeTemplate,
  };
};
