module.exports = function createShield(deps) {
  const {
    fs,
    path,
    estimateTokens,
    formatBytes,
    color,
  } = deps;
  const { spawnSync } = require("child_process");

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

  return {
    renderShieldTerminal,
    runShield,
  };
};
