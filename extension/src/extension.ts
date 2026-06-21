import * as vscode from "vscode";

const TOKEN_KEY = "prismo.deviceToken";

let statusBar: vscode.StatusBarItem;
let syncTimer: ReturnType<typeof setInterval> | undefined;

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

async function updateStatusBar(context: vscode.ExtensionContext) {
  const token = await getToken(context);
  if (token) {
    statusBar.text = "$(pulse) Prismo";
    statusBar.tooltip = "Prismo is watching your AI coding agents. Click to open the dashboard.";
    statusBar.command = "prismo.openDashboard";
  } else {
    statusBar.text = "$(plug) Prismo: Sign in";
    statusBar.tooltip = "Connect this editor to Prismo to measure AI agent waste.";
    statusBar.command = "prismo.signIn";
  }
  statusBar.show();
}

// Phase 3 fills this in by reusing lib/prismo-dev/cloud-sync (read local agent
// files → build payload → POST /v1/dev/workspace/sessions/sync with the token).
async function runSync(context: vscode.ExtensionContext, opts: { silent?: boolean } = {}) {
  const token = await getToken(context);
  if (!token) {
    if (!opts.silent) vscode.window.showInformationMessage("Sign in to Prismo first.");
    return;
  }
  // TODO(phase3): const payload = buildSyncPayload(...); await post(apiBase + '/v1/dev/workspace/sessions/sync', token, payload)
  if (!opts.silent) vscode.window.showInformationMessage("Prismo: sync wired in Phase 3.");
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
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("prismo.signIn", async () => {
      // Phase 2 replaces this with a browser sign-in + vscode:// redirect that
      // returns a scoped device token. For now, accept a pasted API key.
      const token = await vscode.window.showInputBox({
        prompt: "Paste your Prismo API key",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "pris_…",
      });
      if (!token) return;
      await context.secrets.store(TOKEN_KEY, token.trim());
      await updateStatusBar(context);
      startSyncTimer(context);
      void runSync(context, { silent: true });
      vscode.window.showInformationMessage("Prismo connected. Your agent sessions will sync automatically.");
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

    vscode.commands.registerCommand("prismo.syncNow", () => runSync(context)),
  );

  await updateStatusBar(context);
  if (await getToken(context)) startSyncTimer(context);
}

export function deactivate() {
  stopSyncTimer();
}
