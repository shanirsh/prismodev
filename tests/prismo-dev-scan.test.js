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

test("flags oversized CLAUDE.md, missing .claudeignore, bloat dirs, and large files", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n", "utf8");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "Use concise instructions.\n".repeat(500), "utf8");
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "large.json"), `{ "data": "${"x".repeat(600 * 1024)}" }`, "utf8");

  const result = scanRepo(root);

  assert.equal(result.hasClaudeIgnore, false);
  assert.ok(result.score < 100);
  assert.ok(result.issues.some((issue) => issue.title.includes("CLAUDE.md")));
  assert.ok(result.issues.some((issue) => issue.title.includes(".claudeignore")));
  assert.ok(result.issues.every((issue) => issue.severity && issue.category && issue.description && issue.recommendation));
  assert.ok(result.exposedHighRiskDirs.some((dir) => dir.path === "node_modules"));
  assert.ok(result.exposedLargeFiles.some((file) => file.path === "large.json"));
});

test("fix mode creates .claudeignore and report without overwriting existing report silently", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Keep changes small.\n", "utf8");
  fs.mkdirSync(path.join(root, ".prismo"), { recursive: true });
  fs.writeFileSync(path.join(root, ".prismo", "prismo-dev-report.md"), "old report", "utf8");

  const result = scanRepo(root);
  const actions = applyFixes(result);

  assert.ok(fs.existsSync(path.join(root, ".claudeignore")));
  assert.ok(fs.existsSync(path.join(root, ".cursorignore")));
  assert.ok(fs.readFileSync(path.join(root, ".claudeignore"), "utf8").includes("node_modules/"));
  assert.ok(fs.readFileSync(path.join(root, ".cursorignore"), "utf8").includes("node_modules/"));
  assert.ok(fs.readFileSync(path.join(root, ".cursorignore"), "utf8").includes(".prismo/"));
  assert.ok(fs.readFileSync(path.join(root, ".prismo", "prismo-dev-report.md"), "utf8").includes("PrismoDev Report"));
  assert.ok(actions.some((action) => action.includes("Backed up existing report")));
  assert.ok(fs.readdirSync(path.join(root, ".prismo")).some((name) => name.startsWith("prismo-dev-report.md.") && name.endsWith(".bak")));
});

test("existing .claudeignore creates .claudeignore.prismo-suggested instead of overwriting", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, ".claudeignore"), "custom-entry/\n", "utf8");
  fs.writeFileSync(path.join(root, ".cursorignore"), "cursor-custom/\n", "utf8");
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n", "utf8");

  const result = scanRepo(root);
  const actions = applyFixes(result);

  assert.equal(fs.readFileSync(path.join(root, ".claudeignore"), "utf8"), "custom-entry/\n");
  assert.equal(fs.readFileSync(path.join(root, ".cursorignore"), "utf8"), "cursor-custom/\n");
  assert.ok(fs.existsSync(path.join(root, ".claudeignore.prismo-suggested")));
  assert.ok(fs.existsSync(path.join(root, ".cursorignore.prismo-suggested")));
  assert.ok(fs.readFileSync(path.join(root, ".claudeignore.prismo-suggested"), "utf8").includes("dist/"));
  assert.ok(fs.readFileSync(path.join(root, ".cursorignore.prismo-suggested"), "utf8").includes("dist/"));
  assert.ok(actions.some((action) => action.includes(".claudeignore.prismo-suggested")));
  assert.ok(actions.some((action) => action.includes(".cursorignore.prismo-suggested")));
});

test("superset ignores skip suggested files and state/secrets are recommended", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, ".claudeignore"), [
    "node_modules/",
    ".next/",
    "dist/",
    "build/",
    "coverage/",
    ".turbo/",
    ".venv/",
    "venv/",
    "__pycache__/",
    "pycache/",
    ".pytest_cache/",
    ".cache/",
    "logs/",
    "*.log",
    "*.lock",
    "*.tmp",
    "*.min.js",
    "*.min.css",
    "coverage-final.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "test-results/",
    "playwright-report/",
    "events/",
    "event-dumps/",
    "session-dumps/",
    "source-streams/",
    "inbox-dumps/",
    "calendar-dumps/",
    "models/",
    "state-backups/",
    "backups/",
    "*.sqlite",
    "*.sqlite3",
    "*.db",
    "*_state.json",
    "*_tokens.json",
    "*_export.json",
    "*secret*.json",
    "*credential*.json",
    ".env",
    ".env.*",
  ].join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(root, ".cursorignore"), `${fs.readFileSync(path.join(root, ".claudeignore"), "utf8")}.prismo/\nprismo-optimized-CLAUDE.template.md\n`, "utf8");
  fs.writeFileSync(path.join(root, "heartbeat_state.json"), "{}", "utf8");
  fs.writeFileSync(path.join(root, "whoop_tokens.json"), "{}", "utf8");
  fs.writeFileSync(path.join(root, "data.sqlite"), "", "utf8");

  const result = scanRepo(root);
  assert.ok(result.recommendedClaudeIgnore.includes("*_state.json"));
  assert.ok(result.recommendedClaudeIgnore.includes("*_tokens.json"));
  assert.ok(result.recommendedClaudeIgnore.includes("*.sqlite"));
  assert.equal(result.missingClaudeIgnoreSuggestions.length, 0);
  assert.equal(result.missingCursorIgnoreSuggestions.length, 0);
  const actions = applyFixes(result);
  assert.equal(fs.existsSync(path.join(root, ".claudeignore.prismo-suggested")), false);
  assert.equal(fs.existsSync(path.join(root, ".cursorignore.prismo-suggested")), false);
  assert.ok(actions.some((action) => action.includes("already covers Prismo recommendations")));
});

test("source-stream dumps are detected as operational context noise", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "source-streams"), { recursive: true });
  const rows = Array.from({ length: 80 }, (_, index) => JSON.stringify({
    type: "calendar_event",
    timestamp: `2026-05-${String((index % 20) + 1).padStart(2, "0")}T12:00:00Z`,
    attendees: [`person${index}@example.com`, "team@example.com"],
    subject: `planning ${index}`,
    body: "mostly irrelevant event payload copied from an external source",
    issue: { repository: "example/repo", body: "long issue body" },
  })).join("\n");
  fs.writeFileSync(path.join(root, "source-streams", "calendar-events.jsonl"), rows.repeat(12), "utf8");

  const result = scanRepo(root);
  const payload = toJsonPayload(result);
  assert.equal(result.operationalNoise.level !== "Low", true);
  assert.ok(result.issues.some((issue) => issue.category === "operational_noise"));
  assert.ok(result.recommendedClaudeIgnore.includes("source-streams/"));
  assert.ok(result.recommendedClaudeIgnore.includes("source-streams/calendar-events.jsonl"));
  assert.ok(payload.operationalNoise.files.some((file) => file.path === "source-streams/calendar-events.jsonl"));
});

test("CLAUDE.md token estimate produces deterministic impact text and template", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "a".repeat(8000), "utf8");

  const result = scanRepo(root);
  const claude = result.instructionFiles.find((file) => file.path === "CLAUDE.md");
  applyFixes(result);

  assert.equal(claude.tokens, 2000);
  assert.ok(result.issues.some((issue) => issue.title.includes("CLAUDE.md") && issue.estimatedTokenImpact.includes("1,200")));
  assert.ok(result.issues.some((issue) => issue.title.includes("CLAUDE.md") && issue.estimatedTokenImpact.includes("~$0.14/session")));
  assert.ok(result.issues.some((issue) => issue.title.includes("CLAUDE.md") && issue.estimatedTokenImpact.includes("$4.32/month")));
  assert.ok(fs.existsSync(path.join(root, "prismo-optimized-CLAUDE.template.md")));
});

test("AGENTS.md and .codex config are detected as Codex findings", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, ".codex"));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Codex instructions.\n".repeat(200), "utf8");
  fs.writeFileSync(path.join(root, ".codex", "config.toml"), "[mcp_servers.one]\ncommand = \"x\"\n", "utf8");

  const result = scanRepo(root);
  applyFixes(result);

  assert.ok(result.instructionFiles.some((file) => file.path === "AGENTS.md"));
  assert.ok(result.codexConfig.files.some((file) => file.includes(".codex/config.toml")));
  assert.ok(result.issues.some((issue) => issue.category === "codex_config"));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "prismo-AGENTS-recommendations.md")));
});

test("writeReport generates markdown with Claude and Codex recommendations", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Do the task.\n", "utf8");
  const result = scanRepo(root);
  const { reportPath } = writeReport(result);
  const report = fs.readFileSync(reportPath, "utf8");

  assert.ok(report.includes("# PrismoDev Report"));
  assert.ok(report.includes("Executive Summary"));
  assert.ok(report.includes("Claude Code Findings"));
  assert.ok(report.includes("OpenAI/Codex Findings"));
  assert.ok(report.includes("Recommended .cursorignore"));
  assert.ok(report.includes("Disclaimer"));
});

test("--json prints valid JSON only with expected keys", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "Use concise instructions.\n".repeat(50), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--json", "--no-report", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.scannedPath, root);
  assert.equal(typeof payload.score, "number");
  assert.ok(Array.isArray(payload.issues));
  assert.ok(Array.isArray(payload.suggestedClaudeIgnore));
  assert.ok(payload.claudeFindings);
  assert.ok(payload.codexFindings);
  assert.ok(payload.agentReadiness);
  assert.ok(payload.optimizationStack);
  assert.ok(payload.toolOutputRisk);
  assert.ok(payload.proxyTrackingReadiness);
  assert.equal(result.stdout.trim().startsWith("{"), true);
});

test("scan --simple prints plain-English output and does not write a report", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "Use concise instructions.\n".repeat(50), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--simple", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("PrismoDev Simple Scan"));
  assert.ok(result.stdout.includes("Plain English:"));
  assert.ok(result.stdout.includes("does not need API keys"));
  assert.equal(fs.existsSync(path.join(root, ".prismo", "prismo-dev-report.md")), false);
});

test("demo command is safe for first-time users", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "demo"],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("PrismoDev"));
  assert.ok(result.stdout.includes("Try it on your repo"));
  assert.ok(result.stdout.includes("npx getprismo doctor"));
  assert.ok(result.stdout.includes("npx getprismo watch"));
  assert.ok(result.stdout.includes("npx getprismo cc timeline"));
});

test("scan reports coding-agent readiness, optimization stack, tool-output risk, and proxy tracking", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: "14.0.0" } }), "utf8");
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(root, ".rtk"), { recursive: true });
  fs.mkdirSync(path.join(root, "playwright-report"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "config.toml"), "[mcp_servers.files]\ncommand = \"x\"\n", "utf8");
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ mcpServers: { one: {}, two: {} }, hooks: { PreToolUse: [{ command: "echo ok" }] } }), "utf8");
  fs.writeFileSync(path.join(root, "playwright-report", "trace.json"), `{ "trace": "${"x".repeat(650 * 1024)}" }`, "utf8");

  const result = scanRepo(root);
  const payload = JSON.parse(JSON.stringify(toJsonPayload(result)));

  assert.equal(result.agentReadiness.claudeCode.detected, true);
  assert.equal(result.agentReadiness.codex.detected, true);
  assert.equal(result.optimizationStack.tools.rtk.detected, true);
  assert.equal(result.optimizationStack.claudeMcpServers, 2);
  assert.equal(result.toolOutputRisk.level !== "Low", true);
  assert.ok(result.issues.some((issue) => issue.title.includes("Tool output risk")));
  assert.equal(payload.proxyTrackingReadiness.exactApiTracking.available, true);
  assert.equal(payload.agentReadiness.codex.exactProxyTracking, "available-when-using-api-key-base-url-mode");
});

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

test("firewall generates scoped context policy files", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "backend", "app", "auth"), { recursive: true });
  fs.mkdirSync(path.join(root, "backend", "app", "routes"), { recursive: true });
  fs.mkdirSync(path.join(root, "coverage"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { express: "4.0.0" } }), "utf8");
  fs.writeFileSync(path.join(root, "backend", "app", "auth", "security.py"), "def auth(): pass\n", "utf8");
  fs.writeFileSync(path.join(root, "backend", "app", "routes", "users.py"), "def route(): pass\n", "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "firewall", "auth-bug", "--json", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.scope, "auth");
  assert.ok(payload.allowed.some((item) => item.includes("auth")));
  assert.ok(payload.blocked.includes("node_modules/**"));
  assert.ok(payload.generatedFiles.includes(".prismo/context-firewall.md"));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "context-firewall.md")));
  assert.ok(fs.readFileSync(path.join(root, ".prismo", "firewall-prompt.md"), "utf8").includes("Follow .prismo/context-firewall.md"));
});

test("usage command reads exact Codex token_count events from local JSONL", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "08");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "real.js"), "export const real = true;\n", "utf8");
  fs.writeFileSync(path.join(sessionDir, "rollout-test.jsonl"), [
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-08T10:00:00Z", payload: { type: "session_meta", id: "codex-test", cwd: root, model: "gpt-test" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-08T10:01:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 300, total_tokens: 1500 } } } }),
  ].join("\n"), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "usage", "codex", "--json", "--limit", "1", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sessions[0].tool, "codex");
  assert.equal(payload.sessions[0].displayTokens, 1100);
  assert.equal(payload.sessions[0].contextTokens, 1500);
  assert.equal(payload.sessions[0].exactAvailable, true);
  assert.equal(payload.sessions[0].confidence, "exact-local-log");
});

test("usage summary reads exact Claude Code message usage from local JSONL", () => {
  const root = tempRepo();
  const claudeHome = tempRepo();
  const safeProject = root.replace(/[\/\\:]/g, "-").replace(/^-/, "-");
  const projectDir = path.join(claudeHome, "projects", safeProject);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "claude-test.jsonl"), [
    JSON.stringify({ type: "user", timestamp: "2026-05-08T10:00:00Z", cwd: root, message: { role: "user", content: "hello" } }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-05-08T10:01:00Z",
      requestId: "req-1",
      message: {
        id: "msg-1",
        role: "assistant",
        model: "claude-test",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 40,
        },
        content: [{ type: "text", text: "done" }],
      },
    }),
  ].join("\n"), "utf8");

  const originalClaudeHome = process.env.PRISMO_CLAUDE_HOME;
  const originalCodexHome = process.env.PRISMO_CODEX_HOME;
  process.env.PRISMO_CLAUDE_HOME = claudeHome;
  process.env.PRISMO_CODEX_HOME = path.join(root, "none");
  try {
    const payload = getUsageSummary({ tool: "claude", cwd: root, limit: 1 });
    assert.equal(payload.sessions[0].tool, "claude-code");
    assert.equal(payload.sessions[0].exactTotalTokens, 100);
    assert.equal(payload.sessions[0].exactAvailable, true);
    assert.equal(payload.sessions[0].confidence, "exact-local-log");
  } finally {
    if (originalClaudeHome === undefined) delete process.env.PRISMO_CLAUDE_HOME;
    else process.env.PRISMO_CLAUDE_HOME = originalClaudeHome;
    if (originalCodexHome === undefined) delete process.env.PRISMO_CODEX_HOME;
    else process.env.PRISMO_CODEX_HOME = originalCodexHome;
  }
});

test("cc command reports Claude Code token costs and cache savings", () => {
  const root = tempRepo();
  const claudeHome = tempRepo();
  const safeProject = root.replace(/[\/\\:]/g, "-").replace(/^-/, "-");
  const projectDir = path.join(claudeHome, "projects", safeProject);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "claude-cost.jsonl"), [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-05-08T10:01:00Z",
      requestId: "req-1",
      message: {
        id: "msg-1",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        usage: {
          input_tokens: 50000,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 100000,
          output_tokens: 10000,
        },
        content: [{ type: "text", text: "done" }],
      },
    }),
  ].join("\n"), "utf8");

  const env = { ...process.env, PRISMO_CLAUDE_HOME: claudeHome, PRISMO_CODEX_HOME: path.join(root, "none") };
  const json = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "cc", "--json", root],
    { encoding: "utf8", env }
  );
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.sessions[0].cost.model, "Claude Sonnet 4");
  assert.equal(payload.totals.inputTokens, 50000);
  assert.equal(payload.totals.outputTokens, 10000);
  assert.equal(payload.totals.cacheCreationTokens, 5000);
  assert.equal(payload.totals.cacheReadTokens, 100000);
  assert.equal(Number(payload.totals.totalCost.toFixed(4)), 0.3488);
  assert.ok(payload.totals.cacheSavings > 0);
  assert.ok(payload.insights.estimatedAvoidableCost > 0);
  assert.ok(payload.insights.costDrivers.length > 0);
  assert.ok(payload.sessions[0].prismo.recommendations.some((rec) => rec.includes("optimize") || rec.includes("scan --usage")));

  const terminal = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "cc", "last", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.ok(terminal.stdout.includes("Prismo Claude Code Cost"));
  assert.ok(terminal.stdout.includes("Claude Sonnet 4"));
  assert.ok(terminal.stdout.includes("Cache saved you"));
  assert.ok(terminal.stdout.includes("Prismo Diagnosis"));
  assert.ok(terminal.stdout.includes("Better Next Actions"));

  const timeline = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "cc", "timeline", "--json", root],
    { encoding: "utf8", env }
  );
  assert.equal(timeline.status, 0, timeline.stderr);
  const timelinePayload = JSON.parse(timeline.stdout);
  assert.equal(timelinePayload.schemaVersion, 1);
  assert.equal(timelinePayload.command, "cc timeline");
  assert.equal(timelinePayload.session.model, "claude-sonnet-4-20250514");
  assert.ok(Array.isArray(timelinePayload.timeline));
});

test("usage terminal output and watch --once --json are script-friendly", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "08");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "rollout-test.jsonl"), [
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-08T10:00:00Z", payload: { type: "session_meta", cwd: root, model: "gpt-test" } }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-05-08T10:01:00Z",
      payload: { type: "response", role: "assistant", content: [{ type: "tool_use", name: "shell", input: "npm test" }] },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-05-08T10:02:00Z",
      payload: { type: "tool_result", content: (`failure in package-lock.json and dist/app.js after npm test\nsrc/real.js stayed relevant\n/Users/someone/other-repo/lib/noise.js should not count\nM /Users/someone/other-repo/lib/status-noise.js should not count\nmissing/local-file.js should not count\n`).repeat(30000) },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-05-08T10:03:00Z",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } } },
    }),
  ].join("\n"), "utf8");
  const env = { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none") };

  const terminal = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "usage", "codex", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.ok(terminal.stdout.includes("Prismo Usage"));
  assert.ok(terminal.stdout.includes("Exact local-log tokens"));

  const allUsage = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "usage", "all", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(allUsage.status, 0, allUsage.stderr);
  const allUsagePayload = JSON.parse(allUsage.stdout);
  assert.equal(allUsagePayload.scannedPath, root);
  assert.equal(allUsagePayload.sessions[0].tool, "codex");
  assert.equal(allUsagePayload.sessions[0].cwd, root);

  const watch = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(watch.status, 0, watch.stderr);
  const payload = JSON.parse(watch.stdout);
  assert.equal(payload.sessions[0].displayTokens, 150);
  assert.ok(payload.live);
  assert.equal(payload.live.activeSession.tool, "codex");
  assert.ok(["Medium", "High"].includes(payload.live.contextPressure));
  assert.ok(payload.live.warnings.some((warning) => warning.includes("Tool/output")));
  assert.ok(payload.live.warnings.some((warning) => warning.includes("package-lock.json")));
  assert.equal(payload.live.liveAction.cause, "tool-output-flood");
  assert.ok(payload.live.liveAction.now.length >= 2);
  assert.ok(payload.live.liveAction.rescueCommand.includes("watch --rescue"));
  assert.equal(payload.live.liveAction.shieldPlan.mcp.runTool, "prismo_shield_run");
  assert.equal(payload.live.liveAction.shieldPlan.mcp.searchTool, "prismo_shield_search");
  assert.ok(payload.live.liveAction.shieldPlan.command.includes("npx getprismo shield --"));
  assert.equal(payload.live.activeSession.actionableRepeatedPaths.some((item) => item.value.includes("other-repo")), false);
  assert.equal(payload.live.activeSession.actionableRepeatedPaths.some((item) => item.value.includes("missing/local-file.js")), false);
  assert.ok(payload.live.recommendedAction.includes("shield"));

  const watchTerminal = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(watchTerminal.status, 0, watchTerminal.stderr);
  assert.ok(watchTerminal.stdout.includes("Context Pressure"));
  assert.ok(watchTerminal.stdout.includes("Recent Growth"));
  assert.ok(watchTerminal.stdout.includes("Warnings"));
  assert.ok(watchTerminal.stdout.includes("Do This Now"));
  assert.ok(watchTerminal.stdout.includes("Shield Plan"));
  assert.ok(watchTerminal.stdout.includes("prismo_shield_run"));
  assert.ok(watchTerminal.stdout.includes("Cause:"));
  assert.ok(watchTerminal.stdout.includes("Suggested Action"));
  assert.equal(watchTerminal.stdout.includes("Refreshing every"), false);

  const rescue = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--rescue", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(rescue.status, 0, rescue.stderr);
  assert.ok(rescue.stdout.includes("Prismo Rescue Prompt"));
  assert.ok(rescue.stdout.includes("Paste this into the current AI coding session"));
  assert.ok(rescue.stdout.includes("Prismo shield"));
  assert.ok(rescue.stdout.includes("package-lock.json"));

  const rescueJson = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--rescue", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(rescueJson.status, 0, rescueJson.stderr);
  const rescuePayload = JSON.parse(rescueJson.stdout);
  assert.ok(rescuePayload.rescuePrompt.includes("Prismo Rescue Prompt"));

  const guardrails = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--guardrails", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(guardrails.status, 0, guardrails.stderr);
  const guardrailsPayload = JSON.parse(guardrails.stdout);
  assert.equal(guardrailsPayload.guardrailsPath, ".prismo/live-guardrails.md");
  assert.equal(guardrailsPayload.rescuePath, ".prismo/live-rescue-prompt.md");
  const guardrailsText = fs.readFileSync(path.join(root, ".prismo", "live-guardrails.md"), "utf8");
  const liveRescueText = fs.readFileSync(path.join(root, ".prismo", "live-rescue-prompt.md"), "utf8");
  assert.ok(guardrailsText.includes("Prismo Live Guardrails"));
  assert.ok(guardrailsText.includes("Effective Immediately"));
  assert.ok(guardrailsText.includes("Prismo shield"));
  assert.ok(liveRescueText.includes("Prismo Rescue Prompt"));

  const throttle = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--throttle", "--budget", "1", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(throttle.status, 0, throttle.stderr);
  const throttlePayload = JSON.parse(throttle.stdout);
  assert.equal(throttlePayload.throttlePath, ".prismo/live-context-throttle.md");
  assert.equal(throttlePayload.live.liveAction.cause, "token-budget-exceeded");
  assert.equal(throttlePayload.live.budget.budget, 1);
  const throttleText = fs.readFileSync(path.join(root, ".prismo", "live-context-throttle.md"), "utf8");
  assert.ok(throttleText.includes("Prismo Live Context Throttle"));
  assert.ok(throttleText.includes("hard-throttle"));

  const auto = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--auto", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(auto.status, 0, auto.stderr);
  const autoPayload = JSON.parse(auto.stdout);
  assert.equal(autoPayload.auto, true);
  assert.equal(autoPayload.guardrailsPath, ".prismo/live-guardrails.md");
  assert.equal(autoPayload.rescuePath, ".prismo/live-rescue-prompt.md");
  assert.equal(autoPayload.throttlePath, ".prismo/live-context-throttle.md");
  assert.equal(autoPayload.eventsPath, ".prismo/watch-events.jsonl");
  assert.equal(autoPayload.live.budget.budget, 600000);
  const eventsPath = path.join(root, ".prismo", "watch-events.jsonl");
  assert.ok(fs.existsSync(eventsPath));
  const watchEvent = JSON.parse(fs.readFileSync(eventsPath, "utf8").trim().split(/\r?\n/)[0]);
  assert.equal(watchEvent.schemaVersion, 1);
  assert.equal(watchEvent.cause, autoPayload.live.liveAction.cause);
  assert.equal(watchEvent.shieldPlan.mcp.runTool, "prismo_shield_run");
  assert.equal(autoPayload.firewallPath, ".prismo/context-firewall.md");
  assert.ok(fs.existsSync(path.join(root, ".prismo", "context-firewall.md")));

  fs.rmSync(path.join(root, ".prismo", "watch-events.jsonl"));
  const noEvents = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--auto", "--no-events", "--json", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(noEvents.status, 0, noEvents.stderr);
  const noEventsPayload = JSON.parse(noEvents.stdout);
  assert.equal(noEventsPayload.eventsPath, null);
  assert.equal(fs.existsSync(path.join(root, ".prismo", "watch-events.jsonl")), false);

  const watchReport = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "watch", "codex", "--once", "--report", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(watchReport.status, 0, watchReport.stderr);
  assert.ok(fs.existsSync(path.join(root, ".prismo", "watch-report.md")));
  assert.ok(fs.readFileSync(path.join(root, ".prismo", "watch-report.md"), "utf8").includes("Prismo Watch Report"));
});

test("scan --usage folds exact local session usage into diagnostics", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "08");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "rollout-test.jsonl"), JSON.stringify({
    type: "event_msg",
    timestamp: "2026-05-08T10:01:00Z",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1200000, output_tokens: 50000, total_tokens: 1250000 } } },
  }), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--usage", "--json", "--no-report", "--limit", "1", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.realUsage.totals.displayTokens, 1250000);
  assert.equal(payload.realUsage.confidence, "exact-local-log");
  assert.ok(payload.issues.some((issue) => issue.title.includes("Recent local AI sessions used")));
  assert.ok(payload.recommendations.some((rec) => rec.includes("real session usage")));
});

test("scan --usage turns session context leaks into ignore suggestions", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "21");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "logs", "debug.log"), "debug", "utf8");
  fs.writeFileSync(path.join(root, "dist", "app.js"), "bundle", "utf8");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}", "utf8");
  fs.writeFileSync(path.join(sessionDir, "leaks.jsonl"), [
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-21T10:00:00Z", payload: { type: "session_meta", cwd: root, model: "gpt-test" } }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-05-21T10:01:00Z",
      payload: {
        type: "tool_result",
        content: [
          "failure included package-lock.json",
          "logs/debug.log",
          "dist/app.js",
          "logs/debug.log",
          "dist/app.js",
        ].join("\n").repeat(20),
      },
    }),
  ].join("\n"), "utf8");

  const env = { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none") };
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--usage", "--json", "--no-report", "--limit", "1", root],
    { encoding: "utf8", env }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const patterns = payload.sessionIgnoreSuggestions.map((item) => item.pattern);
  assert.ok(patterns.includes("package-lock.json"));
  assert.ok(patterns.includes("logs/"));
  assert.ok(patterns.includes("dist/"));
  assert.ok(payload.suggestedClaudeIgnore.includes("logs/"));
  assert.ok(payload.suggestedClaudeIgnore.includes("dist/"));
  assert.ok(payload.issues.some((issue) => issue.title.includes("session-derived ignore")));

  const report = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--usage", "--limit", "1", root],
    { encoding: "utf8", env }
  );
  assert.equal(report.status, 0, report.stderr);
  const markdown = fs.readFileSync(path.join(root, ".prismo", "prismo-dev-report.md"), "utf8");
  assert.ok(markdown.includes("Session-Derived Ignore Suggestions"));
  assert.ok(markdown.includes("logs/"));
});

test("setup command reports detected tools and tracking modes without modifying config", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "18.0.0" } }), "utf8");
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "config.toml"), "[mcp_servers.files]\ncommand = \"x\"\n", "utf8");
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ command: "echo ok" }] } }), "utf8");
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "08");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "rollout-test.jsonl"), [
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-08T10:00:00Z", payload: { type: "session_meta", cwd: root } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-05-08T10:01:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 300, output_tokens: 80, total_tokens: 380 } } } }),
  ].join("\n"), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "setup", "--json", "--skip-proxy-check", "--limit", "1", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.detected.codex.detected, true);
  assert.equal(payload.detected.codex.localLogsFound, true);
  assert.equal(payload.detected.claudeCode.detected, true);
  assert.ok(payload.trackingModes.some((mode) => mode.id === "exact-api-proxy"));
  assert.ok(payload.recommendedCommands.some((command) => command.includes("watch")));
  assert.equal(fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8").includes("mcp_servers"), true);
});

test("command-specific help and demo mode are available", () => {
  const help = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--help"],
    { encoding: "utf8" }
  );
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes("PrismoDev"));
  assert.ok(help.stdout.includes("--usage reads local Codex/Claude Code logs"));

  const setupHelp = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "setup", "--help"],
    { encoding: "utf8" }
  );
  assert.equal(setupHelp.status, 0, setupHelp.stderr);
  assert.ok(setupHelp.stdout.includes("PrismoDev Setup"));
  assert.ok(setupHelp.stdout.includes("read-only"));

  const demo = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "demo"],
    { encoding: "utf8" }
  );
  assert.equal(demo.status, 0, demo.stderr);
  assert.ok(demo.stdout.includes("PrismoDev"));
  assert.ok(demo.stdout.includes("Try it on your repo"));
});

test("dev command runs guided scan, optimize, and prompt flow", () => {
  const root = tempRepo();
  const codexHome = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: "14.0.0", react: "18.0.0" } }), "utf8");
  fs.mkdirSync(path.join(root, "src", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app", "page.tsx"), "export default function Page() { return null }\n", "utf8");
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "08");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "rollout-test.jsonl"), JSON.stringify({
    type: "event_msg",
    timestamp: "2026-05-08T10:01:00Z",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 } } },
  }), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "dev", "--json", "--limit", "1", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.generatedFiles.includes(".prismo/architecture-summary.md"));
  assert.ok(payload.prompt.includes(".prismo/"));
  assert.equal(payload.realUsage.totals.displayTokens, 1200);
});

test("doctor command safely optimizes repo and reports before/after payoff", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: "14.0.0", react: "18.0.0" } }), "utf8");
  fs.mkdirSync(path.join(root, "src", "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app", "page.tsx"), "export default function Page() { return null }\n", "utf8");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "Use concise instructions.\n".repeat(300), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "doctor", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: path.join(root, "none"), PRISMO_CLAUDE_HOME: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("PrismoDev Doctor"));
  assert.ok(result.stdout.includes("Before:"));
  assert.ok(result.stdout.includes("After:"));
  assert.ok(result.stdout.includes("Estimated exposed context reduction"));
  assert.ok(result.stdout.includes("Recommended starting context"));
  assert.ok(result.stdout.includes("Next live session:"));
  assert.ok(result.stdout.includes("npx getprismo watch --auto"));
  assert.ok(result.stdout.includes("Follow .prismo/live-guardrails.md"));
  assert.ok(fs.existsSync(path.join(root, ".claudeignore")));
  assert.ok(fs.existsSync(path.join(root, ".cursorignore")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "prismo-dev-report.md")));
  assert.ok(fs.existsSync(path.join(root, "prismo-optimized-CLAUDE.template.md")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "architecture-summary.md")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "frontend-context.md")));
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8").includes("Use concise instructions."), true);
});

test("doctor --json outputs valid before/after payload only", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { express: "4.0.0" } }), "utf8");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "doctor", "--json", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: path.join(root, "none"), PRISMO_CLAUDE_HOME: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.scannedPath, root);
  assert.equal(typeof payload.before.score, "number");
  assert.equal(typeof payload.after.score, "number");
  assert.equal(typeof payload.scoreDelta, "number");
  assert.ok(Array.isArray(payload.fixActions));
  assert.ok(payload.generatedFiles.includes(".prismo/architecture-summary.md"));
  assert.ok(payload.contextCommand.includes("npx getprismo context"));
  assert.equal(result.stdout.trim().startsWith("{"), true);
});

test("doctor --dry-run does not write optimization files", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "18.0.0" } }), "utf8");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "doctor", "--dry-run", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: path.join(root, "none"), PRISMO_CLAUDE_HOME: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Mode: dry run"));
  assert.ok(result.stdout.includes("Would Fix"));
  assert.equal(fs.existsSync(path.join(root, ".claudeignore")), false);
  assert.equal(fs.existsSync(path.join(root, ".prismo", "architecture-summary.md")), false);
});

test("doctor supports ignores-only and no-context-pack polish flags", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "18.0.0" } }), "utf8");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });

  const ignoresOnly = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "doctor", "--apply-ignores-only", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: path.join(root, "none"), PRISMO_CLAUDE_HOME: path.join(root, "none") } }
  );

  assert.equal(ignoresOnly.status, 0, ignoresOnly.stderr);
  assert.ok(fs.existsSync(path.join(root, ".claudeignore")));
  assert.ok(fs.existsSync(path.join(root, ".cursorignore")));
  assert.equal(fs.existsSync(path.join(root, ".prismo", "prismo-dev-report.md")), false);
  assert.equal(fs.existsSync(path.join(root, ".prismo", "architecture-summary.md")), false);
  assert.ok(ignoresOnly.stdout.includes("Context pack generation skipped"));

  const noContextRoot = tempRepo();
  fs.writeFileSync(path.join(noContextRoot, "package.json"), JSON.stringify({ dependencies: { react: "18.0.0" } }), "utf8");
  const noContext = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "doctor", "--no-context-packs", "--json", noContextRoot],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: path.join(noContextRoot, "none"), PRISMO_CLAUDE_HOME: path.join(noContextRoot, "none") } }
  );
  assert.equal(noContext.status, 0, noContext.stderr);
  const payload = JSON.parse(noContext.stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.noContextPacks, true);
  assert.deepEqual(payload.generatedFiles, []);
});

test("doctor --apply-suggestions appends missing ignore rules with backups", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "18.0.0" } }), "utf8");
  fs.writeFileSync(path.join(root, ".claudeignore"), "custom-keep/\n", "utf8");
  fs.writeFileSync(path.join(root, ".cursorignore"), "cursor-keep/\n", "utf8");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "doctor", "--apply-suggestions", "--no-context-packs", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: path.join(root, "none"), PRISMO_CLAUDE_HOME: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Applied Suggestions"));
  assert.ok(result.stdout.includes("Backup written"));
  const claudeIgnore = fs.readFileSync(path.join(root, ".claudeignore"), "utf8");
  const cursorIgnore = fs.readFileSync(path.join(root, ".cursorignore"), "utf8");
  assert.ok(claudeIgnore.includes("custom-keep/"));
  assert.ok(claudeIgnore.includes("dist/"));
  assert.ok(claudeIgnore.includes("logs/"));
  assert.ok(cursorIgnore.includes("cursor-keep/"));
  assert.ok(cursorIgnore.includes("dist/"));
  assert.ok(fs.existsSync(path.join(root, ".claudeignore.prismo-backup")));
  assert.ok(fs.existsSync(path.join(root, ".cursorignore.prismo-backup")));
  assert.equal(fs.existsSync(path.join(root, ".claudeignore.prismo-suggested")), false);
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

test("scan --ci fails high-risk repos", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "large.json"), `{ "data": "${"x".repeat(700 * 1024)}" }`, "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", "--ci", "--no-report", root],
    { encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.ok(result.stdout.includes("Prismo CI"));
  assert.ok(result.stdout.includes("FAIL"));
});

test("init dry-run previews npm scripts without modifying package.json", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: {} }, null, 2), "utf8");

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "init", "--dry-run", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Mode: dry run"));
  assert.ok(result.stdout.includes("Would add npm scripts"));
  assert.equal(fs.existsSync(path.join(root, ".prismo", "README.md")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts["ai:doctor"], undefined);
});

test("shield stores full command output and returns compact summary", () => {
  const root = tempRepo();
  const script = [
    "console.log('line '.repeat(4000));",
    "console.error('ERROR: build failed at src/app.ts');",
  ].join("");
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "shield", "--json", root, "--", process.execPath, "-e", script],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.exitCode, 0);
  assert.ok(payload.output.estimatedTokens > 1000);
  assert.ok(payload.output.interestingLines.some((line) => line.includes("ERROR: build failed")));
  assert.ok(fs.existsSync(path.join(root, payload.stored.stdout)));
  assert.ok(fs.existsSync(path.join(root, payload.stored.stderr)));
  assert.ok(fs.existsSync(path.join(root, payload.stored.directory, "summary.json")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "shield", "index.jsonl")));
});

test("shield last and search retrieve indexed output", () => {
  const root = tempRepo();
  const script = [
    "console.log('AUTH_FAILURE payment session expected 200 received 401 '.repeat(200));",
    "console.error('ERROR: AUTH_FAILURE token expired in auth middleware');",
  ].join("");
  const run = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "shield", "--json", root, "--", process.execPath, "-e", script],
    { encoding: "utf8" }
  );
  assert.equal(run.status, 0, run.stderr);

  const last = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "shield", "last", "--json", root],
    { encoding: "utf8" }
  );
  assert.equal(last.status, 0, last.stderr);
  const lastPayload = JSON.parse(last.stdout);
  assert.equal(lastPayload.runs.length, 1);
  assert.ok(lastPayload.runs[0].command.includes(process.execPath));

  const search = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "shield", "search", "AUTH_FAILURE", "--json", root],
    { encoding: "utf8" }
  );
  assert.equal(search.status, 0, search.stderr);
  const searchPayload = JSON.parse(search.stdout);
  assert.ok(["sqlite-fts5", "jsonl-fallback"].includes(searchPayload.mode));
  assert.ok(searchPayload.results.some((item) => String(item.snippet).includes("AUTH_FAILURE")));
});

test("--version prints the package version", () => {
  const pkg = require("../package.json");
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "--version"],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), pkg.version);
});

test("mcp server initializes and lists Prismo tools", () => {
  const root = tempRepo();
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    "",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "mcp", root],
    { encoding: "utf8", input }
  );

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].result.serverInfo.name, "prismodev");
  const toolNames = lines[1].result.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("prismo_scan"));
  assert.ok(toolNames.includes("prismo_shield_search"));
  assert.ok(toolNames.includes("prismo_cc_timeline"));
});

test("mcp doctor validates tools and prints config", () => {
  const root = tempRepo();
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "mcp", "doctor", "--json", root],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.server.name, "prismodev");
  assert.equal(payload.tools.count, 9);
  assert.equal(payload.tools.hasShield, true);
  assert.equal(payload.smoke.scan.ok, true);
  assert.deepEqual(payload.config.mcpServers.prismodev.args.slice(0, 3), ["-y", "getprismo", "mcp"]);

  const terminal = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "mcp", "doctor", root],
    { encoding: "utf8" }
  );
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.ok(terminal.stdout.includes("Prismo MCP Doctor"));
  assert.ok(terminal.stdout.includes("Status: ready"));
  assert.ok(terminal.stdout.includes("\"getprismo\""));
});

test("missing scan path returns a clear error", () => {
  const missing = path.join(os.tmpdir(), "prismo-missing-path-for-test");
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "scan", missing],
    { encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("Path not found"));
});
