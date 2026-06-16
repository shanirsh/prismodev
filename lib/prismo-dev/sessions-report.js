module.exports = function createSessionsReport(deps) {
  const {
    path,
    getUsageSummary,
    estimateWaste,
    formatTokenCount,
  } = deps;

  const CAUSE_LABELS = {
    "tool-output-flood": "Tool-output floods",
    "repeated-file-reads": "Repeated file reads",
    "generated-artifacts": "Generated artifacts",
    "context-loop": "Context loops",
    "long-session-buildup": "Long-session buildup",
    "low-signal": "No strong waste signal",
  };

  const NEXT_ACTION = {
    "tool-output-flood": "Run noisy commands through `prismo shield -- <command>` so output stays out of context.",
    "repeated-file-reads": "Run `prismo repair repeated-file-reads`, then start sessions from .prismo context packs.",
    "generated-artifacts": "Run `prismo repair generated-artifacts` to ignore build output and artifacts.",
    "context-loop": "Run `prismo repair context-loop` and stop retrying failing commands.",
    "long-session-buildup": "Split work at task boundaries; start fresh sessions from `prismo context`.",
    "low-signal": "Nothing urgent. Run `prismo doctor` for a baseline.",
  };

  function repoBasename(session, fallbackRoot) {
    const cwd = session && session.cwd ? session.cwd : fallbackRoot;
    try {
      return path.basename(path.resolve(cwd || process.cwd()));
    } catch {
      return "unknown";
    }
  }

  function collect(rootDir, options = {}) {
    const root = path.resolve(rootDir || process.cwd());
    const summary = getUsageSummary({
      cwd: root,
      tool: options.tool || "all",
      limit: options.limit || 10,
      allRepos: Boolean(options.allRepos),
    });
    const sessions = (summary.sessions || []).map((session) => {
      const waste = estimateWaste(session);
      return {
        tool: session.tool || "unknown",
        repo: repoBasename(session, root),
        title: session.title || null,
        model: session.model || null,
        updatedAt: session.updatedAt || session.startedAt || null,
        risk: session.contextRisk || "Unknown",
        tokens: Number(waste.tokens || 0),
        wastedTokens: Number(waste.wastedTokens || 0),
        wastePercent: Number(waste.wastePercent || 0),
        topCause: waste.topCause || "low-signal",
        repeatedCommands: session.repeatedCommands || [],
        repeatedPaths: session.repeatedPathMentions || [],
        loopSuspicion: Boolean(session.loopSuspicion),
      };
    });
    return { root, sessions, generatedAt: new Date().toISOString() };
  }

  function buildSessionsView(rootDir, options = {}) {
    const { root, sessions, generatedAt } = collect(rootDir, options);
    const totals = sessions.reduce((acc, s) => {
      acc.sessions += 1;
      acc.tokens += s.tokens;
      acc.wastedTokens += s.wastedTokens;
      return acc;
    }, { sessions: 0, tokens: 0, wastedTokens: 0 });
    totals.wastePercent = totals.tokens > 0 ? Math.round((totals.wastedTokens / totals.tokens) * 100) : 0;
    return {
      schemaVersion: 1,
      command: "sessions",
      scannedPath: root,
      allRepos: Boolean(options.allRepos),
      sessions: sessions.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
      totals,
      generatedAt,
    };
  }

  function renderSessionsTerminal(view) {
    const lines = [];
    lines.push("");
    lines.push("PrismoDev Sessions");
    lines.push("");
    if (!view.sessions.length) {
      lines.push("No recent local agent sessions found.");
      lines.push(view.allRepos ? "" : "Tip: add --all-repos to look across every repo on this machine.");
      return lines.join("\n").trimEnd();
    }
    for (const s of view.sessions) {
      const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "unknown time";
      lines.push(`${s.tool.padEnd(12)} ${s.repo}  ·  ${when}`);
      lines.push(`  ${formatTokenCount(s.tokens)} tokens  |  ~${formatTokenCount(s.wastedTokens)} wasted (${s.wastePercent}%)  |  ${s.risk} risk  |  ${CAUSE_LABELS[s.topCause] || s.topCause}`);
    }
    lines.push("");
    lines.push(`Totals: ${view.totals.sessions} session(s)  ·  ${formatTokenCount(view.totals.tokens)} tokens  ·  ~${formatTokenCount(view.totals.wastedTokens)} likely wasted (${view.totals.wastePercent}%)`);
    return lines.join("\n");
  }

  function buildLocalReport(rootDir, options = {}) {
    const { root, sessions, generatedAt } = collect(rootDir, { ...options, allRepos: options.allRepos });
    const observed = sessions.reduce((sum, s) => sum + s.tokens, 0);
    const wasted = sessions.reduce((sum, s) => sum + s.wastedTokens, 0);

    const causeTotals = new Map();
    for (const s of sessions) {
      if (s.topCause === "low-signal") continue;
      causeTotals.set(s.topCause, (causeTotals.get(s.topCause) || 0) + s.wastedTokens);
    }
    const topCauses = Array.from(causeTotals, ([cause, tokens]) => ({
      cause,
      label: CAUSE_LABELS[cause] || cause,
      tokens,
    })).sort((a, b) => b.tokens - a.tokens).slice(0, 5);

    const repeatedReads = aggregate(sessions, (s) => s.repeatedPaths).slice(0, 5);
    const repeatedCommands = aggregate(sessions, (s) => s.repeatedCommands).slice(0, 5);
    const loopSessions = sessions.filter((s) => s.loopSuspicion).length;
    const primaryCause = topCauses[0] ? topCauses[0].cause : "low-signal";

    return {
      schemaVersion: 1,
      command: "report",
      scannedPath: root,
      allRepos: Boolean(options.allRepos),
      sessions: sessions.length,
      observedTokens: observed,
      wastedTokens: wasted,
      wastePercent: observed > 0 ? Math.round((wasted / observed) * 100) : 0,
      topCauses,
      repeatedReads,
      repeatedCommands,
      loopSessions,
      nextAction: NEXT_ACTION[primaryCause] || NEXT_ACTION["low-signal"],
      note: "Local estimate from your own session logs. Connect with `prismo connect` for verified, dollar-denominated savings.",
      generatedAt,
    };
  }

  function aggregate(sessions, pick) {
    const totals = new Map();
    for (const s of sessions) {
      for (const item of pick(s) || []) {
        if (!item || !item.value) continue;
        totals.set(item.value, (totals.get(item.value) || 0) + Number(item.count || 0));
      }
    }
    return Array.from(totals, ([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  }

  function renderLocalReportTerminal(report) {
    const lines = [];
    lines.push("");
    lines.push("PrismoDev Report");
    lines.push("");
    if (!report.sessions) {
      lines.push("No recent local agent sessions found.");
      lines.push(report.allRepos ? "" : "Tip: add --all-repos to look across every repo on this machine.");
      return lines.join("\n").trimEnd();
    }
    lines.push(`Observed: ${formatTokenCount(report.observedTokens)} tokens across ${report.sessions} session(s)`);
    lines.push(`Likely wasted: ${formatTokenCount(report.wastedTokens)} (${report.wastePercent}%)`);
    if (report.loopSessions) lines.push(`Loop-suspect sessions: ${report.loopSessions}`);
    if (report.topCauses.length) {
      lines.push("");
      lines.push("Top causes:");
      report.topCauses.forEach((c) => lines.push(`- ${c.label}: ~${formatTokenCount(c.tokens)} tokens`));
    }
    if (report.repeatedReads.length) {
      lines.push("");
      lines.push("Most repeated reads:");
      report.repeatedReads.forEach((r) => lines.push(`- ${r.value} (${r.count}x)`));
    }
    if (report.repeatedCommands.length) {
      lines.push("");
      lines.push("Most repeated commands:");
      report.repeatedCommands.forEach((r) => lines.push(`- ${r.value} (${r.count}x)`));
    }
    lines.push("");
    lines.push(`Next: ${report.nextAction}`);
    lines.push(report.note);
    return lines.join("\n");
  }

  return {
    buildSessionsView,
    renderSessionsTerminal,
    buildLocalReport,
    renderLocalReportTerminal,
  };
};
