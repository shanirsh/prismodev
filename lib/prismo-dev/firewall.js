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
    "**/*.log",
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
    runFirewall,
  };
};
