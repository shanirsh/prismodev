module.exports = function createCursorSessions(deps) {
  const { fs, os, path, estimateTokens } = deps;

  function getCursorHome() {
    return process.env.PRISMO_CURSOR_HOME || path.join(os.homedir(), ".cursor");
  }
  function getCursorAppSupport() {
    return process.env.PRISMO_CURSOR_APP_SUPPORT || path.join(os.homedir(), "Library", "Application Support", "Cursor");
  }
  function getAiTrackingDbPath() {
    return path.join(getCursorHome(), "ai-tracking", "ai-code-tracking.db");
  }
  function getGlobalStateDbPath() {
    return path.join(getCursorAppSupport(), "User", "globalStorage", "state.vscdb");
  }
  function getIdeStatePath() {
    return path.join(getCursorHome(), "ide_state.json");
  }

  let sqlite3Available = null;
  let spawnSyncFn = null;

  function getSpawnSync() {
    if (!spawnSyncFn) {
      spawnSyncFn = require("child_process").spawnSync;
    }
    return spawnSyncFn;
  }

  function isSqlite3Available() {
    if (sqlite3Available !== null) return sqlite3Available;
    try {
      const result = getSpawnSync()("sqlite3", ["--version"], { timeout: 3000, stdio: "pipe" });
      sqlite3Available = result.status === 0;
    } catch {
      sqlite3Available = false;
    }
    return sqlite3Available;
  }

  function querySqlite(dbPath, sql) {
    if (!isSqlite3Available()) return [];
    if (!fs.existsSync(dbPath)) return [];
    try {
      const result = getSpawnSync()("sqlite3", ["-json", dbPath, sql], {
        timeout: 10000,
        stdio: "pipe",
        maxBuffer: 8 * 1024 * 1024,
      });
      if (result.status !== 0) return [];
      const output = (result.stdout || "").toString().trim();
      if (!output) return [];
      return JSON.parse(output);
    } catch {
      return [];
    }
  }

  function querySqliteCsv(dbPath, sql) {
    if (!isSqlite3Available()) return [];
    if (!fs.existsSync(dbPath)) return [];
    try {
      const result = getSpawnSync()("sqlite3", ["-header", "-csv", dbPath, sql], {
        timeout: 10000,
        stdio: "pipe",
        maxBuffer: 8 * 1024 * 1024,
      });
      if (result.status !== 0) return [];
      const output = (result.stdout || "").toString().trim();
      if (!output) return [];
      const lines = output.split(/\r?\n/);
      if (lines.length < 2) return [];
      const headers = parseCsvLine(lines[0]);
      return lines.slice(1).map((line) => {
        const values = parseCsvLine(line);
        const row = {};
        headers.forEach((header, i) => { row[header] = values[i] || ""; });
        return row;
      });
    } catch {
      return [];
    }
  }

  function parseCsvLine(line) {
    const values = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        values.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    values.push(current);
    return values;
  }

  function queryDb(dbPath, sql) {
    const rows = querySqlite(dbPath, sql);
    if (rows.length) return rows;
    return querySqliteCsv(dbPath, sql);
  }

  function getCursorScoredCommits(limit = 50) {
    const sql = `SELECT branchName, commitHash, commitMessage, commitDate,
      linesAdded, linesDeleted, tabLinesAdded, tabLinesDeleted,
      composerLinesAdded, composerLinesDeleted,
      humanLinesAdded, humanLinesDeleted,
      blankLinesAdded, blankLinesDeleted,
      v1AiPercentage, v2AiPercentage, scoredAt
      FROM scored_commits ORDER BY scoredAt DESC LIMIT ${limit}`;
    return queryDb(getAiTrackingDbPath(), sql).map((row) => ({
      branchName: row.branchName || "",
      commitHash: row.commitHash || "",
      commitMessage: row.commitMessage || "",
      commitDate: row.commitDate || "",
      linesAdded: Number(row.linesAdded) || 0,
      linesDeleted: Number(row.linesDeleted) || 0,
      tabLinesAdded: Number(row.tabLinesAdded) || 0,
      tabLinesDeleted: Number(row.tabLinesDeleted) || 0,
      composerLinesAdded: Number(row.composerLinesAdded) || 0,
      composerLinesDeleted: Number(row.composerLinesDeleted) || 0,
      humanLinesAdded: Number(row.humanLinesAdded) || 0,
      humanLinesDeleted: Number(row.humanLinesDeleted) || 0,
      blankLinesAdded: Number(row.blankLinesAdded) || 0,
      blankLinesDeleted: Number(row.blankLinesDeleted) || 0,
      v1AiPercentage: row.v1AiPercentage || "",
      v2AiPercentage: row.v2AiPercentage || "",
      scoredAt: Number(row.scoredAt) || 0,
    }));
  }

  function getCursorAiCodeHashes(limit = 100) {
    const sql = `SELECT hash, source, fileExtension, fileName, requestId,
      conversationId, timestamp, model, createdAt
      FROM ai_code_hashes ORDER BY createdAt DESC LIMIT ${limit}`;
    return queryDb(getAiTrackingDbPath(), sql).map((row) => ({
      hash: row.hash || "",
      source: row.source || "",
      fileExtension: row.fileExtension || "",
      fileName: row.fileName || "",
      requestId: row.requestId || "",
      conversationId: row.conversationId || "",
      timestamp: Number(row.timestamp) || 0,
      model: row.model || "",
      createdAt: Number(row.createdAt) || 0,
    }));
  }

  function getCursorConversationSummaries(limit = 50) {
    const sql = `SELECT conversationId, title, tldr, overview, summaryBullets,
      model, mode, updatedAt
      FROM conversation_summaries ORDER BY updatedAt DESC LIMIT ${limit}`;
    return queryDb(getAiTrackingDbPath(), sql).map((row) => ({
      conversationId: row.conversationId || "",
      title: row.title || "",
      tldr: row.tldr || "",
      overview: row.overview || "",
      summaryBullets: row.summaryBullets || "",
      model: row.model || "",
      mode: row.mode || "",
      updatedAt: Number(row.updatedAt) || 0,
    }));
  }

  function getCursorTrackedFileContent(limit = 50) {
    const sql = `SELECT gitPath, conversationId, model, fileExtension, createdAt,
      length(content) as contentLength
      FROM tracked_file_content ORDER BY createdAt DESC LIMIT ${limit}`;
    return queryDb(getAiTrackingDbPath(), sql).map((row) => ({
      gitPath: row.gitPath || "",
      conversationId: row.conversationId || "",
      model: row.model || "",
      fileExtension: row.fileExtension || "",
      createdAt: Number(row.createdAt) || 0,
      contentLength: Number(row.contentLength) || 0,
    }));
  }

  function getCursorDeletedFiles(limit = 50) {
    const sql = `SELECT gitPath, composerId, conversationId, model, deletedAt
      FROM ai_deleted_files ORDER BY deletedAt DESC LIMIT ${limit}`;
    return queryDb(getAiTrackingDbPath(), sql).map((row) => ({
      gitPath: row.gitPath || "",
      composerId: row.composerId || "",
      conversationId: row.conversationId || "",
      model: row.model || "",
      deletedAt: Number(row.deletedAt) || 0,
    }));
  }

  function getCursorComposerHeaders() {
    const rows = queryDb(getGlobalStateDbPath(),
      "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'");
    if (!rows.length) return [];
    try {
      const raw = rows[0].value || rows[0];
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      return (data.allComposers || []).map((c) => ({
        composerId: c.composerId || "",
        createdAt: Number(c.createdAt) || 0,
        mode: c.unifiedMode || c.forceMode || "",
        linesAdded: Number(c.totalLinesAdded) || 0,
        linesRemoved: Number(c.totalLinesRemoved) || 0,
        isArchived: Boolean(c.isArchived),
        isDraft: Boolean(c.isDraft),
        isWorktree: Boolean(c.isWorktree),
        isSpec: Boolean(c.isSpec),
        numSubComposers: Number(c.numSubComposers) || 0,
        workspaceId: c.workspaceIdentifier?.id || "",
      }));
    } catch {
      return [];
    }
  }

  function getCursorWorkspaceForProject(projectPath) {
    const wsDir = path.join(getCursorAppSupport(), "User", "workspaceStorage");
    if (!fs.existsSync(wsDir)) return null;
    try {
      const entries = fs.readdirSync(wsDir);
      for (const entry of entries) {
        const wsJson = path.join(wsDir, entry, "workspace.json");
        if (!fs.existsSync(wsJson)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(wsJson, "utf8"));
          const folder = decodeURIComponent((data.folder || "").replace("file://", ""));
          if (folder && path.resolve(folder) === path.resolve(projectPath)) {
            return { workspaceId: entry, folder };
          }
        } catch {
          continue;
        }
      }
    } catch {
      // workspace dir not readable
    }
    return null;
  }

  function getCursorIdeState() {
    if (!fs.existsSync(getIdeStatePath())) return null;
    try {
      return JSON.parse(fs.readFileSync(getIdeStatePath(), "utf8"));
    } catch {
      return null;
    }
  }

  function getAiTrackingDbStats() {
    if (!fs.existsSync(getAiTrackingDbPath())) return null;
    const counts = {};
    const tables = ["ai_code_hashes", "conversation_summaries", "scored_commits", "tracked_file_content", "ai_deleted_files"];
    for (const table of tables) {
      const rows = queryDb(getAiTrackingDbPath(), `SELECT COUNT(*) as count FROM ${table}`);
      counts[table] = rows.length ? Number(rows[0].count) || 0 : 0;
    }
    return counts;
  }

  function analyzeCursorSessions(options = {}) {
    const limit = options.limit || 20;
    const cwd = options.cwd || process.cwd();

    const composers = getCursorComposerHeaders();
    const summaries = getCursorConversationSummaries(limit);
    const scoredCommits = getCursorScoredCommits(limit);
    const aiHashes = getCursorAiCodeHashes(limit);
    const trackedFiles = getCursorTrackedFileContent(limit);
    const deletedFiles = getCursorDeletedFiles(limit);
    const dbStats = getAiTrackingDbStats();
    const workspace = getCursorWorkspaceForProject(cwd);

    const summaryMap = new Map();
    for (const s of summaries) {
      summaryMap.set(s.conversationId, s);
    }

    const sessions = composers
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((composer) => {
        const summary = summaryMap.get(composer.composerId);
        return {
          tool: "cursor",
          sessionId: composer.composerId,
          title: summary?.title || "",
          tldr: summary?.tldr || "",
          model: summary?.model || "",
          mode: composer.mode || summary?.mode || "",
          createdAt: composer.createdAt ? new Date(composer.createdAt).toISOString() : null,
          updatedAt: summary?.updatedAt ? new Date(summary.updatedAt).toISOString() : null,
          linesAdded: composer.linesAdded,
          linesRemoved: composer.linesRemoved,
          isArchived: composer.isArchived,
          isDraft: composer.isDraft,
          isWorktree: composer.isWorktree,
          numSubComposers: composer.numSubComposers,
          workspaceId: composer.workspaceId,
          confidence: "cursor-metadata",
        };
      });

    const totalLinesAdded = scoredCommits.reduce((sum, c) => sum + c.linesAdded, 0);
    const totalComposerLinesAdded = scoredCommits.reduce((sum, c) => sum + c.composerLinesAdded, 0);
    const totalTabLinesAdded = scoredCommits.reduce((sum, c) => sum + c.tabLinesAdded, 0);
    const totalHumanLinesAdded = scoredCommits.reduce((sum, c) => sum + c.humanLinesAdded, 0);
    const aiLinesAdded = totalComposerLinesAdded + totalTabLinesAdded;
    const aiAuthorshipPercent = totalLinesAdded > 0 ? Math.round((aiLinesAdded / totalLinesAdded) * 100) : 0;

    const modelDistribution = {};
    for (const h of aiHashes) {
      if (h.model) modelDistribution[h.model] = (modelDistribution[h.model] || 0) + 1;
    }
    const modeDistribution = {};
    for (const c of composers) {
      if (c.mode) modeDistribution[c.mode] = (modeDistribution[c.mode] || 0) + 1;
    }

    const aiGeneratedFiles = trackedFiles.map((f) => ({
      gitPath: f.gitPath,
      model: f.model,
      contentLength: f.contentLength,
      estimatedTokens: estimateTokens(f.contentLength),
      createdAt: f.createdAt ? new Date(f.createdAt).toISOString() : null,
    }));

    const aiDeletedFileList = deletedFiles.map((f) => ({
      gitPath: f.gitPath,
      model: f.model,
      deletedAt: f.deletedAt ? new Date(f.deletedAt).toISOString() : null,
    }));

    return {
      generatedAt: new Date().toISOString(),
      scannedPath: cwd,
      tool: "cursor",
      dbAvailable: fs.existsSync(getAiTrackingDbPath()),
      sqlite3Available: isSqlite3Available(),
      dbStats,
      workspace,
      sessions,
      scoredCommits: scoredCommits.map((c) => ({
        ...c,
        scoredAt: c.scoredAt ? new Date(c.scoredAt).toISOString() : null,
      })),
      aiAuthorship: {
        totalCommits: scoredCommits.length,
        totalLinesAdded,
        aiLinesAdded,
        humanLinesAdded: totalHumanLinesAdded,
        composerLinesAdded: totalComposerLinesAdded,
        tabLinesAdded: totalTabLinesAdded,
        aiAuthorshipPercent,
      },
      aiGeneratedFiles,
      aiDeletedFiles: aiDeletedFileList,
      modelDistribution,
      modeDistribution,
      totalSessions: composers.length,
      activeSessions: composers.filter((c) => !c.isArchived).length,
    };
  }

  function buildCursorSessionTimeline(cursorData) {
    const events = [];

    for (const commit of (cursorData.scoredCommits || []).slice(0, 10)) {
      const aiLines = (commit.composerLinesAdded || 0) + (commit.tabLinesAdded || 0);
      const totalLines = commit.linesAdded || 0;
      const pct = totalLines > 0 ? Math.round((aiLines / totalLines) * 100) : 0;
      if (totalLines > 0) {
        events.push({
          timestamp: commit.scoredAt || commit.commitDate || null,
          type: pct >= 80 ? "high-ai-authorship" : pct >= 40 ? "mixed-authorship" : "human-authorship",
          label: `Commit: ${(commit.commitMessage || commit.commitHash || "").slice(0, 60)}`,
          detail: `+${totalLines}/-${commit.linesDeleted || 0} lines, ${pct}% AI (composer: ${commit.composerLinesAdded}, tab: ${commit.tabLinesAdded}, human: ${commit.humanLinesAdded})`,
        });
      }
    }

    for (const file of (cursorData.aiGeneratedFiles || []).slice(0, 5)) {
      events.push({
        timestamp: file.createdAt || null,
        type: "ai-generated-file",
        label: `AI-generated file tracked`,
        detail: `${file.gitPath} (${file.model || "unknown model"}, ~${file.estimatedTokens} tokens)`,
      });
    }

    for (const file of (cursorData.aiDeletedFiles || []).slice(0, 5)) {
      events.push({
        timestamp: file.deletedAt || null,
        type: "ai-deleted-file",
        label: `AI-generated file deleted`,
        detail: `${file.gitPath} (${file.model || "unknown model"})`,
      });
    }

    return events.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return ta - tb;
    }).slice(-20);
  }

  function buildCursorDiagnosis(cursorData) {
    const drivers = [];
    const recommendations = [];

    const authorship = cursorData.aiAuthorship || {};
    if (authorship.aiAuthorshipPercent >= 80) {
      drivers.push({
        type: "high-ai-authorship",
        value: `${authorship.aiAuthorshipPercent}%`,
        message: "Most committed code is AI-generated; review coverage may need extra attention.",
      });
    }
    if (authorship.tabLinesAdded > authorship.composerLinesAdded && authorship.tabLinesAdded > 50) {
      drivers.push({
        type: "tab-completion-heavy",
        value: `${authorship.tabLinesAdded} lines`,
        message: "Tab completions contribute more code than composer/agent sessions.",
      });
    }

    const totalSessions = cursorData.totalSessions || 0;
    const activeSessions = cursorData.activeSessions || 0;
    if (totalSessions > 50 && activeSessions > 40) {
      drivers.push({
        type: "session-accumulation",
        value: `${totalSessions} total, ${activeSessions} active`,
        message: "Many non-archived sessions; old context may accumulate.",
      });
      recommendations.push("Archive old Cursor composer sessions to reduce context clutter.");
    }

    const deletedCount = (cursorData.aiDeletedFiles || []).length;
    const generatedCount = (cursorData.aiGeneratedFiles || []).length;
    if (deletedCount > 3) {
      drivers.push({
        type: "ai-churn",
        value: `${deletedCount} files deleted`,
        message: "AI-generated files are being created and deleted, suggesting trial-and-error patterns.",
      });
      recommendations.push("Use context packs and firewall rules to scope AI tasks more precisely.");
    }

    if (generatedCount > 0) {
      recommendations.push("Review AI-generated tracked files — some may be leaking into context.");
    }
    if (authorship.totalCommits > 0) {
      recommendations.push("Use npx getprismo cursor authorship to track AI vs human code ratios over time.");
    }
    if (!recommendations.length) {
      recommendations.push("npx getprismo doctor to optimize repo for Cursor sessions.");
    }

    return {
      drivers: drivers.slice(0, 5),
      recommendations: Array.from(new Set(recommendations)).slice(0, 4),
    };
  }

  function renderCursorTerminal(cursorData, command) {
    const lines = [];
    lines.push("");
    lines.push("Prismo Cursor Sessions");
    lines.push("");

    if (!cursorData.dbAvailable) {
      lines.push("No Cursor AI tracking database found.");
      lines.push("Cursor stores tracking data at ~/.cursor/ai-tracking/ai-code-tracking.db");
      lines.push("Make sure Cursor is installed and has been used at least once.");
      return lines.join("\n");
    }
    if (!cursorData.sqlite3Available) {
      lines.push("sqlite3 command not found. Install sqlite3 to read Cursor tracking data.");
      return lines.join("\n");
    }

    if (command === "list") {
      lines.push(`Total sessions: ${cursorData.totalSessions}  (${cursorData.activeSessions} active)`);
      lines.push(`Mode: ${Object.entries(cursorData.modeDistribution).map(([k, v]) => `${k}: ${v}`).join(", ") || "unknown"}`);
      lines.push("");
      const sessions = cursorData.sessions.slice(0, 15);
      sessions.forEach((session, i) => {
        const title = session.title ? ` "${session.title.slice(0, 50)}"` : "";
        const model = session.model ? `  ${session.model}` : "";
        lines.push(`${i + 1}. [${session.mode || "?"}]${title}${model}`);
        lines.push(`   +${session.linesAdded}/-${session.linesRemoved}  ${session.createdAt || "unknown date"}${session.isArchived ? "  (archived)" : ""}`);
      });
      return lines.join("\n");
    }

    if (command === "authorship") {
      const auth = cursorData.aiAuthorship;
      lines.push("AI Authorship (from Cursor scored commits)");
      lines.push("");
      lines.push(`Commits analyzed: ${auth.totalCommits}`);
      lines.push(`Total lines added: ${auth.totalLinesAdded}`);
      lines.push("");
      lines.push(`  Composer (agent):  ${auth.composerLinesAdded} lines`);
      lines.push(`  Tab completions:   ${auth.tabLinesAdded} lines`);
      lines.push(`  Human:             ${auth.humanLinesAdded} lines`);
      lines.push("--------------------------------------------------");
      lines.push(`  AI authorship:     ${auth.aiAuthorshipPercent}%`);
      lines.push("");
      if (cursorData.scoredCommits.length) {
        lines.push("Recent commits:");
        cursorData.scoredCommits.slice(0, 8).forEach((c) => {
          const aiLines = (c.composerLinesAdded || 0) + (c.tabLinesAdded || 0);
          const pct = c.linesAdded > 0 ? Math.round((aiLines / c.linesAdded) * 100) : 0;
          const msg = (c.commitMessage || c.commitHash || "").slice(0, 50);
          lines.push(`  ${pct}% AI  +${c.linesAdded}/-${c.linesDeleted}  ${msg}`);
        });
      }
      return lines.join("\n");
    }

    if (command === "timeline") {
      const timeline = buildCursorSessionTimeline(cursorData);
      lines.push("Cursor Session Timeline");
      lines.push("");
      if (!timeline.length) {
        lines.push("No timeline events found. Cursor needs scored commits or tracked files for timeline data.");
      } else {
        timeline.forEach((event) => {
          const when = event.timestamp ? new Date(event.timestamp).toLocaleString() : "unknown";
          lines.push(`${when}  [${event.type}]`);
          lines.push(`  ${event.label}`);
          lines.push(`  ${event.detail}`);
          lines.push("");
        });
      }
      const diagnosis = buildCursorDiagnosis(cursorData);
      if (diagnosis.drivers.length) {
        lines.push("Signals:");
        diagnosis.drivers.forEach((d) => lines.push(`- ${d.message}`));
      }
      lines.push("");
      lines.push("Suggested Actions:");
      diagnosis.recommendations.forEach((r) => lines.push(`- ${r}`));
      return lines.join("\n");
    }

    if (command === "files") {
      lines.push("AI-Generated Files (tracked by Cursor)");
      lines.push("");
      if (!cursorData.aiGeneratedFiles.length && !cursorData.aiDeletedFiles.length) {
        lines.push("No AI-generated files tracked yet.");
        return lines.join("\n");
      }
      if (cursorData.aiGeneratedFiles.length) {
        lines.push(`Tracked: ${cursorData.aiGeneratedFiles.length}`);
        cursorData.aiGeneratedFiles.forEach((f) => {
          lines.push(`  ${f.gitPath}  (${f.model || "?"}, ~${f.estimatedTokens} tokens)`);
        });
      }
      if (cursorData.aiDeletedFiles.length) {
        lines.push("");
        lines.push(`Deleted: ${cursorData.aiDeletedFiles.length}`);
        cursorData.aiDeletedFiles.forEach((f) => {
          lines.push(`  ${f.gitPath}  (${f.model || "?"}, ${f.deletedAt || "?"})`);
        });
      }
      return lines.join("\n");
    }

    // Default: summary view
    lines.push(`Sessions: ${cursorData.totalSessions} total (${cursorData.activeSessions} active)`);
    lines.push(`Modes: ${Object.entries(cursorData.modeDistribution).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}`);
    if (Object.keys(cursorData.modelDistribution).length) {
      lines.push(`Models: ${Object.entries(cursorData.modelDistribution).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
    }
    lines.push("");
    const auth = cursorData.aiAuthorship;
    if (auth.totalCommits > 0) {
      lines.push("AI Authorship");
      lines.push(`  ${auth.totalCommits} commits analyzed, ${auth.aiAuthorshipPercent}% AI-authored`);
      lines.push(`  Composer: ${auth.composerLinesAdded}  Tab: ${auth.tabLinesAdded}  Human: ${auth.humanLinesAdded} lines`);
    } else {
      lines.push("AI Authorship: no scored commits found yet");
    }
    lines.push("");

    if (cursorData.aiGeneratedFiles.length) {
      lines.push(`AI-generated files: ${cursorData.aiGeneratedFiles.length} tracked`);
    }
    if (cursorData.aiDeletedFiles.length) {
      lines.push(`AI-deleted files: ${cursorData.aiDeletedFiles.length} (churn)`);
    }
    if (cursorData.dbStats) {
      lines.push("");
      lines.push("Tracking DB:");
      lines.push(`  Code hashes: ${cursorData.dbStats.ai_code_hashes}  Conversations: ${cursorData.dbStats.conversation_summaries}  Commits: ${cursorData.dbStats.scored_commits}`);
    }
    lines.push("");
    const diagnosis = buildCursorDiagnosis(cursorData);
    if (diagnosis.drivers.length) {
      lines.push("Signals:");
      diagnosis.drivers.forEach((d) => lines.push(`- ${d.message}`));
      lines.push("");
    }
    lines.push("Next:");
    diagnosis.recommendations.slice(0, 3).forEach((r) => lines.push(`- ${r}`));
    return lines.join("\n");
  }

  return {
    analyzeCursorSessions,
    buildCursorDiagnosis,
    buildCursorSessionTimeline,
    getAiTrackingDbStats,
    getCursorAiCodeHashes,
    getCursorComposerHeaders,
    getCursorConversationSummaries,
    getCursorDeletedFiles,
    getCursorIdeState,
    getCursorScoredCommits,
    getCursorTrackedFileContent,
    getCursorWorkspaceForProject,
    isSqlite3Available,
    renderCursorTerminal,
  };
};
