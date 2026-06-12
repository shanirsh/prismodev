const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");

const { applyFixes, getUsageSummary, scanRepo, toJsonPayload, writeReport } = require("../lib/prismo-dev-scan");

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prismo-dev-scan-"));
}

test("optimize generates AI-readable context files in .prismo", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "frontend", "src", "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "backend", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "frontend", "package.json"), JSON.stringify({
    dependencies: { next: "14.0.0", react: "18.0.0" },
    devDependencies: { typescript: "5.0.0", tailwindcss: "3.0.0" },
  }), "utf8");
  fs.writeFileSync(path.join(root, "backend", "requirements.txt"), "fastapi\nsqlalchemy\nredis\n", "utf8");
  fs.writeFileSync(path.join(root, "backend", "app", "main.py"), "from fastapi import FastAPI\n", "utf8");
  fs.writeFileSync(path.join(root, "frontend", "src", "app", "page.tsx"), "export default function Page() { return null }\n", "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Prismo Optimize"));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "architecture-summary.md")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "backend-summary.md")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "frontend-summary.md")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "recommended-CLAUDE.boilerplate.md")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "recommended-AGENTS.boilerplate.md")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "recommended-.claudeignore")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "recommended-.cursorignore")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "recommended-.gitignore-additions")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "optimize-report.md")));
  assert.ok(fs.readFileSync(path.join(root, ".prismo", "recommended-CLAUDE.boilerplate.md"), "utf8").includes("Do not overwrite an existing curated CLAUDE.md"));
});

test("optimize does not back up unchanged reports on repeated runs", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "frontend", "src", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "frontend", "package.json"), JSON.stringify({
    dependencies: { next: "14.0.0", react: "18.0.0" },
  }), "utf8");
  fs.writeFileSync(path.join(root, "frontend", "src", "app", "page.tsx"), "export default function Page() { return null }\n", "utf8");

  const first = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", root],
    { encoding: "utf8" }
  );
  assert.equal(first.status, 0, first.stderr);

  const second = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", root],
    { encoding: "utf8" }
  );
  assert.equal(second.status, 0, second.stderr);

  const backups = fs.readdirSync(path.join(root, ".prismo")).filter((name) => name.endsWith(".bak"));
  assert.deepEqual(backups, []);
});

test("optimize ignores generated context when counting text references", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "backend", "app", "modules", "chat", "application", "pipeline"), { recursive: true });
  fs.mkdirSync(path.join(root, ".prismo"), { recursive: true });
  fs.writeFileSync(path.join(root, "backend", "requirements.txt"), "fastapi\nsqlalchemy\n", "utf8");
  fs.writeFileSync(path.join(root, "backend", "app", "main.py"), "from fastapi import FastAPI\nfrom app.modules.chat.application.pipeline import base\n", "utf8");
  fs.writeFileSync(path.join(root, "backend", "app", "modules", "chat", "application", "pipeline", "base.py"), "class PipelineBase: pass\n", "utf8");
  fs.writeFileSync(path.join(root, ".prismo", "backend-context.ts"), [
    "backend/app/modules/chat/application/pipeline/base.py",
    "base PipelineBase base PipelineBase",
    "",
  ].join("\n"), "utf8");

  const first = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", root],
    { encoding: "utf8" }
  );
  assert.equal(first.status, 0, first.stderr);
  const backendSummary = fs.readFileSync(path.join(root, ".prismo", "backend-summary.md"), "utf8");
  assert.match(backendSummary, /base\.py \([^)]*2 text reference signals/);

  const second = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", root],
    { encoding: "utf8" }
  );
  assert.equal(second.status, 0, second.stderr);

  const backups = fs.readdirSync(path.join(root, ".prismo")).filter((name) => name.endsWith(".bak"));
  assert.deepEqual(backups, []);
});

test("optimize report metadata changes do not create backups", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "frontend", "src", "components"), { recursive: true });
  fs.writeFileSync(path.join(root, "frontend", "package.json"), JSON.stringify({
    dependencies: { next: "14.0.0", react: "18.0.0" },
  }), "utf8");
  fs.writeFileSync(path.join(root, "frontend", "src", "components", "Button.tsx"), "export function Button() { return null }\n", "utf8");

  const scoped = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", "frontend", root],
    { encoding: "utf8" }
  );
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.ok(fs.readFileSync(path.join(root, ".prismo", "optimize-report.md"), "utf8").includes(".prismo/frontend-context.md"));

  const unscoped = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", root],
    { encoding: "utf8" }
  );
  assert.equal(unscoped.status, 0, unscoped.stderr);
  const report = fs.readFileSync(path.join(root, ".prismo", "optimize-report.md"), "utf8");
  assert.equal(report.includes(".prismo/frontend-context.md"), false);

  const backups = fs.readdirSync(path.join(root, ".prismo")).filter((name) => name.endsWith(".bak"));
  assert.deepEqual(backups, []);
});

test("optimize scoped frontend command generates frontend-context.md", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "frontend", "src", "components"), { recursive: true });
  fs.writeFileSync(path.join(root, "frontend", "package.json"), JSON.stringify({ dependencies: { react: "18.0.0" } }), "utf8");
  fs.writeFileSync(path.join(root, "frontend", "src", "components", "Button.tsx"), "export function Button() { return null }\n", "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", "frontend", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(root, ".prismo", "frontend-context.md")));
  assert.ok(fs.readFileSync(path.join(root, ".prismo", "frontend-context.md"), "utf8").includes("Button.tsx"));
});

test("optimize detects flat FastAPI Python layouts and collapses noisy directories", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "main.py"), "from fastapi import FastAPI\nfrom chat_service import router\napp = FastAPI()\n", "utf8");
  fs.writeFileSync(path.join(root, "chat_service.py"), "from fastapi import APIRouter\nfrom auth_middleware import require_user\nrouter = APIRouter()\n", "utf8");
  fs.writeFileSync(path.join(root, "memory_service.py"), "class MemoryService: pass\n", "utf8");
  fs.writeFileSync(path.join(root, "auth_middleware.py"), "Authorization = 'header'\ndef require_user(): return True\n", "utf8");
  fs.writeFileSync(path.join(root, "qdrant_store.py"), "class QdrantStore: pass\n", "utf8");
  fs.mkdirSync(path.join(root, "frontend", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "frontend", "package.json"), JSON.stringify({ dependencies: { react: "18.0.0", vite: "5.0.0" }, devDependencies: { typescript: "5.0.0" } }), "utf8");
  fs.writeFileSync(path.join(root, "frontend", "src", "App.tsx"), "export default function App() { return null }\n", "utf8");
  fs.mkdirSync(path.join(root, "temp_pipecat", "transformers", "models", "a", "__pycache__"), { recursive: true });
  fs.mkdirSync(path.join(root, "temp_pipecat", "transformers", "models", "b", "__pycache__"), { recursive: true });

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const backend = fs.readFileSync(path.join(root, ".prismo", "backend-summary.md"), "utf8");
  const frontend = fs.readFileSync(path.join(root, ".prismo", "frontend-summary.md"), "utf8");
  const architecture = fs.readFileSync(path.join(root, ".prismo", "architecture-summary.md"), "utf8");
  const report = fs.readFileSync(path.join(root, ".prismo", "optimize-report.md"), "utf8");
  assert.ok(backend.includes("chat_service.py"));
  assert.ok(backend.includes("memory_service.py"));
  assert.ok(backend.includes("auth_middleware.py"));
  assert.ok(backend.includes("qdrant_store.py"));
  assert.ok(frontend.includes("frontend/src/App.tsx"));
  assert.ok(backend.includes("import ref"));
  assert.ok(backend.includes("text reference signal"));
  assert.ok(architecture.includes("FastAPI"));
  assert.ok(architecture.includes("Detection Gaps"));
  assert.ok(report.includes("temp_pipecat/**/__pycache__/"));
  assert.equal((report.match(/__pycache__/g) || []).length < 5, true);
});

test("optimize detects SvelteKit and non-React frontend layouts", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    dependencies: { "@sveltejs/kit": "2.0.0", svelte: "5.0.0" },
    devDependencies: { vite: "5.0.0", typescript: "5.0.0" },
  }), "utf8");
  fs.writeFileSync(path.join(root, "svelte.config.js"), "export default {}\n", "utf8");
  fs.mkdirSync(path.join(root, "src", "routes"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "lib", "components"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "routes", "+page.svelte"), "<script>import Widget from '$lib/components/Widget.svelte';</script><Widget />\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "lib", "components", "Widget.svelte"), "<h1>Widget</h1>\n", "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const architecture = fs.readFileSync(path.join(root, ".prismo", "architecture-summary.md"), "utf8");
  const frontend = fs.readFileSync(path.join(root, ".prismo", "frontend-summary.md"), "utf8");
  assert.ok(architecture.includes("SvelteKit"));
  assert.ok(frontend.includes("src/routes/+page.svelte"));
  assert.ok(frontend.includes("Widget.svelte"));
});

test("optimize --json outputs valid JSON only", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { express: "4.0.0" } }), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", "--json", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.frameworks.includes("Express"));
  assert.ok(payload.generatedFiles.includes(".prismo/architecture-summary.md"));
  assert.ok(Array.isArray(payload.optimizationSuggestions));
  assert.ok(payload.starterPrompt.includes(".prismo/architecture-summary.md"));
  assert.equal(result.stdout.trim().startsWith("{"), true);
});

test("context command prints copy-pasteable prompt", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "frontend", "src", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "frontend", "package.json"), JSON.stringify({ dependencies: { next: "14.0.0", react: "18.0.0" } }), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "context", "frontend", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Prismo Frontend Context Prompt"));
  assert.ok(result.stdout.includes(".prismo/frontend-context.md"));
  assert.ok(result.stdout.includes("Copy/Paste Task Wrapper"));
});

test("context --json outputs prompt metadata", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { express: "4.0.0" } }), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "context", "--json", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.contextFile, ".prismo/architecture-summary.md");
  assert.ok(payload.prompt.includes("Use Prismo's compact repo context"));
  assert.equal(result.stdout.trim().startsWith("{"), true);
});

test("optimize accepts arbitrary scope names for context packs", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "backend", "app", "modules", "billing"), { recursive: true });
  fs.writeFileSync(path.join(root, "backend", "app", "modules", "billing", "router.py"), "def billing(): pass\n", "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "optimize", "billing", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const contextPath = path.join(root, ".prismo", "billing-context.md");
  assert.ok(fs.existsSync(contextPath));
  assert.ok(fs.readFileSync(contextPath, "utf8").includes("billing/router.py"));
});
