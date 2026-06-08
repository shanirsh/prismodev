const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const createConnector = require("../lib/prismo-dev/connector");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prismo-connector-"));
}

function withEnv(key, value, fn) {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

function connectorWith(home, overrides = {}) {
  return createConnector({
    fs,
    os: {
      ...os,
      homedir: () => home,
    },
    path,
    spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
    NPX_COMMAND: "npx -y getprismo@latest",
    ...overrides,
  });
}

test("connector writes a background runner for the selected repo", () => {
  const home = tempDir();
  const repo = tempDir();

  withEnv("PRISMO_HOME", path.join(home, ".prismo"), () => {
    const connector = connectorWith(home);
    const result = connector.writeRunner(repo, { interval: 30, mode: "suggest" });

    assert.equal(result.root, path.resolve(repo));
    assert.equal(result.interval, 30);
    assert.equal(result.mode, "suggest");

    const runner = fs.readFileSync(path.join(home, ".prismo", "connector", "run.sh"), "utf8");
    assert.ok(runner.includes("npx -y getprismo@latest agent --watch --interval 30 --mode 'suggest'"));
    assert.ok(runner.includes(path.resolve(repo)));

    const state = JSON.parse(fs.readFileSync(path.join(home, ".prismo", "connector", "state.json"), "utf8"));
    assert.equal(state.root, path.resolve(repo));
    assert.equal(state.mode, "suggest");
  });
});

test("connector install dry-run creates launch agent files on macOS", () => {
  if (process.platform !== "darwin") return;
  const home = tempDir();
  const repo = tempDir();

  withEnv("PRISMO_HOME", path.join(home, ".prismo"), () => {
    const connector = connectorWith(home);
    const result = connector.runConnectorInstall(repo, { dryRun: true });

    assert.equal(result.installed, true);
    assert.equal(result.started, true);
    assert.ok(fs.existsSync(result.runner));
    assert.ok(fs.existsSync(result.plistPath));

    const plist = fs.readFileSync(result.plistPath, "utf8");
    assert.ok(plist.includes("dev.getprismo.connector"));
    assert.ok(plist.includes(result.runner));
  });
});

test("connector status returns idle when not installed", () => {
  const home = tempDir();

  withEnv("PRISMO_HOME", path.join(home, ".prismo"), () => {
    const connector = connectorWith(home);
    const result = connector.runConnectorStatus();

    assert.equal(result.installed, false);
    assert.equal(result.online, false);
    assert.equal(result.action, "status");
  });
});
