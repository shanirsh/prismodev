// Headless activation smoke test: loads the *built* bundle with a mock `vscode`
// module and runs activate(), proving the extension loads, registers all its
// commands, creates the status bar, and wires the URI handler without throwing
// — the failure mode that would otherwise only surface on a real install.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const path = require("node:path");

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
      joinPath: (base, ...parts) => ({
        fsPath: path.join(base.fsPath || "", ...parts),
        toString: () => [base.toString ? base.toString() : base.fsPath || "", ...parts].join("/").replace(/\/+/g, "/"),
      }),
    },
    env: {
      uriScheme: "cursor",
      appName: "Cursor",
      clipboard: { writeText: async (text) => { record.clipboard = text; } },
      openExternal: async () => true,
      asExternalUri: async (uri) => uri,
    },
    workspace: {
      getConfiguration: () => ({ get: (_key, def) => def }),
      workspaceFolders: [{ uri: { fsPath: path.join(__dirname, "fixtures", "workspace") } }],
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => {
        record.statusBar = { text: "", tooltip: "", command: "", show: () => { record.shown = true; }, dispose() {} };
        return record.statusBar;
      },
      registerUriHandler: (handler) => { record.uriHandler = handler; return { dispose() {} }; },
      registerWebviewViewProvider: (id, provider) => { record.viewProvider = { id, provider }; return { dispose() {} }; },
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
    extensionUri: { fsPath: "/tmp/prismo-extension", toString: () => "file:///tmp/prismo-extension" },
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

  for (const id of ["prismo.signIn", "prismo.signInWithKey", "prismo.signOut", "prismo.openDashboard", "prismo.syncNow", "prismo.copyShieldCommand", "prismo.upgrade"]) {
    assert.equal(typeof record.commands[id], "function", `command ${id} should be registered`);
  }
  assert.ok(record.statusBar, "status bar item should be created");
  assert.ok(record.shown, "status bar should be shown");
  assert.ok(record.uriHandler && typeof record.uriHandler.handleUri === "function", "URI handler should be registered");
  ext.deactivate();
});

test("webview uses the packaged Prismo logo and repo-aware panel", async () => {
  const record = { commands: {} };
  const ext = loadExtensionWithMock(record);
  const ctx = fakeContext();
  await ext.activate(ctx);

  const messages = [];
  const mockWebview = {
    options: undefined,
    html: "",
    cspSource: "vscode-webview:",
    asWebviewUri: (uri) => `vscode-resource:${uri.fsPath || uri.toString()}`,
    onDidReceiveMessage: () => ({ dispose() {} }),
    postMessage: async (message) => { messages.push(message); return true; },
  };

  record.viewProvider.provider.resolveWebviewView({ webview: mockWebview });

  assert.match(mockWebview.html, /<img src="[^"]*media\/icon\.png" alt="Prismo"/);
  assert.match(mockWebview.html, /Copy shield command/);
  assert.deepEqual(mockWebview.options.localResourceRoots[0].fsPath, "/tmp/prismo-extension/media");
  ext.deactivate();
});

test("parseAuthCallback handles Cursor folding query into the path", () => {
  const record = { commands: {} };
  const ext = loadExtensionWithMock(record);
  // Cursor delivers: path "/auth?state=GOOD", query "windowId=1&token=tok_x".
  const parsed = ext.parseAuthCallback({ path: "/auth?state=GOOD", query: "windowId=1&token=tok_x&email=dev%40getprismo.dev" });
  assert.deepEqual(parsed, { token: "tok_x", state: "GOOD", email: "dev@getprismo.dev" });

  // Clean VS Code form still works, and a non-/auth path is ignored.
  assert.deepEqual(ext.parseAuthCallback({ path: "/auth", query: "token=t2&state=s2" }), { token: "t2", state: "s2", email: null });
  assert.equal(ext.parseAuthCallback({ path: "/other", query: "token=t" }), null);
  assert.equal(ext.parseAuthCallback({ path: "/auth", query: "state=s" }), null);
});

test("URI callback stores the connected account email", async () => {
  const record = { commands: {} };
  const ext = loadExtensionWithMock(record);
  const ctx = fakeContext();
  await ext.activate(ctx);

  await record.uriHandler.handleUri({ path: "/auth", query: "token=tok_real&email=dev%40getprismo.dev" });

  assert.equal(ctx._store.get("prismo.deviceToken"), "tok_real");
  assert.equal(ctx._store.get("prismo.accountEmail"), "dev@getprismo.dev");
  assert.match(record.statusBar.tooltip, /Connected as dev@getprismo\.dev/);
  ext.deactivate();
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
  ext.deactivate();
});
