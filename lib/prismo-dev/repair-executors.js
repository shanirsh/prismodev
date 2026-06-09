module.exports = function createRepairExecutors(deps) {
  const {
    fs,
    path,
    NPX_COMMAND,
    runDoctor,
    runOptimize,
    runGuard,
    runShield,
    runFirewall,
    getUsageSummary,
    appendIgnoreSuggestions,
  } = deps;

  const REPAIR_CAUSES = [
    "repeated-file-reads",
    "tool-output-flood",
    "generated-artifacts",
    "context-loop",
    "long-session-buildup",
  ];

  const SAFE_SHIELD_COMMANDS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "pytest", "python", "python3", "node"]);
  const EXPECTED_REPEATED_PATHS = new Set(["claude.md", "agents.md", "readme.md"]);

  function nowIso() {
    return new Date().toISOString();
  }

  function noopProgress() {
    return Promise.resolve();
  }

  function writeRepairFile(root, name, contents) {
    const relPath = path.join(".prismo", name);
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents, "utf8");
    return relPath;
  }

  function collectSessions(root, limit) {
    try {
      const summary = getUsageSummary({ tool: "all", cwd: root, limit: limit || 5 });
      return summary.sessions || [];
    } catch {
      return [];
    }
  }

  function aggregateEntries(sessions, pick) {
    const totals = new Map();
    for (const session of sessions) {
      for (const entry of pick(session) || []) {
        if (!entry || !entry.value) continue;
        totals.set(entry.value, (totals.get(entry.value) || 0) + Number(entry.count || 0));
      }
    }
    return Array.from(totals, ([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  }

  function isExpectedRepeatedPath(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return EXPECTED_REPEATED_PATHS.has(normalized) || normalized.endsWith("/readme.md");
  }

  function parseSafeCommandArgs(command) {
    const parts = String(command || "").trim().split(/\s+/).filter(Boolean);
    const separatorIndex = parts.indexOf("--");
    if (separatorIndex < 0) return null;
    const commandArgs = parts.slice(separatorIndex + 1);
    if (!commandArgs.length) return null;
    if (!SAFE_SHIELD_COMMANDS.has(commandArgs[0])) return null;
    if (commandArgs.some((arg) => /[;&|`$<>]/.test(arg))) return null;
    return commandArgs;
  }

  function repairTier(helpers) {
    return helpers.options && helpers.options.tier === "aggressive" ? "aggressive" : "mild";
  }

  // Aggressive tier adds a context firewall policy on top of the mild repair,
  // so the cause is fenced off by an allow/block file instead of guidance only.
  function applyAggressiveFirewall(root, cause) {
    if (!runFirewall) return [];
    try {
      const firewall = runFirewall(root, { task: cause, dryRun: false });
      return firewall.generatedFiles || [];
    } catch {
      return [];
    }
  }

  function parseScope(action, helpers) {
    if (helpers.options && helpers.options.scope) return helpers.options.scope;
    const args = helpers.parsed ? helpers.parsed.args : String(action.command || "").trim().split(/\s+/).slice(1);
    const scope = (args || []).find((arg) => arg && !arg.startsWith("-"));
    return ["frontend", "backend"].includes(String(scope || "").toLowerCase()) ? String(scope).toLowerCase() : null;
  }

  function looksLikeIgnoreRule(value) {
    const rule = String(value || "").trim();
    if (!rule || rule.length > 200) return false;
    if (rule.startsWith("/") || rule.startsWith("-") || rule.includes("..")) return false;
    return /^[A-Za-z0-9_.*/@-]+$/.test(rule);
  }

  function renderHotFilesGuide(hotPaths, contextFile) {
    return [
      "# Prismo Repair: Repeated File Reads",
      "",
      "These files were read repeatedly across recent coding-agent sessions.",
      "Read each one once, then rely on the compact context packs below instead of re-opening the file.",
      "",
      "## Hot Files",
      "",
      ...(hotPaths.length
        ? hotPaths.map((entry) => `- ${entry.value} (${entry.count} reads)`)
        : ["- No repeated reads detected in recent sessions."]),
      "",
      "## Session Rules",
      "",
      `- Start sessions from ${contextFile || ".prismo/architecture-summary.md"} instead of broad exploration.`,
      "- Quote the relevant section from a context pack instead of re-reading a hot file.",
      "- If a hot file changed during the session, re-read only the changed region.",
      "",
    ].join("\n");
  }

  function renderNoisyCommandsGuide(noisyCommands, shieldedRun) {
    return [
      "# Prismo Repair: Tool-Output Flood",
      "",
      "These commands repeatedly flooded agent context with raw output.",
      `Run them through \`${NPX_COMMAND} shield -- <command>\` so the full output stays on disk and only a compact summary enters context.`,
      "",
      "## Noisy Commands",
      "",
      ...(noisyCommands.length
        ? noisyCommands.map((entry) => `- \`${entry.value}\` (${entry.count} runs) -> \`${NPX_COMMAND} shield -- ${entry.value}\``)
        : ["- No repeated noisy commands detected in recent sessions."]),
      "",
      ...(shieldedRun
        ? [
            "## Last Shielded Run",
            "",
            `- Command: \`${shieldedRun.command}\``,
            `- Exit code: ${shieldedRun.exitCode}`,
            shieldedRun.runDir ? `- Full output stored in: ${shieldedRun.runDir}` : null,
            "",
          ].filter((line) => line !== null)
        : []),
      "## Session Rules",
      "",
      "- Never paste full test, build, or install output into the conversation.",
      "- Use shield summaries; search stored runs with `shield search` when details are needed.",
      "",
    ].join("\n");
  }

  function renderLoopBreakerGuide(repeatedCommands, loopSessionCount) {
    return [
      "# Prismo Repair: Context Loop",
      "",
      loopSessionCount > 0
        ? `${loopSessionCount} recent session(s) showed loop behavior: the same command retried with growing context.`
        : "No active loop detected, but guardrails below prevent retry loops from building context waste.",
      "",
      "## Repeated Commands",
      "",
      ...(repeatedCommands.length
        ? repeatedCommands.map((entry) => `- \`${entry.value}\` (${entry.count} runs)`)
        : ["- No repeated commands detected in recent sessions."]),
      "",
      "## Loop-Breaking Rules",
      "",
      "- After 2 failed attempts of the same command, stop and change the approach instead of retrying.",
      `- Route retry-heavy commands through \`${NPX_COMMAND} shield -- <command>\` so each retry costs a summary, not full output.`,
      "- If the session keeps circling, start a fresh session from the .prismo context packs and state what already failed.",
      "- Follow .prismo/live-guardrails.md while the session is active.",
      "",
    ].join("\n");
  }

  function renderSessionRestartGuide(scope, starterPrompt, heavySessionCount) {
    return [
      "# Prismo Repair: Long-Session Buildup",
      "",
      heavySessionCount > 0
        ? `${heavySessionCount} recent session(s) carried High/Medium context risk from accumulated history.`
        : "Recent sessions look healthy; the restart routine below keeps them that way.",
      "",
      "## Restart Routine",
      "",
      "- Split work at task boundaries: one task, one session.",
      `- Start each new session from the scoped context pack${scope ? ` for ${scope}` : ""} instead of carrying the old conversation forward.`,
      "- When a session crosses ~60% of its budget, finish the current task and restart.",
      "",
      ...(starterPrompt
        ? ["## Paste-Ready Starter Prompt", "", "```", starterPrompt, "```", ""]
        : []),
    ].join("\n");
  }

  // Repeated file reads: refresh ignore rules and context packs via doctor,
  // then map the hot files into a guide agents can read instead of the files.
  async function repairRepeatedFileReads(action, root, helpers = {}) {
    const progress = helpers.progress || noopProgress;
    const options = helpers.options || {};
    const startedAt = nowIso();

    await progress("analyzing", "Measuring repeated file reads in recent sessions");
    const sessions = collectSessions(root, options.limit || 5);
    const hotPaths = aggregateEntries(sessions, (session) => session.repeatedPathMentions)
      .filter((entry) => !isExpectedRepeatedPath(entry.value))
      .slice(0, 10);

    await progress("fixing", hotPaths.length
      ? `Found ${hotPaths.length} hot file(s); refreshing ignore rules and context packs`
      : "No hot files found; refreshing ignore rules and context packs as prevention");
    const doctor = runDoctor(root, { limit: options.limit || 3, applySuggestions: true, json: true });
    const generatedFiles = doctor.generatedFiles || [];
    const guidePath = writeRepairFile(root, "hot-files.md", renderHotFilesGuide(hotPaths, doctor.contextFile));
    const tier = repairTier(helpers);
    const firewallFiles = tier === "aggressive" ? applyAggressiveFirewall(root, "repeated-file-reads") : [];

    await progress("done", `Mapped ${hotPaths.length} hot file(s) into ${guidePath}`);
    return {
      status: "completed",
      statusMessage: (hotPaths.length
        ? `Repaired repeated file reads: ${hotPaths.length} hot file(s) mapped into ${guidePath}; context packs refreshed so agents read summaries once.`
        : `No repeated-read hot files detected; refreshed ignore rules and context packs, and wrote ${guidePath} as prevention.`)
        + (firewallFiles.length ? " Aggressive tier: context firewall policy added." : ""),
      result: {
        command: "repair",
        targetCause: "repeated-file-reads",
        tier,
        startedAt,
        completedAt: nowIso(),
        hotPaths,
        fixActions: doctor.fixActions || [],
        generatedFiles: [...generatedFiles, guidePath, ...firewallFiles],
        score: doctor.after && typeof doctor.after.score === "number" ? doctor.after.score : null,
      },
    };
  }

  // Tool-output flood: stage the noisy commands behind shield and, when the
  // action carries a safe command, run it shielded so output stays on disk.
  async function repairToolOutputFlood(action, root, helpers = {}) {
    const progress = helpers.progress || noopProgress;
    const options = helpers.options || {};
    const startedAt = nowIso();

    await progress("analyzing", "Finding commands that flood agent context");
    const sessions = collectSessions(root, options.limit || 5);
    const noisyCommands = aggregateEntries(sessions, (session) => session.repeatedCommands).slice(0, 8);

    const commandArgs = Array.isArray(options.commandArgs) && options.commandArgs.length
      ? (SAFE_SHIELD_COMMANDS.has(options.commandArgs[0]) && !options.commandArgs.some((arg) => /[;&|`$<>]/.test(arg)) ? options.commandArgs : null)
      : parseSafeCommandArgs(action.command);

    let shieldedRun = null;
    if (commandArgs) {
      await progress("shielding", `Running shielded command: ${commandArgs.join(" ")}`);
      const shield = runShield(root, commandArgs);
      shieldedRun = {
        command: commandArgs.join(" "),
        exitCode: shield.exitCode,
        summary: shield.summary || null,
        runDir: shield.runDir || null,
      };
    }

    const guidePath = writeRepairFile(root, "noisy-commands.md", renderNoisyCommandsGuide(noisyCommands, shieldedRun));
    const tier = repairTier(helpers);
    const firewallFiles = tier === "aggressive" ? applyAggressiveFirewall(root, "tool-output-flood") : [];
    await progress("done", shieldedRun
      ? `Shielded run stored; ${noisyCommands.length} noisy command(s) staged in ${guidePath}`
      : `${noisyCommands.length} noisy command(s) staged in ${guidePath}`);

    const statusMessage = (shieldedRun
      ? `Repaired tool-output flood: ran \`${shieldedRun.command}\` shielded (exit ${shieldedRun.exitCode}); full output stays on disk and ${guidePath} routes noisy commands through shield.`
      : `Repaired tool-output flood: staged ${noisyCommands.length} noisy command(s) behind shield in ${guidePath}. Queue a \`shield -- <command>\` action to capture a run.`)
      + (firewallFiles.length ? " Aggressive tier: context firewall policy added." : "");

    return {
      status: "completed",
      statusMessage,
      result: {
        command: "repair",
        targetCause: "tool-output-flood",
        tier,
        startedAt,
        completedAt: nowIso(),
        noisyCommands,
        shieldedRun,
        generatedFiles: [guidePath, ...firewallFiles],
      },
    };
  }

  // Generated artifacts: append ignore rules for scan-detected risks plus the
  // specific artifact paths observed entering recent sessions.
  async function repairGeneratedArtifacts(action, root, helpers = {}) {
    const progress = helpers.progress || noopProgress;
    const options = helpers.options || {};
    const startedAt = nowIso();

    await progress("analyzing", "Finding generated artifacts leaking into context");
    const sessions = collectSessions(root, options.limit || 5);
    const artifacts = aggregateEntries(sessions, (session) => session.generatedArtifacts).slice(0, 10);

    await progress("fixing", "Appending ignore rules for generated artifacts");
    const doctor = runDoctor(root, { limit: options.limit || 3, applySuggestions: true, noContextPacks: true, json: true });
    const fixActions = [...(doctor.fixActions || [])];

    const sessionRules = Array.from(new Set(artifacts.map((entry) => entry.value).filter(looksLikeIgnoreRule)));
    if (sessionRules.length) {
      const hasClaudeIgnore = fs.existsSync(path.join(root, ".claudeignore"));
      const hasCursorIgnore = fs.existsSync(path.join(root, ".cursorignore"));
      fixActions.push(...appendIgnoreSuggestions({
        root,
        hasClaudeIgnore,
        recommendedClaudeIgnore: sessionRules,
        missingClaudeIgnoreSuggestions: sessionRules,
        hasCursorIgnore,
        recommendedCursorIgnore: sessionRules,
        missingCursorIgnoreSuggestions: sessionRules,
      }));
    }

    const tier = repairTier(helpers);
    const firewallFiles = tier === "aggressive" ? applyAggressiveFirewall(root, "generated-artifacts") : [];

    await progress("done", `Ignore rules updated; ${artifacts.length} session-observed artifact(s) covered`);
    return {
      status: "completed",
      statusMessage: (artifacts.length
        ? `Repaired generated artifacts: ignore rules now cover ${artifacts.length} artifact path(s) seen in recent sessions plus scan-detected build output.`
        : "No artifact mentions found in recent sessions; refreshed scan-detected ignore rules as prevention.")
        + (firewallFiles.length ? " Aggressive tier: context firewall policy added." : ""),
      result: {
        command: "repair",
        targetCause: "generated-artifacts",
        tier,
        startedAt,
        completedAt: nowIso(),
        artifacts,
        fixActions,
        generatedFiles: firewallFiles,
        score: doctor.after && typeof doctor.after.score === "number" ? doctor.after.score : null,
      },
    };
  }

  // Context loop: run a guard snapshot with a tighter budget and write a
  // loop-breaker guide built from the actual repeated commands.
  async function repairContextLoop(action, root, helpers = {}) {
    const progress = helpers.progress || noopProgress;
    const options = helpers.options || {};
    const startedAt = nowIso();

    await progress("analyzing", "Looking for retry loops in recent sessions");
    const sessions = collectSessions(root, options.limit || 5);
    const loopSessionCount = sessions.filter((session) => session.loopSuspicion).length;
    const repeatedCommands = aggregateEntries(sessions, (session) => session.repeatedCommands).slice(0, 8);

    const tier = repairTier(helpers);
    await progress("guarding", "Running guard snapshot with a tightened token budget");
    const guard = await runGuard(root, {
      tool: "all",
      limit: options.limit || 5,
      tokenBudget: options.tokenBudget || (tier === "aggressive" ? 250000 : 400000),
      noSync: false,
      watch: false,
    });

    const guidePath = writeRepairFile(root, "loop-breaker.md", renderLoopBreakerGuide(repeatedCommands, loopSessionCount));
    const firewallFiles = tier === "aggressive" ? applyAggressiveFirewall(root, "context-loop") : [];
    const eventCount = guard.events ? guard.events.length : 0;
    await progress("done", `Guard recorded ${eventCount} event(s); loop-breaker rules written to ${guidePath}`);

    return {
      status: "completed",
      statusMessage: (loopSessionCount > 0
        ? `Repaired context loop: ${loopSessionCount} looping session(s) found; guard tightened and loop-breaker rules written to ${guidePath}.`
        : `No active loop found; guard tightened and loop-breaker rules written to ${guidePath} as prevention.`)
        + (firewallFiles.length ? " Aggressive tier: context firewall policy added and budget tightened." : ""),
      result: {
        command: "repair",
        targetCause: "context-loop",
        tier,
        startedAt,
        completedAt: nowIso(),
        loopSessions: loopSessionCount,
        repeatedCommands,
        guardEvents: eventCount,
        generatedFiles: [guidePath, ...firewallFiles],
      },
    };
  }

  // Long-session buildup: generate scoped context packs and a restart routine
  // so new sessions start small instead of inheriting stale history.
  async function repairLongSessionBuildup(action, root, helpers = {}) {
    const progress = helpers.progress || noopProgress;
    const options = helpers.options || {};
    const startedAt = nowIso();

    await progress("analyzing", "Checking recent sessions for context buildup");
    const sessions = collectSessions(root, options.limit || 5);
    const heavySessionCount = sessions.filter((session) => session.contextRisk === "High" || session.contextRisk === "Medium").length;

    const scope = parseScope(action, helpers);
    await progress("generating", `Generating ${scope ? `${scope} ` : ""}context packs for fresh-session starts`);
    const optimize = runOptimize(root, { scope });
    const generatedFiles = optimize.generatedFiles || [];
    const guidePath = writeRepairFile(root, "session-restart.md", renderSessionRestartGuide(optimize.scope || scope, optimize.starterPrompt, heavySessionCount));
    const tier = repairTier(helpers);
    const firewallFiles = tier === "aggressive" ? applyAggressiveFirewall(root, "long-session-buildup") : [];

    await progress("done", `Generated ${generatedFiles.length} context file(s); restart routine in ${guidePath}`);
    return {
      status: "completed",
      statusMessage: (heavySessionCount > 0
        ? `Repaired long-session buildup: ${heavySessionCount} heavy session(s) found; scoped context packs and a restart routine are in place so new sessions start small.`
        : `Recent sessions look healthy; generated scoped context packs and a restart routine in ${guidePath} to keep buildup down.`)
        + (firewallFiles.length ? " Aggressive tier: context firewall policy added." : ""),
      result: {
        command: "repair",
        targetCause: "long-session-buildup",
        tier,
        startedAt,
        completedAt: nowIso(),
        heavySessions: heavySessionCount,
        scope: optimize.scope || scope,
        starterPrompt: optimize.starterPrompt || null,
        generatedFiles: [...generatedFiles, guidePath, ...firewallFiles],
      },
    };
  }

  const executors = {
    "repeated-file-reads": repairRepeatedFileReads,
    "tool-output-flood": repairToolOutputFlood,
    "generated-artifacts": repairGeneratedArtifacts,
    "context-loop": repairContextLoop,
    "long-session-buildup": repairLongSessionBuildup,
  };

  function forCause(cause) {
    return executors[String(cause || "").trim().toLowerCase()] || null;
  }

  async function runRepair(rootDir = process.cwd(), cause, options = {}) {
    const root = path.resolve(rootDir);
    const executor = forCause(cause);
    if (!executor) {
      return {
        schemaVersion: 1,
        command: "repair",
        cause: cause || null,
        status: "failed",
        statusMessage: `Unknown repair cause: ${cause || "(none)"}. Valid causes: ${REPAIR_CAUSES.join(", ")}.`,
        result: null,
        generatedAt: nowIso(),
      };
    }
    const normalizedCause = String(cause).trim().toLowerCase();
    const action = {
      id: null,
      actionType: "repair",
      command: `${NPX_COMMAND} repair ${normalizedCause}${options.commandArgs && options.commandArgs.length ? ` -- ${options.commandArgs.join(" ")}` : ""}`,
      label: `Repair ${normalizedCause}`,
      targetCause: normalizedCause,
    };
    const outcome = await executor(action, root, { options });
    return {
      schemaVersion: 1,
      command: "repair",
      cause: normalizedCause,
      status: outcome.status,
      statusMessage: outcome.statusMessage,
      result: outcome.result,
      generatedAt: nowIso(),
    };
  }

  function renderRepairTerminal(report) {
    const lines = [];
    lines.push("");
    lines.push("PrismoDev Repair");
    lines.push("");
    lines.push(`Cause: ${report.cause || "unknown"}`);
    lines.push(`Status: ${report.status}`);
    if (report.statusMessage) lines.push(report.statusMessage);
    const result = report.result || {};
    if (result.hotPaths && result.hotPaths.length) {
      lines.push("");
      lines.push("Hot files:");
      result.hotPaths.forEach((entry) => lines.push(`- ${entry.value} (${entry.count} reads)`));
    }
    if (result.noisyCommands && result.noisyCommands.length) {
      lines.push("");
      lines.push("Noisy commands:");
      result.noisyCommands.forEach((entry) => lines.push(`- ${entry.value} (${entry.count} runs)`));
    }
    if (result.artifacts && result.artifacts.length) {
      lines.push("");
      lines.push("Artifacts seen in sessions:");
      result.artifacts.forEach((entry) => lines.push(`- ${entry.value} (${entry.count} mentions)`));
    }
    if (result.repeatedCommands && result.repeatedCommands.length) {
      lines.push("");
      lines.push("Repeated commands:");
      result.repeatedCommands.forEach((entry) => lines.push(`- ${entry.value} (${entry.count} runs)`));
    }
    if (result.fixActions && result.fixActions.length) {
      lines.push("");
      lines.push("Fixes:");
      result.fixActions.forEach((item) => lines.push(`- ${item}`));
    }
    if (result.generatedFiles && result.generatedFiles.length) {
      lines.push("");
      lines.push("Generated:");
      result.generatedFiles.forEach((file) => lines.push(`- ${file}`));
    }
    if (report.status === "failed" && !result.generatedFiles) {
      lines.push("");
      lines.push("Valid causes:");
      REPAIR_CAUSES.forEach((item) => lines.push(`- ${item}`));
    }
    return lines.join("\n");
  }

  return {
    REPAIR_CAUSES,
    forCause,
    renderRepairTerminal,
    runRepair,
  };
};
