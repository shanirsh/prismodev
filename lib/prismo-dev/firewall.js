module.exports = function createFirewall(deps) {
  const {
    fs,
    path,
    NPX_COMMAND,
    createOptimizeContext,
    writeGeneratedFile,
  } = deps;

function uniq(items) {
  return Array.from(new Set((items || []).filter(Boolean)));
}

function inferTaskScope(task = "", ctx) {
  const text = String(task || "").toLowerCase();
  if (/auth|login|session|oauth|jwt|middleware/.test(text)) return "auth";
  if (/front|ui|react|next|page|component|css|style/.test(text)) return "frontend";
  if (/back|api|server|route|db|database|model|schema|worker/.test(text)) return "backend";
  if (ctx.scope) return ctx.scope;
  if (ctx.frontendDetected && !ctx.backendDetected) return "frontend";
  if (ctx.backendDetected && !ctx.frontendDetected) return "backend";
  return "general";
}

function globForFile(rel) {
  const normalized = String(rel || "").replace(/\\/g, "/");
  if (!normalized || !normalized.includes("/")) return normalized;
  const parts = normalized.split("/");
  if (parts.length <= 2) return normalized;
  return `${parts.slice(0, -1).join("/")}/*`;
}

function buildAllowedContext(ctx, taskScope) {
  const allowed = [];
  allowed.push(".prismo/architecture-summary.md");
  allowed.push("package.json");
  allowed.push("README.md");
  if (ctx.frameworks.includes("TypeScript")) allowed.push("tsconfig.json");

  if (taskScope === "frontend" || taskScope === "general") {
    allowed.push(".prismo/frontend-summary.md");
    allowed.push(...ctx.frontend.app.slice(0, 8).map(globForFile));
    allowed.push(...ctx.frontend.components.slice(0, 8).map(globForFile));
    allowed.push(...ctx.frontend.apiClient.slice(0, 6).map(globForFile));
    allowed.push(...ctx.frontend.styling.slice(0, 4).map(globForFile));
  }

  if (taskScope === "backend" || taskScope === "general") {
    allowed.push(".prismo/backend-summary.md");
    allowed.push(...ctx.backend.api.slice(0, 8).map(globForFile));
    allowed.push(...ctx.backend.services.slice(0, 8).map(globForFile));
    allowed.push(...ctx.backend.models.slice(0, 6).map(globForFile));
    allowed.push(...ctx.backend.config.slice(0, 4).map(globForFile));
  }

  if (taskScope === "auth") {
    allowed.push(".prismo/backend-summary.md");
    allowed.push(".prismo/frontend-summary.md");
    allowed.push(...ctx.backend.auth.slice(0, 10).map(globForFile));
    allowed.push(...ctx.backend.api.filter((p) => /auth|user|session|account/i.test(p)).slice(0, 8).map(globForFile));
    allowed.push(...ctx.frontend.app.filter((p) => /auth|login|account|dashboard|middleware/i.test(p)).slice(0, 8).map(globForFile));
    allowed.push(...ctx.frontend.apiClient.filter((p) => /auth|user|session|account/i.test(p)).slice(0, 8).map(globForFile));
    allowed.push("middleware.ts");
    allowed.push("src/middleware.ts");
    allowed.push("frontend/src/middleware.ts");
  }

  return uniq(allowed).slice(0, 60);
}

function buildBlockedContext(ctx) {
  const blocked = [
    "node_modules/**",
    ".next/**",
    "dist/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "logs/**",
    "events/**",
    "event-dumps/**",
    "session-dumps/**",
    "source-streams/**",
    "inbox-dumps/**",
    "calendar-dumps/**",
    "**/*.log",
    "**/*.jsonl",
    "**/*.ndjson",
    "**/*.map",
    "**/__pycache__/**",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
  ];
  for (const dir of ctx.scan.exposedHighRiskDirs || []) blocked.push(`${dir.path}/**`);
  for (const file of ctx.scan.exposedLargeFiles || []) blocked.push(file.path);
  return uniq(blocked).slice(0, 80);
}

function isGeneratedLike(value) {
  const text = String(value || "").replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(node_modules|dist|build|coverage|\.next|__pycache__|logs?|events?|source-streams?|session-dumps?|playwright-report|test-results)(\/|$)/.test(text)
    || /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/.test(text)
    || /\.(log|jsonl|ndjson|map|pyc)$/.test(text);
}

function firewallPatternForPath(value) {
  const text = String(value || "").replace(/\\/g, "/").replace(/\s+\(\d+x\)$/, "");
  if (!text) return null;
  if (/(^|\/)__pycache__(\/|$)/.test(text)) return "**/__pycache__/**";
  if (/(^|\/)(node_modules|dist|build|coverage|\.next|logs?|events?|source-streams?|session-dumps?|playwright-report|test-results)\//.test(text)) {
    const match = text.match(/(^|\/)(node_modules|dist|build|coverage|\.next|logs?|events?|source-streams?|session-dumps?|playwright-report|test-results)\//);
    const prefix = text.slice(0, match.index + match[0].length).replace(/\/$/, "");
    return `${prefix}/**`;
  }
  return text;
}

function timelineEventPath(event) {
  const detail = String(event?.detail || "");
  const match = detail.match(/^(.+?)\s+\(\d+x\)$/);
  return (match ? match[1] : detail).trim();
}

function buildTimelineFirewallSuggestions(ctx, session, taskScope) {
  const baseAllowed = buildAllowedContext(ctx, taskScope);
  const baseBlocked = buildBlockedContext(ctx);
  const timeline = session?.timeline || [];
  const repeated = session?.repeatedPathMentions || [];
  const artifacts = session?.generatedArtifacts || [];

  const sessionAllowed = repeated
    .map((item) => item.value)
    .filter((value) => value && !isGeneratedLike(value))
    .map(globForFile)
    .slice(0, 20);

  const sessionBlocked = [
    ...artifacts.map((item) => item.value),
    ...timeline.filter((event) => event.type === "artifact-leak").map(timelineEventPath),
    ...repeated.map((item) => item.value).filter(isGeneratedLike),
  ].map(firewallPatternForPath).filter(Boolean);

  return {
    allowed: uniq([...sessionAllowed, ...baseAllowed]).slice(0, 80),
    blocked: uniq([...sessionBlocked, ...baseBlocked]).slice(0, 100),
    sessionAllowed: uniq(sessionAllowed),
    sessionBlocked: uniq(sessionBlocked),
  };
}

function renderLines(title, items) {
  return [`# ${title}`, "", ...items.map((item) => item)].join("\n") + "\n";
}

function renderFirewallPolicy(result) {
  return [
    "# Prismo Context Firewall",
    "",
    `Generated: ${result.generatedAt}`,
    `Task: ${result.task || "general"}`,
    `Scope: ${result.scope}`,
    "",
    "This is an AI coding context policy. It does not enforce filesystem access by itself; give it to your agent and require the agent to follow it before reading files.",
    "",
    "## Allowed Context",
    "",
    ...result.allowed.map((item) => `- ${item}`),
    "",
    "## Blocked Unless Explicitly Justified",
    "",
    ...result.blocked.map((item) => `- ${item}`),
    "",
    "## Rules",
    "",
    "- Start from allowed context only.",
    "- If another file is needed, explain why before reading it.",
    "- Prefer summaries and targeted ranges over full-file reads.",
    "- Do not read blocked paths unless the user explicitly asks or the task cannot proceed without them.",
    "- If context pressure gets high, stop and run `npx getprismo watch --auto`.",
    "",
  ].join("\n");
}

function renderFirewallPrompt(result) {
  return [
    "# Prismo Firewall Prompt",
    "",
    "Use this at the start of an AI coding session:",
    "",
    "```text",
    `Follow .prismo/context-firewall.md for this ${result.task || result.scope} task.`,
    "Only read allowed context first.",
    "Do not read blocked paths unless you explain why they are required.",
    "Keep command output short and summarize before expanding context.",
    "If you need more context, ask for approval or name the exact file and reason.",
    "```",
    "",
  ].join("\n");
}

function runFirewall(rootDir = process.cwd(), options = {}) {
  const ctx = createOptimizeContext(rootDir, options.scope || null);
  const task = options.task || options.scope || "general";
  const scope = inferTaskScope(task, ctx);
  const allowed = buildAllowedContext(ctx, scope);
  const blocked = buildBlockedContext(ctx);
  const result = {
    root: ctx.root,
    task,
    scope,
    allowed,
    blocked,
    generatedAt: new Date().toISOString(),
    generatedFiles: [
      ".prismo/context-firewall.md",
      ".prismo/allowed-context.txt",
      ".prismo/blocked-context.txt",
      ".prismo/firewall-prompt.md",
    ],
  };

  if (!options.dryRun) {
    const write = (relPath, contents) => {
      if (!options.live) return writeGeneratedFile(ctx.root, relPath, contents);
      const fullPath = path.join(ctx.root, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, contents, "utf8");
      return { path: relPath, backupPath: null };
    };
    write(".prismo/context-firewall.md", renderFirewallPolicy(result));
    write(".prismo/allowed-context.txt", renderLines("Allowed Context", allowed));
    write(".prismo/blocked-context.txt", renderLines("Blocked Context", blocked));
    write(".prismo/firewall-prompt.md", renderFirewallPrompt(result));
  }
  result.dryRun = Boolean(options.dryRun);
  return result;
}

function renderTimelineFirewallSuggestions(result) {
  const lines = [];
  lines.push("# Prismo Timeline Firewall Suggestions");
  lines.push("");
  lines.push(`Generated: ${result.generatedAt}`);
  lines.push(`Task: ${result.task}`);
  lines.push(`Scope: ${result.scope}`);
  if (result.sessionId) lines.push(`Session: ${result.sessionId}`);
  lines.push("");
  lines.push("These suggestions came from `cc timeline` session evidence. They are safe recommendation files; Prismo does not overwrite your active firewall unless you copy/apply them.");
  lines.push("");
  lines.push("## Session-Derived Allowed Context");
  lines.push("");
  if (result.sessionAllowed.length) result.sessionAllowed.forEach((item) => lines.push(`- ${item}`));
  else lines.push("- No repeated source files were strong enough to promote.");
  lines.push("");
  lines.push("## Session-Derived Blocked Context");
  lines.push("");
  if (result.sessionBlocked.length) result.sessionBlocked.forEach((item) => lines.push(`- ${item}`));
  else lines.push("- No generated/noisy paths were strong enough to add.");
  lines.push("");
  lines.push("## Next Session Prompt");
  lines.push("");
  lines.push("```text");
  lines.push(`Use .prismo/context-firewall.suggested.md as the starting context policy for this ${result.task} task.`);
  lines.push("Start from allowed context first. Do not read blocked paths unless you explain why they are required.");
  lines.push("If you need wider context, name the exact file and reason before reading.");
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

function runTimelineFirewallSuggestions(rootDir = process.cwd(), session = null, options = {}) {
  const ctx = createOptimizeContext(rootDir, options.scope || null);
  const task = options.task || options.scope || "timeline-followup";
  const scope = inferTaskScope(task, ctx);
  const suggestions = buildTimelineFirewallSuggestions(ctx, session, scope);
  const result = {
    root: ctx.root,
    task,
    scope,
    sessionId: session?.sessionId || null,
    allowed: suggestions.allowed,
    blocked: suggestions.blocked,
    sessionAllowed: suggestions.sessionAllowed,
    sessionBlocked: suggestions.sessionBlocked,
    generatedAt: new Date().toISOString(),
    generatedFiles: [
      ".prismo/timeline-firewall-suggestions.md",
      ".prismo/context-firewall.suggested.md",
      ".prismo/allowed-context.suggested.txt",
      ".prismo/blocked-context.suggested.txt",
    ],
  };

  if (!options.dryRun) {
    writeGeneratedFile(ctx.root, ".prismo/timeline-firewall-suggestions.md", renderTimelineFirewallSuggestions(result));
    writeGeneratedFile(ctx.root, ".prismo/context-firewall.suggested.md", renderFirewallPolicy(result));
    writeGeneratedFile(ctx.root, ".prismo/allowed-context.suggested.txt", renderLines("Allowed Context Suggestions", result.allowed));
    writeGeneratedFile(ctx.root, ".prismo/blocked-context.suggested.txt", renderLines("Blocked Context Suggestions", result.blocked));
  }
  result.dryRun = Boolean(options.dryRun);
  return result;
}

function renderFirewallTerminal(result) {
  const lines = [];
  lines.push("");
  lines.push("Prismo Context Firewall");
  lines.push("");
  lines.push(`Task: ${result.task}`);
  lines.push(`Scope: ${result.scope}`);
  lines.push("");
  lines.push(result.dryRun ? "Would write:" : "Wrote:");
  result.generatedFiles.forEach((file) => lines.push(`- ${file}`));
  lines.push("");
  lines.push("Allowed first:");
  result.allowed.slice(0, 10).forEach((item) => lines.push(`- ${item}`));
  if (result.allowed.length > 10) lines.push(`- ${result.allowed.length - 10} more`);
  lines.push("");
  lines.push("Blocked unless justified:");
  result.blocked.slice(0, 10).forEach((item) => lines.push(`- ${item}`));
  if (result.blocked.length > 10) lines.push(`- ${result.blocked.length - 10} more`);
  lines.push("");
  lines.push("Tell your agent:");
  lines.push("Follow .prismo/context-firewall.md before reading files.");
  lines.push("");
  return lines.join("\n");
}

  return {
    buildAllowedContext,
    buildBlockedContext,
    renderFirewallPolicy,
    renderFirewallPrompt,
    renderFirewallTerminal,
    renderTimelineFirewallSuggestions,
    runFirewall,
    runTimelineFirewallSuggestions,
  };
};
