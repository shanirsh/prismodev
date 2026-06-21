import * as vscode from "vscode";
import * as os from "os";
import * as crypto from "crypto";

// Publisher.name — the authority used in the editor callback URI.
const EXTENSION_ID = "prismo.prismo";
let pendingState: string | undefined;

// The CLI's fully-wired sync pipeline (reads local agent sessions, builds the
// payload, posts to the backend). esbuild bundles the whole dependency tree.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const prismoScan: {
  runSync: (
    rootDir: string,
    options: Record<string, unknown>,
  ) => Promise<{
    synced?: boolean;
    skipped?: boolean;
    error?: string;
    aggregate?: { wastePercent?: number; estimatedWastedTokens?: number; displayTokens?: number };
  }>;
} = require("../../lib/prismo-dev-scan");

const TOKEN_KEY = "prismo.deviceToken";

let output: vscode.OutputChannel;
function log(message: string) {
  if (output) output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

// Parse the editor's auth callback defensively. Editors split this URI
// inconsistently — Cursor folds part of the query into the path (e.g.
// "/auth?state=…") and appends its own windowId — so merge every query
// fragment before reading params. Exported for testing.
export function parseAuthCallback(uri: { path: string; query: string }): { token: string; state: string | null } | null {
  const [pathOnly, pathQuery = ""] = (uri.path || "").split("?");
  if (pathOnly !== "/auth") return null;
  const q = new URLSearchParams([pathQuery, uri.query || ""].filter(Boolean).join("&"));
  const token = q.get("token");
  if (!token) return null;
  return { token, state: q.get("state") };
}

let statusBar: vscode.StatusBarItem;
let syncTimer: ReturnType<typeof setInterval> | undefined;
let lastWastePercent: number | undefined;
let lastProjectedPerDev: number | undefined;
let lastPlan: string | undefined;
let isSignedIn = false;
let isSyncing = false;
let lastSyncedAt: number | undefined;
let viewProvider: PrismoViewProvider | undefined;

class PrismoViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg: { command?: string }) => {
      if (msg.command) void vscode.commands.executeCommand(msg.command);
    });
    this.push();
  }

  push() {
    this.view?.webview.postMessage({
      type: "state",
      signedIn: isSignedIn,
      wastePercent: lastWastePercent,
      projectedPerDev: lastProjectedPerDev,
      plan: lastPlan,
      syncing: isSyncing,
      lastSyncedAt: lastSyncedAt,
    });
  }

  private html(): string {
    return `<!doctype html><html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  :root { --accent: #8a5cf6; }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 14px; font-size: 12px; }
  .brand { display:flex; align-items:center; gap:7px; margin-bottom:18px; }
  .brand .dot { width:14px; height:14px; border-radius:4px; background:linear-gradient(135deg,#7cd0ff,#b69cff 55%,#ff9ec8); }
  .brand span { font-weight:600; letter-spacing:.2px; }
  .eyebrow { color: var(--vscode-descriptionForeground); text-transform:uppercase; letter-spacing:.08em; font-size:10px; font-weight:600; }
  .metric { margin: 6px 0 2px; font-size: 40px; font-weight: 650; line-height:1; }
  .metric.high { color:#f0616d; } .metric.mid { color:#e0a23a; } .metric.low { color:#3fb27f; }
  .metriclabel { color: var(--vscode-descriptionForeground); font-size:12px; }
  .projected { margin:14px 0 4px; padding:10px 12px; border:1px solid var(--vscode-panel-border); border-radius:8px; }
  .projected .n { font-size:18px; font-weight:600; }
  .projected .l { color: var(--vscode-descriptionForeground); font-size:11px; margin-top:2px; }
  .actions { margin-top:16px; }
  button { display:flex; align-items:center; justify-content:center; width:100%; margin:7px 0; padding:8px 10px;
    border:none; border-radius:6px; font-size:12px; font-weight:500; cursor:pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity:.6; cursor:default; }
  .upgrade { background: var(--accent) !important; color:#fff !important; }
  .status { margin-top:12px; color: var(--vscode-descriptionForeground); font-size:11px; display:flex; align-items:center; gap:6px; }
  .status .live { width:7px; height:7px; border-radius:50%; background:#3fb27f; }
  .lead { color: var(--vscode-descriptionForeground); line-height:1.5; margin:0 0 16px; }
  .hidden { display:none; }
</style></head><body>
  <div class="brand"><span class="dot"></span><span>Prismo</span></div>

  <div id="signedout">
    <div class="eyebrow">Agent efficiency</div>
    <p class="lead" style="margin-top:8px">See where your AI coding agents waste tokens and money — right here in your editor. No terminal.</p>
    <button onclick="send('prismo.signIn')">Sign in to Prismo</button>
  </div>

  <div id="signedin" class="hidden">
    <div class="eyebrow">Avoidable waste</div>
    <div class="metric" id="waste">—</div>
    <div class="metriclabel">of your agent tokens</div>

    <div class="projected hidden" id="projbox">
      <div class="n" id="projn"></div>
      <div class="l">projected per developer, at this rate</div>
    </div>

    <div class="actions">
      <button onclick="send('prismo.openDashboard')">Open dashboard</button>
      <button class="secondary" id="syncbtn" onclick="send('prismo.syncNow')">Sync now</button>
      <button class="upgrade hidden" id="upgrade" onclick="send('prismo.upgrade')">Upgrade for team metrics</button>
      <button class="secondary" onclick="send('prismo.signOut')">Sign out</button>
    </div>

    <div class="status"><span class="live"></span><span id="status">Connected</span></div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  function send(command){ vscode.postMessage({ command }); }
  function ago(ts){ if(!ts) return ''; const s=Math.round((Date.now()-ts)/1000);
    if(s<10) return 'just now'; if(s<60) return s+'s ago'; const m=Math.round(s/60); if(m<60) return m+'m ago'; return Math.round(m/60)+'h ago'; }
  window.addEventListener('message', (e) => {
    const s = e.data; if (s.type !== 'state') return;
    document.getElementById('signedout').classList.toggle('hidden', s.signedIn);
    document.getElementById('signedin').classList.toggle('hidden', !s.signedIn);
    const w = document.getElementById('waste');
    if (s.wastePercent === undefined || s.wastePercent === null) { w.textContent = '—'; w.className='metric'; }
    else { w.textContent = s.wastePercent + '%'; w.className = 'metric ' + (s.wastePercent>=40?'high':s.wastePercent>=20?'mid':'low'); }
    const hasProj = s.projectedPerDev > 0;
    document.getElementById('projbox').classList.toggle('hidden', !hasProj);
    if (hasProj) document.getElementById('projn').textContent = '$' + Math.round(s.projectedPerDev).toLocaleString() + '/yr';
    document.getElementById('upgrade').classList.toggle('hidden', s.plan !== 'free');
    const btn = document.getElementById('syncbtn');
    btn.disabled = !!s.syncing; btn.textContent = s.syncing ? 'Syncing…' : 'Sync now';
    document.getElementById('status').textContent = s.syncing ? 'Syncing…' : (s.lastSyncedAt ? 'Synced ' + ago(s.lastSyncedAt) : 'Connected');
  });
</script>
</body></html>`;
  }
}

function config() {
  const c = vscode.workspace.getConfiguration("prismo");
  return {
    apiBase: c.get<string>("apiBase", "https://api.getprismo.dev"),
    dashboardUrl: c.get<string>("dashboardUrl", "https://getprismo.dev/dashboard/dev"),
    syncIntervalSeconds: Math.max(c.get<number>("syncIntervalSeconds", 300), 60),
  };
}

async function getToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(TOKEN_KEY);
}

function originOf(fallbackPath: string): string {
  try {
    return new URL(config().dashboardUrl).origin + fallbackPath;
  } catch {
    return `https://getprismo.dev${fallbackPath}`;
  }
}

function connectUrl(): string {
  return originOf("/connect/editor");
}

type Digest = {
  plan?: string;
  wastePercent?: number;
  projectedAnnualPerDeveloper?: number;
  verifiedDollarsSaved?: number;
};

async function fetchDigest(apiBase: string, token: string): Promise<Digest | null> {
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, "")}/v1/dev/workspace/digest/agent`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as Digest;
  } catch {
    return null;
  }
}

const NUDGE_SHOWN_KEY = "prismo.upgradeNudgeShown";

// Show the upgrade prompt once, only when there's a real number to motivate it.
async function maybeNudgeUpgrade(context: vscode.ExtensionContext, digest: Digest) {
  if (digest.plan && digest.plan !== "free") return;
  if (!digest.projectedAnnualPerDeveloper || digest.projectedAnnualPerDeveloper <= 0) return;
  if (context.globalState.get<boolean>(NUDGE_SHOWN_KEY)) return;
  await context.globalState.update(NUDGE_SHOWN_KEY, true);
  const annual = `$${Math.round(digest.projectedAnnualPerDeveloper).toLocaleString()}/yr`;
  const choice = await vscode.window.showInformationMessage(
    `Prismo found ~${annual} per developer in avoidable agent spend. Upgrade to see your team's full picture and verified savings.`,
    "Upgrade",
    "Not now",
  );
  if (choice === "Upgrade") {
    await vscode.env.openExternal(vscode.Uri.parse(originOf("/pricing")));
  }
}

async function finalizeToken(context: vscode.ExtensionContext, token: string) {
  await context.secrets.store(TOKEN_KEY, token.trim());
  await updateStatusBar(context);
  startSyncTimer(context);
  void runSync(context, { silent: true });
  vscode.window.showInformationMessage("Prismo connected. Your agent sessions will sync automatically.");
}

// Open the browser to the Prismo sign-in page, which redirects the user's key
// back to this editor via its custom URI scheme (caught by the URI handler).
async function startBrowserSignIn() {
  pendingState = crypto.randomUUID();
  const callback = await vscode.env.asExternalUri(
    vscode.Uri.parse(`${vscode.env.uriScheme}://${EXTENSION_ID}/auth?state=${pendingState}`),
  );
  const url =
    `${connectUrl()}?redirect=${encodeURIComponent(callback.toString(true))}` +
    `&editor=${encodeURIComponent(vscode.env.appName)}`;
  log(`sign-in: callback=${callback.toString(true)}`);
  log(`sign-in: opening ${url}`);
  await vscode.env.openExternal(vscode.Uri.parse(url));
  vscode.window.showInformationMessage("Finish signing in to Prismo in your browser, then return here.");
}

async function updateStatusBar(context: vscode.ExtensionContext) {
  const token = await getToken(context);
  isSignedIn = Boolean(token);
  viewProvider?.push();
  if (token) {
    statusBar.text = lastWastePercent !== undefined ? `$(pulse) Prismo · ${lastWastePercent}% waste` : "$(pulse) Prismo";
    const lines = ["Prismo is watching your AI coding agents."];
    if (lastProjectedPerDev && lastProjectedPerDev > 0) {
      lines.push(`~$${Math.round(lastProjectedPerDev).toLocaleString()}/yr per developer in avoidable spend.`);
    }
    if (lastPlan === "free") lines.push("Free plan — run “Prismo: Upgrade” for team metrics.");
    lines.push("Click to open the dashboard.");
    statusBar.tooltip = lines.join("\n");
    statusBar.command = "prismo.openDashboard";
  } else {
    statusBar.text = "$(plug) Prismo: Sign in";
    statusBar.tooltip = "Connect this editor to Prismo to measure AI agent waste.";
    statusBar.command = "prismo.signIn";
  }
  statusBar.show();
}

// Read the local agent sessions and push aggregate metrics to the backend,
// reusing the CLI's sync pipeline with the editor's stored token.
async function runSync(context: vscode.ExtensionContext, opts: { silent?: boolean } = {}) {
  const token = await getToken(context);
  if (!token) {
    if (!opts.silent) vscode.window.showInformationMessage("Sign in to Prismo first.");
    return;
  }
  const { apiBase } = config();
  const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  log(`sync: starting (apiBase=${apiBase}, root=${rootDir})`);
  isSyncing = true;
  viewProvider?.push();
  try {
    const result = await prismoScan.runSync(rootDir, {
      config: { token, apiUrl: apiBase },
      allRepos: true,
      source: "extension",
    });
    log(`sync: result synced=${result.synced} skipped=${!!result.skipped} error=${result.error || "none"} waste=${result.aggregate?.wastePercent}`);
    if (result.error === "not-connected") {
      if (!opts.silent) vscode.window.showWarningMessage("Prismo: this token isn't valid. Sign in again.");
      return;
    }
    if (typeof result.aggregate?.wastePercent === "number") {
      lastWastePercent = result.aggregate.wastePercent;
    }
    // Pull the org-level digest for plan + the projected number we surface.
    const digest = await fetchDigest(apiBase, token);
    if (digest) {
      if (typeof digest.wastePercent === "number") lastWastePercent = digest.wastePercent;
      lastProjectedPerDev = digest.projectedAnnualPerDeveloper;
      lastPlan = digest.plan;
      await maybeNudgeUpgrade(context, digest);
    }
    await updateStatusBar(context);
    if (!opts.silent) {
      vscode.window.showInformationMessage(
        result.skipped ? "Prismo: already up to date." : "Prismo: synced your agent sessions.",
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? (err.stack || err.message) : String(err);
    log(`sync: ERROR ${msg}`);
    if (!opts.silent) {
      vscode.window.showErrorMessage(`Prismo sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    isSyncing = false;
    lastSyncedAt = Date.now();
    viewProvider?.push();
  }
}

function startSyncTimer(context: vscode.ExtensionContext) {
  stopSyncTimer();
  const { syncIntervalSeconds } = config();
  syncTimer = setInterval(() => void runSync(context, { silent: true }), syncIntervalSeconds * 1000);
}

function stopSyncTimer() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = undefined;
  }
}

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Prismo");
  context.subscriptions.push(output);
  log(`activated · scheme=${vscode.env.uriScheme} app=${vscode.env.appName}`);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBar);

  viewProvider = new PrismoViewProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("prismo.home", viewProvider));

  // Catch the browser redirect: <scheme>://prismo.prismo/auth?token=…&state=…
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        log(`callback received: path=${uri.path} hasQuery=${Boolean(uri.query)}`);
        const parsed = parseAuthCallback({ path: uri.path, query: uri.query });
        if (!parsed) {
          log("callback: no token after parsing");
          return;
        }
        if (pendingState && parsed.state !== pendingState) {
          log(`callback: state mismatch (got ${parsed.state})`);
          vscode.window.showErrorMessage("Prismo sign-in could not be verified. Please try again.");
          return;
        }
        pendingState = undefined;
        log("callback: token accepted, finalizing");
        await finalizeToken(context, parsed.token);
      },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("prismo.signIn", () => startBrowserSignIn()),

    vscode.commands.registerCommand("prismo.signInWithKey", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "Paste your Prismo API key",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "pris_…",
      });
      if (token) await finalizeToken(context, token);
    }),

    vscode.commands.registerCommand("prismo.signOut", async () => {
      await context.secrets.delete(TOKEN_KEY);
      stopSyncTimer();
      await updateStatusBar(context);
      vscode.window.showInformationMessage("Signed out of Prismo.");
    }),

    vscode.commands.registerCommand("prismo.openDashboard", async () => {
      await vscode.env.openExternal(vscode.Uri.parse(config().dashboardUrl));
    }),

    vscode.commands.registerCommand("prismo.upgrade", async () => {
      await vscode.env.openExternal(vscode.Uri.parse(originOf("/pricing")));
    }),

    vscode.commands.registerCommand("prismo.syncNow", () => runSync(context)),

    vscode.commands.registerCommand("prismo.showLogs", () => output.show()),
  );

  await updateStatusBar(context);
  if (await getToken(context)) startSyncTimer(context);
}

export function deactivate() {
  stopSyncTimer();
}
