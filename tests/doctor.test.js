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
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: codexHome, PRISMO_CLAUDE_HOME: path.join(root, "none"), PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") } }
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
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: path.join(root, "none"), PRISMO_CLAUDE_HOME: path.join(root, "none"), PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") } }
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
  assert.ok(fs.existsSync(path.join(root, ".prismo", "architecture-summary.receipt.json")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "frontend-context.md")));
  assert.ok(fs.existsSync(path.join(root, ".prismo", "frontend-context.receipt.json")));
  const receipt = JSON.parse(fs.readFileSync(path.join(root, ".prismo", "frontend-context.receipt.json"), "utf8"));
  assert.equal(receipt.schema_version, 1);
  assert.equal(receipt.pack_id, "frontend-context");
  assert.equal(receipt.pack_path, ".prismo/frontend-context.md");
  assert.ok(receipt.source_globs_digest.startsWith("sha256:"));
  assert.ok(receipt.target_agents.includes("codex"));
  assert.ok(receipt.target_agents.includes("mcp"));
  assert.ok(receipt.omitted_classes.includes("lockfiles"));
  assert.equal(receipt.token_budget, 12000);
  assert.equal(receipt.stale_if_older_than_ms, 86400000);
  assert.match(receipt.verify_command, /getprismo optimize frontend/);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8").includes("Use concise instructions."), true);
});

test("doctor --json outputs valid before/after payload only", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { express: "4.0.0" } }), "utf8");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "doctor", "--json", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: path.join(root, "none"), PRISMO_CLAUDE_HOME: path.join(root, "none"), PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.scannedPath, root);
  assert.equal(typeof payload.before.score, "number");
  assert.equal(typeof payload.after.score, "number");
  assert.equal(typeof payload.scoreDelta, "number");
  assert.ok(Array.isArray(payload.fixActions));
  assert.ok(payload.generatedFiles.includes(".prismo/architecture-summary.md"));
  assert.ok(payload.generatedFiles.includes(".prismo/architecture-summary.receipt.json"));
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
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: path.join(root, "none"), PRISMO_CLAUDE_HOME: path.join(root, "none"), PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") } }
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
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: path.join(root, "none"), PRISMO_CLAUDE_HOME: path.join(root, "none"), PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") } }
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
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: path.join(noContextRoot, "none"), PRISMO_CLAUDE_HOME: path.join(noContextRoot, "none"), PRISMO_CURSOR_HOME: path.join(noContextRoot, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(noContextRoot, "none") } }
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
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: path.join(root, "none"), PRISMO_CLAUDE_HOME: path.join(root, "none"), PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") } }
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

test("doctor --apply-suggestions --dry-run prints a readable ignore diff preview", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "18.0.0" } }), "utf8");
  fs.writeFileSync(path.join(root, ".claudeignore"), "custom-keep/\n", "utf8");
  fs.writeFileSync(path.join(root, ".cursorignore"), "cursor-keep/\n", "utf8");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "prismo.js"), "doctor", "--apply-suggestions", "--dry-run", "--no-context-packs", root],
    { encoding: "utf8", env: { ...process.env, PRISMO_CODEX_HOME: path.join(root, "none"), PRISMO_CLAUDE_HOME: path.join(root, "none"), PRISMO_CURSOR_HOME: path.join(root, "none"), PRISMO_CURSOR_APP_SUPPORT: path.join(root, "none") } }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Prismo Apply Suggestions Preview"));
  assert.equal(result.stdout.includes("Estimated exposed context reduction"), false);
  assert.ok(result.stdout.includes(".claudeignore\n+"));
  assert.ok(result.stdout.includes("+ dist/"));
  assert.ok(result.stdout.includes(".cursorignore\n+"));
  assert.ok(result.stdout.includes("Run to apply:\nnpx getprismo doctor --apply-suggestions"));
  assert.equal(fs.readFileSync(path.join(root, ".claudeignore"), "utf8"), "custom-keep/\n");
  assert.equal(fs.existsSync(path.join(root, ".claudeignore.prismo-backup")), false);
});
