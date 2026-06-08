module.exports = function createConnector(deps) {
  const {
    fs,
    os,
    path,
    spawnSync,
    NPX_COMMAND,
  } = deps;

  const LABEL = "dev.getprismo.connector";
  const BACKGROUND_COMMAND = String(NPX_COMMAND || "").includes(" -y ")
    ? NPX_COMMAND
    : "npx -y getprismo@latest";

  function prismoHome() {
    return process.env.PRISMO_HOME || path.join(os.homedir(), ".prismo");
  }

  function connectorDir() {
    return path.join(prismoHome(), "connector");
  }

  function statePath() {
    return path.join(connectorDir(), "state.json");
  }

  function scriptPath() {
    return path.join(connectorDir(), "run.sh");
  }

  function logPath() {
    return path.join(connectorDir(), "connector.log");
  }

  function errorLogPath() {
    return path.join(connectorDir(), "connector.err.log");
  }

  function plistPath() {
    return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  }

  function readJson(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  function writeJson(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  function shellEscape(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
  }

  function xmlEscape(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function launchctl(args, options = {}) {
    if (options.dryRun) return { status: 0, stdout: "", stderr: "" };
    const result = spawnSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return {
      status: result.status,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
    };
  }

  function writeRunner(rootDir, options = {}) {
    const root = path.resolve(rootDir || process.cwd());
    const interval = Math.max(5, Number(options.interval || 15));
    const syncInterval = Math.max(30, Number(options.syncInterval || 60));
    const detectInterval = Math.max(60, Number(options.detectInterval || 300));
    const mode = options.mode || "autopilot";
    fs.mkdirSync(connectorDir(), { recursive: true });
    const command = `${BACKGROUND_COMMAND} agent --watch --interval ${interval} --sync-interval ${syncInterval} --detect-interval ${detectInterval} --mode ${shellEscape(mode)} ${shellEscape(root)}`;
    const contents = [
      "#!/bin/sh",
      "set -eu",
      `cd ${shellEscape(root)}`,
      `exec ${command}`,
      "",
    ].join("\n");
    fs.writeFileSync(scriptPath(), contents, { encoding: "utf8", mode: 0o700 });
    writeJson(statePath(), {
      schemaVersion: 1,
      installedAt: new Date().toISOString(),
      root,
      interval,
      syncInterval,
      detectInterval,
      mode,
      command,
      platform: process.platform,
      runner: scriptPath(),
      logPath: logPath(),
      errorLogPath: errorLogPath(),
    });
    return { root, interval, syncInterval, detectInterval, mode, command };
  }

  function writePlist() {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xmlEscape(scriptPath())}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath())}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errorLogPath())}</string>
</dict>
</plist>
`;
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), plist, "utf8");
  }

  function isMacLaunchdAvailable() {
    return process.platform === "darwin";
  }

  function runConnectorInstall(rootDir = process.cwd(), options = {}) {
    const runner = writeRunner(rootDir, options);
    if (!isMacLaunchdAvailable()) {
      return {
        schemaVersion: 1,
        command: "connector",
        action: "install",
        installed: false,
        started: false,
        platform: process.platform,
        statePath: statePath(),
        runner: scriptPath(),
        reason: "background-service-not-supported",
        next: [`${NPX_COMMAND} agent --watch`],
      };
    }

    writePlist();
    launchctl(["bootout", `gui/${process.getuid()}`, plistPath()], options);
    const bootstrap = launchctl(["bootstrap", `gui/${process.getuid()}`, plistPath()], options);
    const kickstart = launchctl(["kickstart", "-k", `gui/${process.getuid()}/${LABEL}`], options);
    const started = bootstrap.status === 0 || kickstart.status === 0 || options.dryRun;
    return {
      schemaVersion: 1,
      command: "connector",
      action: "install",
      installed: true,
      started,
      label: LABEL,
      root: runner.root,
      mode: runner.mode,
      interval: runner.interval,
      syncInterval: runner.syncInterval,
      plistPath: plistPath(),
      statePath: statePath(),
      runner: scriptPath(),
      logPath: logPath(),
      errorLogPath: errorLogPath(),
      error: started ? null : (bootstrap.stderr || kickstart.stderr || "launchctl failed").trim(),
    };
  }

  function runConnectorStart(options = {}) {
    if (!isMacLaunchdAvailable()) {
      return { schemaVersion: 1, command: "connector", action: "start", started: false, reason: "background-service-not-supported" };
    }
    if (!fs.existsSync(plistPath())) {
      return { schemaVersion: 1, command: "connector", action: "start", started: false, reason: "not-installed", next: [`${NPX_COMMAND} connector install`] };
    }
    const result = launchctl(["kickstart", "-k", `gui/${process.getuid()}/${LABEL}`], options);
    return {
      schemaVersion: 1,
      command: "connector",
      action: "start",
      started: result.status === 0 || options.dryRun,
      label: LABEL,
      error: result.status === 0 || options.dryRun ? null : result.stderr.trim(),
    };
  }

  function runConnectorStop(options = {}) {
    if (!isMacLaunchdAvailable()) {
      return { schemaVersion: 1, command: "connector", action: "stop", stopped: false, reason: "background-service-not-supported" };
    }
    const result = launchctl(["bootout", `gui/${process.getuid()}`, plistPath()], options);
    return {
      schemaVersion: 1,
      command: "connector",
      action: "stop",
      stopped: result.status === 0 || options.dryRun,
      label: LABEL,
      error: result.status === 0 || options.dryRun ? null : result.stderr.trim(),
    };
  }

  function runConnectorUninstall(options = {}) {
    const stop = runConnectorStop(options);
    if (!options.dryRun) {
      if (fs.existsSync(plistPath())) fs.rmSync(plistPath(), { force: true });
      if (fs.existsSync(scriptPath())) fs.rmSync(scriptPath(), { force: true });
    }
    return {
      schemaVersion: 1,
      command: "connector",
      action: "uninstall",
      uninstalled: true,
      stopped: stop.stopped,
      removed: [plistPath(), scriptPath()],
    };
  }

  function runConnectorStatus() {
    const state = readJson(statePath());
    const installed = fs.existsSync(plistPath()) || fs.existsSync(scriptPath());
    let online = false;
    let raw = "";
    if (isMacLaunchdAvailable() && fs.existsSync(plistPath())) {
      const result = launchctl(["print", `gui/${process.getuid()}/${LABEL}`]);
      raw = `${result.stdout}${result.stderr}`;
      online = result.status === 0 && /state = running|pid = \d+/i.test(raw);
    }
    return {
      schemaVersion: 1,
      command: "connector",
      action: "status",
      installed,
      online,
      label: LABEL,
      platform: process.platform,
      state,
      plistPath: plistPath(),
      runner: scriptPath(),
      logPath: logPath(),
      errorLogPath: errorLogPath(),
    };
  }

  function renderConnectorTerminal(result) {
    const lines = [];
    lines.push("");
    lines.push("PrismoDev Connector");
    lines.push("");
    if (result.action === "status") {
      lines.push(`Installed: ${result.installed ? "yes" : "no"}`);
      lines.push(`Status: ${result.online ? "online" : "idle"}`);
      if (result.state?.root) lines.push(`Repo: ${result.state.root}`);
      if (result.state?.interval) lines.push(`Poll: every ${result.state.interval}s`);
      if (result.state?.syncInterval) lines.push(`Sync: every ${result.state.syncInterval}s`);
      lines.push(`Logs: ${result.logPath}`);
    } else if (result.action === "install") {
      lines.push(`Status: ${result.started ? "started" : result.installed ? "installed" : "not installed"}`);
      if (result.root) lines.push(`Repo: ${result.root}`);
      if (result.interval) lines.push(`Poll: every ${result.interval}s`);
      if (result.syncInterval) lines.push(`Sync: every ${result.syncInterval}s`);
      if (result.reason) lines.push(`Note: ${result.reason}`);
      if (result.error) lines.push(`Error: ${result.error}`);
    } else if (result.action === "start") {
      lines.push(`Status: ${result.started ? "started" : "not started"}`);
      if (result.reason) lines.push(`Note: ${result.reason}`);
      if (result.error) lines.push(`Error: ${result.error}`);
    } else if (result.action === "stop") {
      lines.push(`Status: ${result.stopped ? "stopped" : "not stopped"}`);
      if (result.reason) lines.push(`Note: ${result.reason}`);
      if (result.error) lines.push(`Error: ${result.error}`);
    } else if (result.action === "uninstall") {
      lines.push("Status: uninstalled");
    }
    if (result.next?.length) {
      lines.push("");
      lines.push("Next");
      result.next.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    }
    return lines.join("\n");
  }

  return {
    LABEL,
    renderConnectorTerminal,
    runConnectorInstall,
    runConnectorStart,
    runConnectorStatus,
    runConnectorStop,
    runConnectorUninstall,
    writeRunner,
  };
};
