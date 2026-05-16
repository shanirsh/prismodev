module.exports = function createContextOptimize(deps) {
  const {
    fs,
    path,
    NPX_COMMAND,
    scanRepo,
    safeReadJson,
    readIfText,
    formatBytes,
    color,
    writeGeneratedFile,
  } = deps;

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

  const pyprojectFiles = [...textFiles.keys()].filter((rel) => rel.endsWith("pyproject.toml") && !rel.includes("node_modules/"));
  for (const rel of pyprojectFiles) {
    const text = readIfText(path.join(root, rel)) || "";
    if (/fastapi/i.test(text)) frameworks.add("FastAPI");
    if (/django/i.test(text)) frameworks.add("Django");
    if (/flask/i.test(text)) frameworks.add("Flask");
    if (/sqlalchemy/i.test(text)) frameworks.add("SQLAlchemy");
    if (/psycopg|asyncpg/i.test(text)) frameworks.add("PostgreSQL");
    if (/redis/i.test(text)) frameworks.add("Redis");
    if (/celery/i.test(text)) frameworks.add("Celery");
    frameworks.add("Python");
  }

  if (pyprojectFiles.length && !frameworks.has("Python")) frameworks.add("Python");
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
    "manage.py",
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
  const found = candidates.filter((candidate) => paths.has(candidate));
  if (!found.length) {
    const pyMain = result.files.find((f) => /^[^/]+\/__main__\.py$/.test(f.path));
    if (pyMain) found.push(pyMain.path);
    const pyInit = result.files.find((f) => /^[^/]+\/__init__\.py$/.test(f.path) && !f.path.includes("test"));
    if (pyInit && !found.length) found.push(pyInit.path);
  }
  return found;
}

function isNonSourcePath(rel) {
  if (/\.(test|spec|e2e)\.[jt]sx?$/.test(rel)) return true;
  return /^(docs|docs_src|examples|samples|tutorials|tests|test|spec|__tests__|fixtures)\//i.test(rel) ||
    /\/(docs|docs_src|examples|samples|tutorials|tests|test|__tests__|fixtures)\//.test(rel);
}

function detectBackendPaths(result) {
  const api = findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (/(backend|app|src)\/.*(router|routes|api)\//.test(rel) || /(backend|app|src)\/.*(router|routes).*\.py$/.test(rel) || /\/(routing|routers?)\.py$/.test(rel)), 20).map((f) => f.path);
  const services = findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (/(backend|app|src)\/.*(service|services|application)/.test(rel) || /\/applications?\.py$/.test(rel)), 20).map((f) => f.path);
  const models = findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (/(backend|app|src)\/.*models\.py$/.test(rel) || /(backend|app|src)\/.*schema/.test(rel) || /\/models\.py$/.test(rel)), 20).map((f) => f.path);
  const db = findRepoFiles(result, (rel) => !isNonSourcePath(rel) && /(backend|app|src)\/.*\/(db|database|alembic|migrations)[/.]/.test(rel), 20).map((f) => f.path);
  const config = findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (/(backend|app|src)\/.*(config|settings|env).*\.py$/.test(rel) || rel.endsWith("requirements.txt") || rel === "pyproject.toml"), 20).map((f) => f.path);
  const auth = findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (/(backend|app|src)\/.*auth/.test(rel) || /\/security\.py$/.test(rel)), 20).map((f) => f.path);
  return { api, services, models, db, config, auth };
}

function detectFrontendPaths(result) {
  return {
    app: findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (/frontend\/src\/app\//.test(rel) || /src\/app\//.test(rel) || /apps\/[^/]+\/app\//.test(rel) || /apps\/[^/]+\/src\/app\//.test(rel)), 24).map((f) => f.path),
    components: findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (/frontend\/src\/components\//.test(rel) || /src\/components\//.test(rel) || /apps\/[^/]+\/.*components\//.test(rel) || /packages\/[^/]+\/.*components\//.test(rel)), 20).map((f) => f.path),
    apiClient: findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (/frontend\/src\/(lib|hooks)\/.*(api|client|query|finops)/.test(rel) || /src\/(lib|hooks)\/.*(api|client|query)/.test(rel)), 20).map((f) => f.path),
    styling: findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (/tailwind\.config|globals\.css|\.module\.css|frontend\/src\/app\/globals/.test(rel)), 20).map((f) => f.path),
    state: findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (/providers\.tsx|react-query|use[A-Z].*\.ts/.test(rel)), 20).map((f) => f.path),
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


function getOptimizePendingFiles(ctx) {
  const pending = [
    ["architecture-summary.md", renderArchitectureSummary(ctx)],
    ["recommended-CLAUDE.md", renderRecommendedClaude(ctx)],
    ["recommended-AGENTS.md", renderRecommendedAgents(ctx)],
    ["recommended-.claudeignore", `${ctx.scan.recommendedClaudeIgnore.join("\n")}\n`],
    ["recommended-.cursorignore", `${ctx.scan.recommendedCursorIgnore.join("\n")}\n`],
    ["recommended-.gitignore-additions", renderGitignoreAdditions(ctx)],
  ];
  if (ctx.backendDetected) pending.push(["backend-summary.md", renderBackendSummary(ctx)]);
  if (ctx.frontendDetected) pending.push(["frontend-summary.md", renderFrontendSummary(ctx)]);
  if (ctx.scope) pending.push([`${ctx.scope.toLowerCase()}-context.md`, renderScopedContext(ctx, ctx.scope)]);
  return pending;
}

function runOptimize(rootDir = process.cwd(), options = {}) {
  const ctx = createOptimizeContext(rootDir, options.scope || null);
  const generated = [];
  const pending = getOptimizePendingFiles(ctx);

  if (options.dryRun) {
    const generatedFiles = pending.map(([name]) => path.join(".prismo", name));
    generatedFiles.push(".prismo/optimize-report.md");
    return {
      root: ctx.root,
      scope: ctx.scope,
      frameworks: ctx.frameworks,
      generatedFiles,
      warnings: ctx.warnings,
      riskScore: ctx.scan.score,
      estimatedContextReduction: ctx.estimatedContextReduction,
      optimizationSuggestions: ctx.suggestions,
      starterPrompt: renderStarterPrompt(ctx, ctx.scope),
      generatedAt: ctx.generatedAt,
      dryRun: true,
    };
  }

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
  lines.push("Files are recommendations/templates only. No CLAUDE.md, AGENTS.md, .gitignore, .claudeignore, or .cursorignore files were overwritten.");
  return lines.join("\n");
}


  return {
    createOptimizeContext,
    detectFrameworks,
    getContextFileForScope,
    renderContextCommand,
    renderOptimizeTerminal,
    renderStarterPrompt,
    runOptimize,
  };
};
