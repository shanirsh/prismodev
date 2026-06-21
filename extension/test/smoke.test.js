// Headless activation smoke test: loads the *built* bundle with a mock `vscode`
// module and runs activate(), proving the extension loads, registers all its
// commands, creates the status bar, and wires the URI handler without throwing
// — the failure mode that would otherwise only surface on a real install.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

function makeMockVscode(record) {
  return {
    StatusBarAlignment: { Right: 2, Left: 1 },
    Uri: {
      parse: (s) => ({
        toString: () => s,
        get path() {
          try { return new URL(s).pathname; } catch { return ""; }
        },
        get query() {
          try { return new URL(s).search.replace(/^\?/, ""); } catch { return ""; }
        },
      }),
    },
    env: {
      uriScheme: "cursor",
      appName: "Cursor",
      openExternal: async () => true,
      asExternalUri: async (uri) => uri,
    },
    workspace: {
      getConfiguration: () => ({ get: (_key, def) => def }),
      workspaceFolders: undefined,
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => {
        record.statusBar = { text: "", tooltip: "", command: "", show: () => { record.shown = true; }, dispose() {} };
        return record.statusBar;
      },
      registerUriHandler: (handler) => { record.uriHandler = handler; return { dispose() {} }; },
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showInputBox: async () => undefined,
    },
    commands: {
      registerCommand: (id, fn) => { record.commands[id] = fn; return { dispose() {} }; },
    },
  };
}

function loadExtensionWithMock(record) {
  const mock = makeMockVscode(record);
  const orig = Module._load;
  Module._load = function (request, ...args) {
    if (request === "vscode") return mock;
    return orig.call(this, request, ...args);
  };
  try {
    delete require.cache[require.resolve("../dist/extension.js")];
    return require("../dist/extension.js");
  } finally {
    Module._load = orig;
  }
}

function fakeContext() {
  const store = new Map();
  const global = new Map();
  return {
    subscriptions: [],
    secrets: {
      get: async (k) => store.get(k),
      store: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
    },
    globalState: { get: (k) => global.get(k), update: async (k, v) => void global.set(k, v) },
    _store: store,
  };
}

test("extension activates and registers its commands without throwing", async () => {
  const record = { commands: {} };
  const ext = loadExtensionWithMock(record);
  assert.equal(typeof ext.activate, "function");
  assert.equal(typeof ext.deactivate, "function");

  const ctx = fakeContext();
  await ext.activate(ctx);

  for (const id of ["prismo.signIn", "prismo.signInWithKey", "prismo.signOut", "prismo.openDashboard", "prismo.syncNow", "prismo.upgrade"]) {
    assert.equal(typeof record.commands[id], "function", `command ${id} should be registered`);
  }
  assert.ok(record.statusBar, "status bar item should be created");
  assert.ok(record.shown, "status bar should be shown");
  assert.ok(record.uriHandler && typeof record.uriHandler.handleUri === "function", "URI handler should be registered");
});

test("URI callback rejects a token whose state nonce doesn't match", async () => {
  const record = { commands: {} };
  const ext = loadExtensionWithMock(record);
  const ctx = fakeContext();
  await ext.activate(ctx);

  // Start a sign-in so a pending state nonce exists, then deliver a callback
  // with the wrong state — the token must be refused (no sync side effects).
  await record.commands["prismo.signIn"]();
  await record.uriHandler.handleUri({ path: "/auth", query: "token=tok_evil&state=not-the-real-nonce" });
  assert.equal(ctx._store.get("prismo.deviceToken"), undefined, "mismatched-state token must not be stored");
});
