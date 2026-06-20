module.exports = function createEnforce(deps) {
  const {
    fs,
    path,
    NPX_COMMAND,
    runFirewall,
  } = deps;

  const HOOK_COMMAND = `${NPX_COMMAND} hook pretooluse`;
  const POST_HOOK_COMMAND = `${NPX_COMMAND} hook posttooluse`;
  const FILE_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead"]);
  const MAX_IDENTICAL_COMMANDS = 3;
  const MAX_COMMAND_FAILURES = 3;
  const MAX_TRACKED_SESSIONS = 8;
  const DENIAL_LOG_LIMIT = 50;
  // Tokens a denied retry keeps out of context. A repeated quiet command saves
  // little; a repeated noisy one (tests, builds, installs) would have dumped a
  // full round of output, so it saves far more.
  const LOOP_DENY_TOKEN_ESTIMATE = 2000;
  const NOISY_LOOP_TOKEN_ESTIMATE = 12000;
  const NOISY_LOOP_RE = /\b(test|jest|vitest|pytest|build|webpack|vite|tsc|install|lint|eslint|playwright|cypress|coverage)\b/i;

  function loopTokenEstimate(command) {
    return NOISY_LOOP_RE.test(String(command || "")) ? NOISY_LOOP_TOKEN_ESTIMATE : LOOP_DENY_TOKEN_ESTIMATE;
  }

  function blockedContextPath(root) {
    return path.join(root, ".prismo", "blocked-context.txt");
  }

  function enforceStatePath(root) {
    return path.join(root, ".prismo", "enforce-state.json");
  }

  function settingsPath(root) {
    return path.join(root, ".claude", "settings.json");
  }

  function readBlockedPatterns(root) {
    try {
      return fs.readFileSync(blockedContextPath(root), "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
    } catch {
      return [];
    }
  }

  function readState(root) {
    try {
      const parsed = JSON.parse(fs.readFileSync(enforceStatePath(root), "utf8"));
      return parsed && typeof parsed === "object" ? { sessions: {}, ...parsed } : { sessions: {} };
    } catch {
      return { sessions: {} };
    }
  }

  function writeState(root, state) {
    const filePath = enforceStatePath(root);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  // Command records were plain attempt counters before outcome tracking;
  // normalize either shape to {attempts, failures, succeeded, outcomes}.
  function commandRecord(session, command) {
    const existing = session.commands[command];
    if (existing && typeof existing === "object") {
      return { attempts: 0, failures: 0, succeeded: false, outcomes: 0, ...existing };
    }
    return { attempts: Number(existing || 0), failures: 0, succeeded: false, outcomes: 0 };
  }

  function sessionRecord(state, sessionId) {
    const sessions = state.sessions || {};
    state.sessions = sessions;
    const session = sessions[sessionId] || { commands: {}, updatedAt: null };
    sessions[sessionId] = session;
    return session;
  }

  function pruneSessions(state) {
    const sessions = state.sessions || {};
    const ids = Object.keys(sessions)
      .sort((a, b) => String(sessions[b].updatedAt || "").localeCompare(String(sessions[a].updatedAt || "")));
    state.sessions = Object.fromEntries(ids.slice(0, MAX_TRACKED_SESSIONS).map((id) => [id, sessions[id]]));
  }

  function recordDenial(root, state, rule, target, estimatedTokens) {
    const denials = state.denials || { total: 0, blockedContext: 0, loops: 0, estimatedTokensSaved: 0, recent: [] };
    denials.total += 1;
    if (rule === "blocked-context") denials.blockedContext += 1;
    if (rule === "loop") denials.loops += 1;
    denials.estimatedTokensSaved += Math.max(0, Math.round(estimatedTokens));
    denials.recent = [{ at: new Date().toISOString(), rule, target }, ...(denials.recent || [])].slice(0, DENIAL_LOG_LIMIT);
    state.denials = denials;
    writeState(root, state);
  }

  function recordLoopStop(root, state, payload) {
    const loopStops = Array.isArray(state.loopStops) ? state.loopStops : [];
    const at = new Date().toISOString();
    const command = String(payload.command || "").slice(0, 240);
    const reason = payload.reason || "repeated-command";
    const sessionId = payload.sessionId || "unknown";
    const eventId = `claude-loop-stop-${sessionId}-${Buffer.from(`${reason}:${command}`).toString("base64").replace(/[^a-z0-9]/gi, "").slice(0, 24)}-${at.slice(0, 16)}`;
    state.loopStops = [{
      eventId,
      at,
      tool: "claude-code",
      command,
      reason,
      failures: payload.failures || 0,
      attempts: payload.attempts || 0,
      estimatedTokensSaved: Number(payload.estimatedTokensSaved) || LOOP_DENY_TOKEN_ESTIMATE,
      sessionId,
    }, ...loopStops].slice(0, DENIAL_LOG_LIMIT);
    writeState(root, state);
  }

  // Like loopStops: a publishable record of blocked context reads so the
  // connector can surface "prevented before spend" on the dashboard.
  function recordContextBlock(root, state, payload) {
    const contextBlocks = Array.isArray(state.contextBlocks) ? state.contextBlocks : [];
    const at = new Date().toISOString();
    const target = String(payload.target || "").slice(0, 240);
    const sessionId = payload.sessionId || "unknown";
    const eventId = `claude-context-block-${sessionId}-${Buffer.from(`${payload.rule}:${target}`).toString("base64").replace(/[^a-z0-9]/gi, "").slice(0, 24)}-${at.slice(0, 16)}`;
    state.contextBlocks = [{
      eventId,
      at,
      tool: "claude-code",
      target,
      rule: String(payload.rule || "").slice(0, 120),
      estimatedTokensSaved: Math.max(0, Math.round(payload.estimatedTokens || 0)),
      sessionId,
    }, ...contextBlocks].slice(0, DENIAL_LOG_LIMIT);
    writeState(root, state);
  }

  function estimateBlockedFileTokens(root, target) {
    try {
      const fullPath = path.isAbsolute(target) ? target : path.join(root, target);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) return Math.min(200000, Math.round(stat.size / 4));
    } catch {}
    return 1500;
  }

  function relativePath(root, filePath) {
    const value = String(filePath || "");
    const resolvedRoot = path.resolve(root);
    if (value.startsWith(`${resolvedRoot}${path.sep}`)) return value.slice(resolvedRoot.length + 1);
    if (value === resolvedRoot) return ".";
    return value.replace(/^\.\//, "");
  }

  function matchesBlocked(relPath, pattern) {
    const candidate = String(relPath || "").replace(/\\/g, "/");
    const rule = String(pattern || "").trim();
    if (!candidate || !rule) return false;
    if (rule.endsWith("/**")) {
      const dir = rule.slice(0, -3).replace(/\/$/, "");
      return candidate === dir || candidate.startsWith(`${dir}/`) || candidate.includes(`/${dir}/`);
    }
    if (rule.startsWith("*.")) {
      return candidate.endsWith(rule.slice(1));
    }
    return candidate === rule
      || candidate.endsWith(`/${rule}`)
      || candidate.includes(`/${rule}/`)
      || candidate.startsWith(`${rule}/`);
  }

  function deny(reason) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  }

  // Decide whether a PreToolUse event should be blocked. Returns the hook
  // response object for a deny, or null to allow. Fails open: any parse or
  // state error allows the call rather than breaking the user's agent.
  function decidePreToolUse(rootDir, rawEvent) {
    let event;
    try {
      event = typeof rawEvent === "string" ? JSON.parse(rawEvent) : rawEvent;
    } catch {
      return null;
    }
    if (!event || typeof event !== "object") return null;
    const root = path.resolve(event.cwd || rootDir || process.cwd());
    const toolName = String(event.tool_name || "");
    const toolInput = event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};

    try {
      if (FILE_TOOLS.has(toolName)) {
        const target = toolInput.file_path || toolInput.notebook_path || toolInput.path || null;
        if (!target) return null;
        const relPath = relativePath(root, target);
        const patterns = readBlockedPatterns(root);
        const hit = patterns.find((pattern) => matchesBlocked(relPath, pattern));
        if (hit) {
          const state = readState(root);
          const estimatedTokens = estimateBlockedFileTokens(root, target);
          recordDenial(root, state, "blocked-context", relPath, estimatedTokens);
          recordContextBlock(root, state, {
            target: relPath,
            rule: hit,
            estimatedTokens,
            sessionId: String(event.session_id || "unknown"),
          });
          return deny(
            `Prismo context firewall: "${relPath}" is blocked context (rule: ${hit}). `
            + "It is generated output that wastes agent tokens. Use the .prismo/ context packs instead, "
            + `or run \`${NPX_COMMAND} shield -- <command>\` if you need its contents summarized.`
          );
        }
        return null;
      }

      if (toolName === "Bash") {
        const command = String(toolInput.command || "").trim().replace(/\s+/g, " ");
        if (!command) return null;
        const sessionId = String(event.session_id || "unknown");
        const state = readState(root);
        const session = sessionRecord(state, sessionId);
        const record = commandRecord(session, command);

        // Outcome-aware loop breaking: a command that ever succeeded in
        // this session is legitimate to repeat (test loops while iterating).
        // With outcome data, deny only after repeated failures; without it
        // (PostToolUse hook absent), fall back to attempt counting.
        const deniedByFailures = !record.succeeded && record.outcomes > 0 && record.failures >= MAX_COMMAND_FAILURES;
        const deniedByAttempts = record.outcomes === 0 && record.attempts >= MAX_IDENTICAL_COMMANDS;
        if (deniedByFailures || deniedByAttempts) {
          const loopTokens = loopTokenEstimate(command);
          recordDenial(root, state, "loop", command, loopTokens);
          recordLoopStop(root, state, {
            command,
            sessionId,
            estimatedTokensSaved: loopTokens,
            reason: deniedByFailures ? "repeated-failing-command" : "repeated-identical-command",
            failures: record.failures,
            attempts: record.attempts,
          });
          const observation = deniedByFailures
            ? `this exact command has already failed ${record.failures} times in this session`
            : `this exact command has already run ${record.attempts} times in this session`;
          return deny(
            `Prismo loop breaker: ${observation}. `
            + "Repeating it again will not change the outcome and floods context. Change the approach, "
            + `or capture its output once with \`${NPX_COMMAND} shield -- ${command}\`.`
          );
        }
        record.attempts += 1;
        session.commands[command] = record;
        session.updatedAt = new Date().toISOString();
        pruneSessions(state);
        writeState(root, state);
        return null;
      }
    } catch {
      return null;
    }
    return null;
  }

  // PostToolUse: record whether the Bash command actually failed, so the
  // loop breaker can tell a failing retry loop from a legitimate test loop.
  // Output shape varies by Claude Code version; unknown shapes record
  // nothing rather than guessing.
  function decidePostToolUse(rootDir, rawEvent) {
    let event;
    try {
      event = typeof rawEvent === "string" ? JSON.parse(rawEvent) : rawEvent;
    } catch {
      return null;
    }
    if (!event || typeof event !== "object" || String(event.tool_name || "") !== "Bash") return null;
    const toolInput = event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
    const command = String(toolInput.command || "").trim().replace(/\s+/g, " ");
    if (!command) return null;

    const response = event.tool_response;
    let failed = null;
    if (response && typeof response === "object") {
      if (typeof response.exit_code === "number") failed = response.exit_code !== 0;
      else if (typeof response.exitCode === "number") failed = response.exitCode !== 0;
      else if (typeof response.is_error === "boolean") failed = response.is_error;
      else if (response.interrupted === true) failed = true;
    }
    if (failed === null) return null;

    try {
      const root = path.resolve(event.cwd || rootDir || process.cwd());
      const state = readState(root);
      const session = sessionRecord(state, String(event.session_id || "unknown"));
      const record = commandRecord(session, command);
      record.outcomes += 1;
      if (failed) record.failures += 1;
      else record.succeeded = true;
      session.commands[command] = record;
      session.updatedAt = new Date().toISOString();
      pruneSessions(state);
      writeState(root, state);
    } catch {}
    return null;
  }

  function readSettings(root) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath(root), "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function isPrismoHookEntry(entry) {
    try {
      const text = JSON.stringify(entry);
      return text.includes("hook pretooluse") || text.includes("hook posttooluse");
    } catch {
      return false;
    }
  }

  function hookInstalled(root) {
    const settings = readSettings(root);
    const entries = settings.hooks && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
    return entries.some(isPrismoHookEntry);
  }

  function runEnforceInstall(rootDir = process.cwd(), options = {}) {
    const root = path.resolve(rootDir);
    const actions = [];

    if (!fs.existsSync(blockedContextPath(root)) && runFirewall && !options.noFirewall) {
      runFirewall(root, { task: "enforcement", dryRun: false });
      actions.push("Generated .prismo context firewall policy (allowed/blocked context)");
    }

    const filePath = settingsPath(root);
    const settings = readSettings(root);
    settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
    const preEntries = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
    const postEntries = Array.isArray(settings.hooks.PostToolUse) ? settings.hooks.PostToolUse : [];
    if (preEntries.some(isPrismoHookEntry) && postEntries.some(isPrismoHookEntry)) {
      actions.push("Prismo hooks already installed in .claude/settings.json");
    } else {
      const existed = fs.existsSync(filePath);
      if (existed) {
        fs.copyFileSync(filePath, `${filePath}.prismo-backup`);
        actions.push("Backed up .claude/settings.json to settings.json.prismo-backup");
      }
      if (!preEntries.some(isPrismoHookEntry)) {
        preEntries.push({
          matcher: "Read|Glob|Grep|NotebookRead|Bash",
          hooks: [{ type: "command", command: HOOK_COMMAND }],
        });
      }
      if (!postEntries.some(isPrismoHookEntry)) {
        postEntries.push({
          matcher: "Bash",
          hooks: [{ type: "command", command: POST_HOOK_COMMAND }],
        });
      }
      settings.hooks.PreToolUse = preEntries;
      settings.hooks.PostToolUse = postEntries;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      actions.push(`${existed ? "Updated" : "Created"} .claude/settings.json with the Prismo PreToolUse + PostToolUse hooks`);
    }

    return {
      schemaVersion: 1,
      command: "enforce",
      mode: "install",
      installed: true,
      blockedRules: readBlockedPatterns(root).length,
      actions,
      generatedAt: new Date().toISOString(),
    };
  }

  function runEnforceUninstall(rootDir = process.cwd()) {
    const root = path.resolve(rootDir);
    const filePath = settingsPath(root);
    const settings = readSettings(root);
    const actions = [];
    let removed = false;
    for (const eventName of ["PreToolUse", "PostToolUse"]) {
      const entries = settings.hooks && Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
      const kept = entries.filter((entry) => !isPrismoHookEntry(entry));
      if (kept.length !== entries.length) {
        removed = true;
        if (kept.length) settings.hooks[eventName] = kept;
        else if (settings.hooks) delete settings.hooks[eventName];
      }
    }
    if (removed) {
      fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      actions.push("Removed the Prismo hooks from .claude/settings.json");
    } else {
      actions.push("No Prismo hooks found in .claude/settings.json");
    }
    return {
      schemaVersion: 1,
      command: "enforce",
      mode: "uninstall",
      installed: false,
      actions,
      generatedAt: new Date().toISOString(),
    };
  }

  function runEnforceStatus(rootDir = process.cwd()) {
    const root = path.resolve(rootDir);
    const state = readState(root);
    const denials = state.denials || { total: 0, blockedContext: 0, loops: 0, estimatedTokensSaved: 0 };
    return {
      schemaVersion: 1,
      command: "enforce",
      mode: "status",
      installed: hookInstalled(root),
      blockedRules: readBlockedPatterns(root).length,
      trackedSessions: Object.keys(state.sessions || {}).length,
      denials: {
        total: denials.total || 0,
        blockedContext: denials.blockedContext || 0,
        loops: denials.loops || 0,
        estimatedTokensSaved: denials.estimatedTokensSaved || 0,
      },
      settingsPath: path.join(".claude", "settings.json"),
      generatedAt: new Date().toISOString(),
    };
  }

  function renderEnforceTerminal(result) {
    const lines = [];
    lines.push("");
    lines.push("PrismoDev Enforce");
    lines.push("");
    if (result.mode === "status") {
      lines.push(`Hook installed: ${result.installed ? "yes" : "no"}`);
      lines.push(`Blocked-context rules: ${result.blockedRules}`);
      lines.push(`Sessions tracked for loop breaking: ${result.trackedSessions}`);
      if (result.denials && result.denials.total > 0) {
        lines.push(`Denials: ${result.denials.total} (${result.denials.blockedContext} blocked-context, ${result.denials.loops} loop)`);
        lines.push(`Estimated tokens kept out of context: ~${result.denials.estimatedTokensSaved.toLocaleString()}`);
      }
      if (!result.installed) {
        lines.push("");
        lines.push(`Run \`${NPX_COMMAND} enforce install\` to enforce the context firewall at runtime.`);
      }
      return lines.join("\n");
    }
    (result.actions || []).forEach((action) => lines.push(`- ${action}`));
    if (result.mode === "install") {
      lines.push("");
      lines.push(`Blocked-context rules enforced: ${result.blockedRules}`);
      lines.push("Claude Code will now be denied reads of blocked context and fourth retries of an identical command.");
      lines.push("Other agents still follow the .prismo policy files advisorily.");
    }
    return lines.join("\n");
  }

  return {
    decidePostToolUse,
    decidePreToolUse,
    matchesBlocked,
    renderEnforceTerminal,
    runEnforceInstall,
    runEnforceStatus,
    runEnforceUninstall,
  };
};
