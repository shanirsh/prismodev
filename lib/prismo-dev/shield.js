module.exports = function createShield(deps) {
  const {
    fs,
    path,
    estimateTokens,
    formatBytes,
    color,
  } = deps;
  const { spawnSync } = require("child_process");

const SHIELD_SCHEMA_VERSION = 1;

function nowId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function pickInterestingLines(text, limit = 24) {
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  const interesting = [];
  const patterns = [
    /\b(error|failed|failure|exception|traceback|fatal|panic|segmentation fault)\b/i,
    /\b(warn|warning|deprecated|timeout|denied|unauthorized|forbidden)\b/i,
    /\b(assert|expected|received|diff|not found|cannot find|module not found)\b/i,
  ];
  for (const line of lines) {
    if (patterns.some((pattern) => pattern.test(line))) interesting.push(line.slice(0, 500));
    if (interesting.length >= limit) break;
  }
  if (interesting.length) return interesting;
  return lines.slice(Math.max(0, lines.length - Math.min(limit, 12))).map((line) => line.slice(0, 500));
}

function summarizeOutput(stdout, stderr) {
  const stdoutText = String(stdout || "");
  const stderrText = String(stderr || "");
  const combined = [stderrText, stdoutText].filter(Boolean).join("\n");
  const totalBytes = Buffer.byteLength(stdoutText) + Buffer.byteLength(stderrText);
  const totalTokens = estimateTokens(combined);
  return {
    stdoutBytes: Buffer.byteLength(stdoutText),
    stderrBytes: Buffer.byteLength(stderrText),
    totalBytes,
    estimatedTokens: totalTokens,
    interestingLines: pickInterestingLines(combined),
  };
}

function renderStoredReadCommand(pathValue) {
  return `sed -n '1,160p' ${JSON.stringify(pathValue)}`;
}

function shieldRoot(root) {
  return path.join(root, ".prismo", "shield");
}

function shieldDbPath(root) {
  return path.join(shieldRoot(root), "shield.sqlite");
}

function indexPath(root) {
  return path.join(shieldRoot(root), "index.jsonl");
}

function sqlString(value) {
  return `'${String(value == null ? "" : value).replace(/'/g, "''")}'`;
}

function sqliteAvailable() {
  const result = spawnSync("sqlite3", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0;
}

function sqliteExec(dbPath, sql, json = false) {
  const args = json ? ["-json", dbPath, sql] : [dbPath, sql];
  const result = spawnSync("sqlite3", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.error?.message || "sqlite3 failed").trim());
  }
  if (!json) return null;
  const out = String(result.stdout || "").trim();
  return out ? JSON.parse(out) : [];
}

function ensureSqliteIndex(root) {
  if (!sqliteAvailable()) return { available: false, reason: "sqlite3-not-found" };
  ensureDir(shieldRoot(root));
  const dbPath = shieldDbPath(root);
  sqliteExec(dbPath, `
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS shield_runs (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      exit_code INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      stdout_path TEXT NOT NULL,
      stderr_path TEXT NOT NULL,
      total_bytes INTEGER NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      summary_json TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS shield_output USING fts5(
      run_id UNINDEXED,
      command,
      stream UNINDEXED,
      content,
      tokenize='unicode61'
    );
  `);
  return { available: true, path: path.relative(root, dbPath).replace(/\\/g, "/") };
}

function indexShieldRun(root, payload, stdout, stderr) {
  const sqlite = ensureSqliteIndex(root);
  if (!sqlite.available) return { mode: "jsonl", sqlite };
  const dbPath = shieldDbPath(root);
  const runId = path.basename(payload.stored.directory);
  sqliteExec(dbPath, `
    INSERT OR REPLACE INTO shield_runs (
      id, command, cwd, exit_code, started_at, finished_at, duration_ms,
      stdout_path, stderr_path, total_bytes, estimated_tokens, summary_json
    ) VALUES (
      ${sqlString(runId)},
      ${sqlString(payload.command)},
      ${sqlString(payload.cwd)},
      ${Number(payload.exitCode || 0)},
      ${sqlString(payload.startedAt)},
      ${sqlString(payload.finishedAt)},
      ${Number(payload.durationMs || 0)},
      ${sqlString(payload.stored.stdout)},
      ${sqlString(payload.stored.stderr)},
      ${Number(payload.output.totalBytes || 0)},
      ${Number(payload.output.estimatedTokens || 0)},
      ${sqlString(JSON.stringify(payload))}
    );
    DELETE FROM shield_output WHERE run_id = ${sqlString(runId)};
    INSERT INTO shield_output (run_id, command, stream, content)
      VALUES (${sqlString(runId)}, ${sqlString(payload.command)}, 'stdout', ${sqlString(stdout)});
    INSERT INTO shield_output (run_id, command, stream, content)
      VALUES (${sqlString(runId)}, ${sqlString(payload.command)}, 'stderr', ${sqlString(stderr)});
  `);
  return { mode: "sqlite-fts5", sqlite };
}

function readJsonlIndex(root) {
  const filePath = indexPath(root);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readStoredText(root, relPath) {
  const fullPath = path.join(root, relPath);
  try {
    return fs.readFileSync(fullPath, "utf8");
  } catch {
    return "";
  }
}

function fallbackSearch(root, query, limit = 10) {
  const needle = String(query || "").toLowerCase();
  if (!needle) return [];
  const rows = readJsonlIndex(root).reverse();
  const results = [];
  for (const row of rows) {
    for (const stream of ["stderr", "stdout"]) {
      const relPath = row.stored?.[stream];
      const text = readStoredText(root, relPath || "");
      const lower = text.toLowerCase();
      const index = lower.indexOf(needle);
      if (index < 0) continue;
      const start = Math.max(0, index - 180);
      const end = Math.min(text.length, index + needle.length + 320);
      results.push({
        runId: path.basename(row.stored.directory),
        command: row.command,
        stream,
        path: relPath,
        exitCode: row.exitCode,
        finishedAt: row.finishedAt,
        snippet: text.slice(start, end).replace(/\s+/g, " ").trim(),
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

function runShieldSearch(rootDir = process.cwd(), query = "", options = {}) {
  const root = path.resolve(rootDir);
  const limit = options.limit || 10;
  if (!String(query || "").trim()) throw new Error("No search query provided. Use: prismo shield search \"error text\"");
  const sqlite = ensureSqliteIndex(root);
  if (sqlite.available && fs.existsSync(shieldDbPath(root))) {
    try {
      const phrase = `"${String(query).replace(/"/g, '""')}"`;
      const rows = sqliteExec(shieldDbPath(root), `
        SELECT
          shield_output.run_id AS runId,
          shield_output.command AS command,
          shield_output.stream AS stream,
          CASE shield_output.stream
            WHEN 'stderr' THEN shield_runs.stderr_path
            ELSE shield_runs.stdout_path
          END AS path,
          shield_runs.exit_code AS exitCode,
          shield_runs.finished_at AS finishedAt,
          snippet(shield_output, 3, '[', ']', ' ... ', 24) AS snippet
        FROM shield_output
        JOIN shield_runs ON shield_runs.id = shield_output.run_id
        WHERE shield_output MATCH ${sqlString(phrase)}
        ORDER BY rank
        LIMIT ${Number(limit)};
      `, true);
      return { query, mode: "sqlite-fts5", results: rows };
    } catch {
      // FTS queries can reject punctuation-heavy input; fall back to JSONL/plain text scan.
    }
  }
  return { query, mode: "jsonl-fallback", results: fallbackSearch(root, query, limit) };
}

function runShieldLast(rootDir = process.cwd(), options = {}) {
  const root = path.resolve(rootDir);
  const limit = options.limit || 5;
  return {
    mode: fs.existsSync(shieldDbPath(root)) ? "sqlite-fts5" : "jsonl-fallback",
    runs: readJsonlIndex(root).reverse().slice(0, limit),
  };
}

function runShield(rootDir = process.cwd(), commandArgs = [], options = {}) {
  const root = path.resolve(rootDir);
  if (!commandArgs.length) {
    throw new Error("No command provided. Use: prismo shield -- npm test");
  }

  const startedAt = new Date();
  const id = nowId();
  const runsDir = path.join(root, ".prismo", "shield", "runs", id);
  ensureDir(runsDir);

  const command = commandArgs[0];
  const args = commandArgs.slice(1);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 30 * 1024 * 1024,
    shell: false,
    env: process.env,
  });

  const finishedAt = new Date();
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const stdoutPath = path.join(runsDir, "stdout.txt");
  const stderrPath = path.join(runsDir, "stderr.txt");
  const summary = summarizeOutput(stdout, stderr);
  fs.writeFileSync(stdoutPath, stdout, "utf8");
  fs.writeFileSync(stderrPath, stderr, "utf8");

  const payload = {
    schemaVersion: 1,
    command: commandArgs.join(" "),
    cwd: root,
    exitCode: typeof result.status === "number" ? result.status : 1,
    signal: result.signal || null,
    error: result.error ? result.error.message : null,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    output: summary,
    stored: {
      stdout: path.relative(root, stdoutPath).replace(/\\/g, "/"),
      stderr: path.relative(root, stderrPath).replace(/\\/g, "/"),
      directory: path.relative(root, runsDir).replace(/\\/g, "/"),
    },
    next: [
      "Feed the summary to the agent first; inspect full output only if needed.",
      `Read stdout: ${renderStoredReadCommand(path.relative(root, stdoutPath).replace(/\\/g, "/"))}`,
      `Read stderr: ${renderStoredReadCommand(path.relative(root, stderrPath).replace(/\\/g, "/"))}`,
    ],
  };
  fs.writeFileSync(path.join(runsDir, "summary.json"), JSON.stringify(payload, null, 2), "utf8");
  fs.mkdirSync(path.join(root, ".prismo", "shield"), { recursive: true });
  fs.appendFileSync(path.join(root, ".prismo", "shield", "index.jsonl"), `${JSON.stringify(payload)}\n`, "utf8");
  payload.index = indexShieldRun(root, payload, stdout, stderr);
  fs.writeFileSync(path.join(runsDir, "summary.json"), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function renderShieldTerminal(result) {
  const lines = [];
  const exitTone = result.exitCode === 0 ? "green" : "red";
  lines.push("");
  lines.push(color("Prismo Shield", "bold"));
  lines.push("");
  lines.push(`Command: ${result.command}`);
  lines.push(`Exit: ${color(String(result.exitCode), exitTone)}`);
  lines.push(`Duration: ${result.durationMs}ms`);
  lines.push(`Captured: ${formatBytes(result.output.totalBytes)} (~${result.output.estimatedTokens.toLocaleString()} tokens kept out of chat)`);
  lines.push("");
  lines.push("Full Output Stored:");
  lines.push(`- ${result.stored.stdout}`);
  lines.push(`- ${result.stored.stderr}`);
  lines.push(`- ${result.stored.directory}/summary.json`);
  lines.push("");
  lines.push("Summary Returned To Context:");
  result.output.interestingLines.slice(0, 24).forEach((line) => lines.push(`- ${line}`));
  lines.push("");
  lines.push("Next:");
  lines.push("1. Give the agent this summary first.");
  lines.push("2. Inspect the stored full output only if the summary is not enough.");
  lines.push(`3. ${renderStoredReadCommand(result.stored.stderr)}`);
  return lines.join("\n");
}

function renderShieldSearchTerminal(result) {
  const lines = [];
  lines.push("");
  lines.push(color("Prismo Shield Search", "bold"));
  lines.push("");
  lines.push(`Query: ${result.query}`);
  lines.push(`Index: ${result.mode}`);
  lines.push(`Results: ${result.results.length}`);
  lines.push("");
  if (!result.results.length) {
    lines.push("No matching shield output found.");
    return lines.join("\n");
  }
  result.results.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.path} (${item.stream}, exit ${item.exitCode})`);
    lines.push(`   ${item.command}`);
    lines.push(`   ${String(item.snippet || "").slice(0, 700)}`);
  });
  lines.push("");
  lines.push("Next:");
  lines.push("Use the stored path above only if the snippet is not enough.");
  return lines.join("\n");
}

function renderShieldLastTerminal(result) {
  const lines = [];
  lines.push("");
  lines.push(color("Prismo Shield Last", "bold"));
  lines.push("");
  lines.push(`Index: ${result.mode}`);
  if (!result.runs.length) {
    lines.push("No shield runs found.");
    return lines.join("\n");
  }
  result.runs.forEach((run, index) => {
    lines.push(`${index + 1}. ${run.finishedAt}  exit ${run.exitCode}  ${run.command}`);
    lines.push(`   ${run.stored.directory}/summary.json`);
    lines.push(`   ${formatBytes(run.output.totalBytes)} (~${run.output.estimatedTokens.toLocaleString()} tokens kept out of chat)`);
  });
  return lines.join("\n");
}

  return {
    renderShieldLastTerminal,
    renderShieldSearchTerminal,
    renderShieldTerminal,
    runShieldLast,
    runShieldSearch,
    runShield,
  };
};
