import * as vscode from "vscode";
import * as os from "os";

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

let statusBar: vscode.StatusBarItem;
let syncTimer: ReturnType<typeof setInterval> | undefined;
let lastWastePercent: number | undefined;

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
    statusBar.text = lastWastePercent !== undefined ? `$(pulse) Prismo · ${lastWastePercent}% waste` : "$(pulse) Prismo";
    statusBar.tooltip = "Prismo is watching your AI coding agents. Click to open the dashboard.";
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
  try {
    const result = await prismoScan.runSync(rootDir, {
      config: { token, apiUrl: apiBase },
      allRepos: true,
      source: "extension",
    });
    if (result.error === "not-connected") {
      if (!opts.silent) vscode.window.showWarningMessage("Prismo: this token isn't valid. Sign in again.");
      return;
    }
    if (typeof result.aggregate?.wastePercent === "number") {
      lastWastePercent = result.aggregate.wastePercent;
      await updateStatusBar(context);
    }
    if (!opts.silent) {
      vscode.window.showInformationMessage(
        result.skipped ? "Prismo: already up to date." : "Prismo: synced your agent sessions.",
      );
    }
  } catch (err) {
    if (!opts.silent) {
      vscode.window.showErrorMessage(`Prismo sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
