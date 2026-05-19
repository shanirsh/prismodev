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
  const { execFileSync } = require("child_process");

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
    if (deps.vue || deps["@vue/runtime-core"]) frameworks.add("Vue");
    if (deps.svelte || deps["@sveltejs/kit"]) frameworks.add(deps["@sveltejs/kit"] ? "SvelteKit" : "Svelte");
    if (deps["solid-js"]) frameworks.add("Solid");
    if (deps.astro) frameworks.add("Astro");
    if (deps.nuxt) frameworks.add("Nuxt");
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
  const pythonFiles = [...textFiles.values()].filter((file) => file.path.endsWith(".py") && !isNonSourcePath(file.path)).slice(0, 80);
  for (const file of pythonFiles) {
    const text = readIfText(path.join(root, file.path), 128 * 1024) || "";
    if (/FastAPI\s*\(|from\s+fastapi\s+import|APIRouter\s*\(/.test(text)) frameworks.add("FastAPI");
    if (/from\s+django|import\s+django|DJANGO_SETTINGS_MODULE/.test(text)) frameworks.add("Django");
    if (/Flask\s*\(|from\s+flask\s+import/.test(text)) frameworks.add("Flask");
    if (/sqlalchemy|create_engine|SessionLocal/i.test(text)) frameworks.add("SQLAlchemy");
  }
  if (pythonFiles.length) frameworks.add("Python");
  if ([...textFiles.keys()].some((rel) => rel.endsWith("Cargo.toml"))) frameworks.add("Rust");
  if ([...textFiles.keys()].some((rel) => rel.endsWith("go.mod"))) frameworks.add("Go");
  if ([...textFiles.keys()].some((rel) => rel.endsWith("docker-compose.yml") || rel.endsWith("docker-compose.yaml"))) frameworks.add("Docker");
  if ([...textFiles.keys()].some((rel) => rel.includes("prisma/schema.prisma"))) frameworks.add("Prisma");
  if ([...textFiles.keys()].some((rel) => rel.includes("next.config."))) frameworks.add("Next.js");
  if ([...textFiles.keys()].some((rel) => rel.includes("vite.config."))) frameworks.add("Vite");
  if ([...textFiles.keys()].some((rel) => rel.includes("svelte.config."))) frameworks.add("SvelteKit");
  if ([...textFiles.keys()].some((rel) => rel.includes("astro.config."))) frameworks.add("Astro");
  if ([...textFiles.keys()].some((rel) => rel.includes("nuxt.config."))) frameworks.add("Nuxt");
  if ([...textFiles.keys()].some((rel) => rel.endsWith(".vue"))) frameworks.add("Vue");
  if ([...textFiles.keys()].some((rel) => rel.endsWith(".svelte"))) frameworks.add("Svelte");
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
    "src/App.vue",
    "src/App.svelte",
    "src/routes/+page.svelte",
    "src/pages/index.astro",
    "app.vue",
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
  const pythonText = (file) => readIfText(path.join(result.root, file.path), 256 * 1024) || "";
  const isRootPython = (rel) => /^[^/]+\.py$/.test(rel);
  const isPython = (rel) => rel.endsWith(".py");
  const hasFastApiSignal = (file) => /FastAPI\s*\(|APIRouter\s*\(|@app\.(get|post|put|patch|delete)|@router\.(get|post|put|patch|delete)/.test(pythonText(file));
  const api = findRepoFiles(result, (rel, file) => !isNonSourcePath(rel) && (
    /(backend|app|src)\/.*(router|routes|api)\//.test(rel) ||
    /(backend|app|src)\/.*(router|routes).*\.py$/.test(rel) ||
    /\/(routing|routers?)\.py$/.test(rel) ||
    (isRootPython(rel) && hasFastApiSignal(file))
  ), 30).map((f) => f.path);
  const services = findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (
    /(backend|app|src)\/.*(service|services|application)/.test(rel) ||
    /\/applications?\.py$/.test(rel) ||
    (isRootPython(rel) && /(service|worker|manager|client|heartbeat|memory|chat|tool|orchestrator|pipeline)/i.test(rel))
  ), 40).map((f) => f.path);
  const models = findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (
    /(backend|app|src)\/.*models\.py$/.test(rel) ||
    /(backend|app|src)\/.*schema/.test(rel) ||
    /\/models\.py$/.test(rel) ||
    (isRootPython(rel) && /(model|schema|entity|types?)/i.test(rel))
  ), 30).map((f) => f.path);
  const db = findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (
    /(backend|app|src)\/.*\/(db|database|alembic|migrations)[/.]/.test(rel) ||
    (isPython(rel) && /(sqlite|qdrant|neo4j|database|storage|repository|vector|graph|migration)/i.test(rel))
  ), 30).map((f) => f.path);
  const config = findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (
    /(backend|app|src)\/.*(config|settings|env).*\.py$/.test(rel) ||
    (isRootPython(rel) && /(config|settings|env)/i.test(rel)) ||
    rel.endsWith("requirements.txt") ||
    rel === "pyproject.toml"
  ), 20).map((f) => f.path);
  const auth = findRepoFiles(result, (rel, file) => !isNonSourcePath(rel) && (
    /(backend|app|src)\/.*auth/.test(rel) ||
    /\/security\.py$/.test(rel) ||
    (isPython(rel) && /(auth|security|permission|token|session|oauth|jwt|middleware)/i.test(rel)) ||
    (isRootPython(rel) && /(Depends|HTTPBearer|OAuth2|JWT|Authorization)/.test(pythonText(file)))
  ), 30).map((f) => f.path);
  return { api, services, models, db, config, auth };
}

function detectFrontendPaths(result) {
  const appSurface = /(^|\/)(frontend\/)?src\/(app|pages|routes)\//;
  const appFile = /(^|\/)(frontend\/)?src\/(App|main|index)\.(jsx?|tsx?|vue|svelte)$/;
  const componentFile = /(^|\/)(frontend\/)?src\/(components|ui|widgets)\//;
  const apiFile = /(^|\/)(frontend\/)?src\/(lib|hooks|composables|stores|services|api)\/.*(api|client|query|fetch|request|finops)/;
  const stylingFile = /tailwind\.config|globals\.css|app\.css|\.module\.css|\.scss$|(^|\/)(frontend\/)?src\/styles?\//;
  const stateFile = /providers?\.(tsx?|jsx?)|react-query|use[A-Z].*\.(ts|tsx|js|jsx)|(^|\/)(stores?|state|pinia|zustand|redux)\//;
  return {
    app: findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (appSurface.test(rel) || appFile.test(rel) || /(^|\/)app\.vue$/.test(rel) || /apps\/[^/]+\/(app|pages|routes|src\/app|src\/pages|src\/routes)\//.test(rel)), 24).map((f) => f.path),
    components: findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (componentFile.test(rel) || /apps\/[^/]+\/.*(components|ui|widgets)\//.test(rel) || /packages\/[^/]+\/.*(components|ui|widgets)\//.test(rel)), 24).map((f) => f.path),
    apiClient: findRepoFiles(result, (rel) => !isNonSourcePath(rel) && (apiFile.test(rel) || /apps\/[^/]+\/.*(lib|hooks|composables|services|api)\/.*(api|client|query|fetch|request)/.test(rel)), 24).map((f) => f.path),
    styling: findRepoFiles(result, (rel) => !isNonSourcePath(rel) && stylingFile.test(rel), 24).map((f) => f.path),
    state: findRepoFiles(result, (rel) => !isNonSourcePath(rel) && stateFile.test(rel), 24).map((f) => f.path),
  };
}

function createOptimizeContext(rootDir = process.cwd(), scope = null) {
  const scan = scanRepo(rootDir);
  const root = scan.root;
  const frameworks = detectFrameworks(root, scan);
  const folders = topLevelDirectories(root);
  const entrypoints = detectEntrypoints(scan);
  const backend = detectBackendPaths(scan);
  const frontend = detectFrontendPaths(scan);
  const backendDetected = folders.includes("backend") ||
    frameworks.some((name) => ["FastAPI", "Django", "Flask"].includes(name)) ||
    Boolean(backend.api.length || backend.services.length || backend.db.length || backend.auth.length);
  const frontendDetected = folders.includes("frontend") ||
    frameworks.some((name) => ["Next.js", "React", "Vite", "Vue", "Svelte", "SvelteKit", "Solid", "Astro", "Nuxt"].includes(name)) ||
    Boolean(frontend.app.length || frontend.components.length || frontend.apiClient.length || frontend.state.length);
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
    gitActivity: getGitActivity(root),
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

function moduleNameForPath(rel) {
  return rel
    .replace(/\.[^.]+$/, "")
    .replace(/\/__init__$/, "")
    .replace(/\/index$/, "")
    .replace(/\//g, ".");
}

function basenameStem(rel) {
  return path.basename(rel).replace(/\.[^.]+$/, "");
}

function extractPythonImports(text) {
  const imports = new Set();
  const importRe = /^\s*import\s+([a-zA-Z0-9_.,\s]+)/gm;
  const fromRe = /^\s*from\s+([a-zA-Z0-9_.]+)\s+import\s+/gm;
  let match;
  while ((match = importRe.exec(text))) {
    match[1].split(",").map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach((name) => imports.add(name));
  }
  while ((match = fromRe.exec(text))) imports.add(match[1]);
  return imports;
}

function resolveJsImport(fromRel, specifier, sourcePaths) {
  if (!specifier.startsWith(".")) return null;
  const fromDir = path.posix.dirname(fromRel);
  const base = path.posix.normalize(path.posix.join(fromDir, specifier));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
  return candidates.find((candidate) => sourcePaths.has(candidate)) || null;
}

function extractJsImports(fromRel, text, sourcePaths) {
  const imports = new Set();
  const importRe = /\bfrom\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = importRe.exec(text))) {
    const specifier = match[1] || match[2] || match[3];
    const resolved = resolveJsImport(fromRel, specifier, sourcePaths);
    if (resolved) imports.add(resolved);
  }
  return imports;
}

function getGitActivity(root) {
  const activity = new Map();
  try {
    const output = execFileSync("git", ["-C", root, "log", "--since=180 days ago", "--name-only", "--format=%ct"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let currentTs = 0;
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^\d{9,}$/.test(line)) {
        currentTs = Number(line);
        continue;
      }
      const rel = line.replace(/\\/g, "/");
      const previous = activity.get(rel) || { touches: 0, lastTouched: 0 };
      previous.touches += 1;
      previous.lastTouched = Math.max(previous.lastTouched, currentTs);
      activity.set(rel, previous);
    }
  } catch {
    return activity;
  }
  return activity;
}

function formatGitActivity(activity) {
  if (!activity || !activity.touches) return "no recent git touches";
  const date = activity.lastTouched ? new Date(activity.lastTouched * 1000).toISOString().slice(0, 10) : "unknown date";
  return `${activity.touches} recent git touch${activity.touches === 1 ? "" : "es"}, last ${date}`;
}

function topLoadBearing(root, files, allFiles, gitActivity, limit = 8) {
  const textFiles = (allFiles || []).filter((file) => !file.ignored && file.kind !== "binary" && /\.(py|tsx?|jsx?|mjs|cjs|vue|svelte)$/.test(file.path));
  const sourcePaths = new Set(textFiles.map((file) => file.path));
  const pythonModuleToPath = new Map();
  for (const file of textFiles.filter((candidate) => candidate.path.endsWith(".py"))) {
    pythonModuleToPath.set(moduleNameForPath(file.path), file.path);
    pythonModuleToPath.set(basenameStem(file.path), file.path);
  }

  const importRefs = new Map();
  const textRefs = new Map();
  const corpus = textFiles.map((file) => {
    const text = readIfText(path.join(root, file.path), 512 * 1024) || "";
    if (file.path.endsWith(".py")) {
      for (const imported of extractPythonImports(text)) {
        const target = pythonModuleToPath.get(imported) || pythonModuleToPath.get(imported.split(".").pop());
        if (target && target !== file.path) importRefs.set(target, (importRefs.get(target) || 0) + 1);
      }
    } else if (/\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/.test(file.path)) {
      for (const target of extractJsImports(file.path, text, sourcePaths)) {
        if (target !== file.path) importRefs.set(target, (importRefs.get(target) || 0) + 1);
      }
    }
    return `${file.path}\n${text}`;
  });

  for (const file of files || []) {
    const base = basenameStem(file.path);
    const importName = base.replace(/[-.]/g, "_");
    const refs = corpus.reduce((sum, text) => sum + (text.includes(base) || text.includes(importName) ? 1 : 0), 0);
    textRefs.set(file.path, refs);
  }

  return [...(files || [])]
    .filter((file) => !file.ignored && file.kind !== "binary")
    .map((file) => {
      const imports = importRefs.get(file.path) || 0;
      const refs = textRefs.get(file.path) || 0;
      const git = gitActivity.get(file.path) || { touches: 0, lastTouched: 0 };
      const score = imports * 1000 + refs * 25 + Math.min(git.touches, 20) * 10 + Math.log10(file.size + 1);
      return { file, imports, refs, git, score };
    })
    .sort((a, b) => b.score - a.score || b.file.size - a.file.size)
    .slice(0, limit)
    .map(({ file, imports, refs, git }) => `${file.path} (${imports} import ref${imports === 1 ? "" : "s"}, ${refs} text reference signal${refs === 1 ? "" : "s"}, ${formatGitActivity(git)}, ${formatBytes(file.size)})`);
}

function inferGaps(ctx) {
  const gaps = [];
  if (ctx.backendDetected && !ctx.backend.api.length) {
    gaps.push("No conventional backend API layout detected; review root-level Python files or custom service modules for FastAPI/APIRouter usage.");
  }
  if (ctx.backendDetected && !ctx.backend.services.length) {
    gaps.push("No conventional service directory detected; backend services may use flat files or project-specific naming.");
  }
  if (ctx.frontendDetected && !ctx.frontend.app.length) {
    gaps.push("No conventional frontend routing surface detected; Vite/React routes may live in App.tsx or custom tab components.");
  }
  return gaps;
}

function summarizeRiskyDirectories(dirs) {
  const groups = new Map();
  for (const dir of dirs || []) {
    const normalized = dir.path.replace(/\\/g, "/");
    const parts = normalized.split("/");
    let key = `${normalized}/`;
    if (parts.includes("__pycache__")) {
      const before = parts.slice(0, parts.indexOf("__pycache__"));
      const prefix = before.length ? `${before[0]}/**` : "**";
      key = `${prefix}/__pycache__/`;
    } else if (parts.includes("node_modules")) {
      key = `${parts.slice(0, parts.indexOf("node_modules") + 1).join("/")}/**`;
    } else if (parts.length > 2) {
      key = `${parts.slice(0, 2).join("/")}/**/${parts[parts.length - 1]}/`;
    }
    const existing = groups.get(key) || { key, count: 0, exposed: 0, ignored: 0, examples: [] };
    existing.count += 1;
    if (dir.exposed) existing.exposed += 1;
    else existing.ignored += 1;
    if (existing.examples.length < 2) existing.examples.push(`${normalized}/`);
    groups.set(key, existing);
  }
  return Array.from(groups.values())
    .sort((a, b) => b.exposed - a.exposed || b.count - a.count)
    .slice(0, 25)
    .map((group) => {
      const state = group.exposed ? `${group.exposed} exposed` : `${group.ignored} ignored`;
      const example = group.examples[0] && group.examples[0] !== group.key ? `; e.g. ${group.examples[0]}` : "";
      return `${group.key} (${group.count} director${group.count === 1 ? "y" : "ies"}, ${state}${example})`;
    });
}

function proseList(items, empty = "none detected") {
  return items && items.length ? items.join(", ") : empty;
}

function renderArchitectureSummary(ctx) {
  const apiLayer = ctx.backend.api.slice(0, 6);
  const dbLayer = ctx.backend.db.slice(0, 6);
  const frontendLayer = ctx.frontend.app.slice(0, 6);
  const gaps = inferGaps(ctx);
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
    "## Detection Gaps",
    "",
    gaps.length ? gaps.map((gap) => `- ${gap}`).join("\n") : "- No major architecture-detection gaps surfaced.",
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
  const backendCandidates = topLoadBearing(ctx.root, ctx.scan.files.filter((file) => file.path.endsWith(".py") && !isNonSourcePath(file.path)), ctx.scan.files, ctx.gitActivity, 8);
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
    "## Load-Bearing Candidates",
    "",
    mdList(backendCandidates, "No Python source candidates detected."),
    "",
    "## Detection Notes",
    "",
    ctx.backend.api.length || ctx.backend.services.length
      ? "- Backend paths were inferred from conventional directories plus root-level Python/FastAPI/service filename signals."
      : "- No conventional backend paths were detected; inspect root-level Python modules and custom service naming manually.",
    "",
  ].join("\n");
}

function renderFrontendSummary(ctx) {
  const frontendCandidates = topLoadBearing(ctx.root, ctx.scan.files.filter((file) => /\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/.test(file.path) && /(^|\/)(frontend|src|app|pages|routes|components|ui|hooks|composables|stores)\//.test(file.path)), ctx.scan.files, ctx.gitActivity, 8);
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
    "## Load-Bearing Candidates",
    "",
    mdList(frontendCandidates, "No frontend source candidates detected."),
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
    "# CLAUDE.md Boilerplate",
    "",
    "Do not overwrite an existing curated CLAUDE.md with this file. Use it as a diff/reference for missing compact-context guidance only.",
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
    "# AGENTS.md Boilerplate",
    "",
    "Do not overwrite an existing curated AGENTS.md with this file. Use it as a diff/reference for missing compact-context guidance only.",
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
    mdList(summarizeRiskyDirectories(ctx.scan.highRiskDirs)),
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
    ["recommended-CLAUDE.boilerplate.md", renderRecommendedClaude(ctx)],
    ["recommended-AGENTS.boilerplate.md", renderRecommendedAgents(ctx)],
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
