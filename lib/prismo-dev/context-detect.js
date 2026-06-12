module.exports = function createContextDetect(deps) {
  const { fs, path, safeReadJson, readIfText, formatBytes } = deps;
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
  const textFiles = (allFiles || []).filter((file) =>
    !file.ignored &&
    file.kind !== "binary" &&
    !file.path.replace(/\\/g, "/").startsWith(".prismo/") &&
    /\.(py|tsx?|jsx?|mjs|cjs|vue|svelte)$/.test(file.path)
  );
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

  return {
    detectBackendPaths,
    detectEntrypoints,
    detectFrameworks,
    detectFrontendPaths,
    getGitActivity,
    hasPath,
    isNonSourcePath,
    topLevelDirectories,
    topLoadBearing,
  };
};
