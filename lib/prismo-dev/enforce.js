module.exports = function createEnforce(deps) {
  const {
    fs,
    path,
    NPX_COMMAND,
    runFirewall,
  } = deps;

  const HOOK_COMMAND = `${NPX_COMMAND} hook pretooluse`;
  const FILE_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead"]);
  const MAX_IDENTICAL_COMMANDS = 3;
  const MAX_TRACKED_SESSIONS = 8;

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
        const sessions = state.sessions || {};
        const session = sessions[sessionId] || { commands: {}, updatedAt: null };
        const count = Number(session.commands[command] || 0);
        if (count >= MAX_IDENTICAL_COMMANDS) {
          return deny(
            `Prismo loop breaker: this exact command has already run ${count} times in this session. `
            + "Repeating it again will not change the outcome and floods context. Change the approach, "
            + `or capture its output once with \`${NPX_COMMAND} shield -- ${command}\`.`
          );
        }
        session.commands[command] = count + 1;
        session.updatedAt = new Date().toISOString();
        sessions[sessionId] = session;
        const ids = Object.keys(sessions)
          .sort((a, b) => String(sessions[b].updatedAt || "").localeCompare(String(sessions[a].updatedAt || "")));
        state.sessions = Object.fromEntries(ids.slice(0, MAX_TRACKED_SESSIONS).map((id) => [id, sessions[id]]));
        writeState(root, state);
        return null;
      }
    } catch {
      return null;
    }
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
      return JSON.stringify(entry).includes("hook pretooluse");
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
    const entries = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
    if (entries.some(isPrismoHookEntry)) {
      actions.push("Prismo PreToolUse hook already installed in .claude/settings.json");
    } else {
      const existed = fs.existsSync(filePath);
      if (existed) {
        fs.copyFileSync(filePath, `${filePath}.prismo-backup`);
        actions.push("Backed up .claude/settings.json to settings.json.prismo-backup");
      }
      entries.push({
        matcher: "Read|Glob|Grep|NotebookRead|Bash",
        hooks: [{ type: "command", command: HOOK_COMMAND }],
      });
      settings.hooks.PreToolUse = entries;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      actions.push(`${existed ? "Updated" : "Created"} .claude/settings.json with the Prismo PreToolUse hook`);
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
    const entries = settings.hooks && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
    const kept = entries.filter((entry) => !isPrismoHookEntry(entry));
    if (kept.length !== entries.length) {
      if (kept.length) settings.hooks.PreToolUse = kept;
      else if (settings.hooks) delete settings.hooks.PreToolUse;
      fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      actions.push("Removed the Prismo PreToolUse hook from .claude/settings.json");
    } else {
      actions.push("No Prismo PreToolUse hook found in .claude/settings.json");
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
    return {
      schemaVersion: 1,
      command: "enforce",
      mode: "status",
      installed: hookInstalled(root),
      blockedRules: readBlockedPatterns(root).length,
      trackedSessions: Object.keys(state.sessions || {}).length,
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
    decidePreToolUse,
    matchesBlocked,
    renderEnforceTerminal,
    runEnforceInstall,
    runEnforceStatus,
    runEnforceUninstall,
  };
};
