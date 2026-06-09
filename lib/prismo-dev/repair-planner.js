module.exports = function createRepairPlanner(deps) {
  const {
    fs,
    path,
    NPX_COMMAND,
    getUsageSummary,
    estimateWaste,
    repairExecutors,
  } = deps;

  // Decision thresholds. Verdict math mirrors the backend's
  // _measure_repair_impact (14-day baseline, >=2 post-repair sessions,
  // 0.01 waste-rate epsilon) so local and cloud verdicts agree.
  const DEFAULTS = {
    sessionLimit: 10,
    minWastedTokens: 15000,
    minWasteRate: 0.05,
    cooldownMs: 6 * 60 * 60 * 1000,
    minSessionsToJudge: 2,
    baselineDays: 14,
    rateEpsilon: 0.01,
    historyLimit: 20,
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function statePath(root) {
    return path.join(root, ".prismo", "repair-state.json");
  }

  function readState(root) {
    try {
      const raw = fs.readFileSync(statePath(root), "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? { causes: {}, history: [], ...parsed } : { causes: {}, history: [] };
    } catch {
      return { causes: {}, history: [] };
    }
  }

  function writeState(root, state) {
    const filePath = statePath(root);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  function sessionStamp(session) {
    const value = session.updatedAt || session.startedAt || null;
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }

  function analyzeSessions(root, options = {}) {
    let sessions = [];
    try {
      const summary = getUsageSummary({ tool: "all", cwd: root, limit: options.sessionLimit || DEFAULTS.sessionLimit });
      sessions = summary.sessions || [];
    } catch {
      sessions = [];
    }
    return sessions
      .map((session) => {
        const stamp = sessionStamp(session);
        if (stamp === null) return null;
        const waste = estimateWaste(session);
        return {
          stamp,
          tokens: Number(waste.tokens || 0),
          wastedTokens: Number(waste.wastedTokens || 0),
          topCause: waste.topCause,
        };
      })
      .filter(Boolean);
  }

  function scoreCauses(analyzed) {
    const totals = new Map();
    let observedTokens = 0;
    for (const session of analyzed) {
      observedTokens += session.tokens;
      if (!session.topCause || session.topCause === "low-signal") continue;
      const entry = totals.get(session.topCause) || { cause: session.topCause, wastedTokens: 0, sessions: 0 };
      entry.wastedTokens += session.wastedTokens;
      entry.sessions += 1;
      totals.set(session.topCause, entry);
    }
    return Array.from(totals.values())
      .map((entry) => ({
        ...entry,
        wasteRate: observedTokens > 0 ? Math.round((entry.wastedTokens / observedTokens) * 10000) / 10000 : 0,
      }))
      .sort((a, b) => b.wastedTokens - a.wastedTokens);
  }

  // Local mirror of the backend's repair verification: compare the cause's
  // waste rate in sessions before vs. after the last repair.
  function judgeRepair(cause, repairedAtMs, analyzed, config) {
    const baselineStart = repairedAtMs - config.baselineDays * 24 * 60 * 60 * 1000;
    const before = analyzed.filter((s) => s.stamp <= repairedAtMs && s.stamp >= baselineStart);
    const after = analyzed.filter((s) => s.stamp > repairedAtMs);

    const causeWasted = (group) => group.reduce((sum, s) => sum + (s.topCause === cause ? s.wastedTokens : 0), 0);
    const observed = (group) => group.reduce((sum, s) => sum + s.tokens, 0);

    const observedAfter = observed(after);
    const observedBefore = observed(before);
    const verdict = {
      cause,
      sessionsBefore: before.length,
      sessionsAfter: after.length,
      wasteRateBefore: observedBefore > 0 ? Math.round((causeWasted(before) / observedBefore) * 10000) / 10000 : null,
      wasteRateAfter: observedAfter > 0 ? Math.round((causeWasted(after) / observedAfter) * 10000) / 10000 : null,
      status: "measuring",
      judgedAt: nowIso(),
    };
    if (after.length < config.minSessionsToJudge || observedAfter <= 0) return verdict;
    if (!before.length || observedBefore <= 0) {
      verdict.status = "no-baseline";
      return verdict;
    }
    const delta = verdict.wasteRateBefore - verdict.wasteRateAfter;
    if (delta > config.rateEpsilon) verdict.status = "improved";
    else if (delta < -config.rateEpsilon) verdict.status = "regressed";
    else verdict.status = "no-change";
    return verdict;
  }

  // Decide what (if anything) to repair next. Pure read: does not execute
  // or modify state, so observe/suggest modes can call it safely.
  function plan(root, options = {}) {
    const config = { ...DEFAULTS, ...options };
    const analyzed = analyzeSessions(root, config);
    const causes = scoreCauses(analyzed);
    const state = readState(root);
    const now = Date.now();
    const skipped = [];
    let decision = null;

    for (const scored of causes) {
      if (scored.wastedTokens < config.minWastedTokens || scored.wasteRate < config.minWasteRate) {
        skipped.push({ cause: scored.cause, reason: "below-threshold" });
        continue;
      }
      if (!repairExecutors.forCause(scored.cause)) {
        skipped.push({ cause: scored.cause, reason: "no-executor" });
        continue;
      }
      const entry = state.causes[scored.cause] || null;
      let verdict = null;
      let tier = "mild";
      if (entry && entry.lastRepairAt) {
        const repairedAtMs = Date.parse(entry.lastRepairAt);
        if (Number.isFinite(repairedAtMs)) {
          if (now - repairedAtMs < config.cooldownMs) {
            skipped.push({ cause: scored.cause, reason: "cooldown" });
            continue;
          }
          verdict = judgeRepair(scored.cause, repairedAtMs, analyzed, config);
          if (verdict.status === "measuring") {
            skipped.push({ cause: scored.cause, reason: "measuring", verdict });
            continue;
          }
          if (verdict.status === "no-change" || verdict.status === "regressed") {
            if (entry.lastTier === "aggressive") {
              // Both tiers tried without improvement; stop auto-repairing
              // this cause until a human looks at it or sessions change.
              skipped.push({ cause: scored.cause, reason: "needs-review", verdict });
              continue;
            }
            tier = "aggressive";
          }
        }
      }
      if (!decision) {
        decision = {
          cause: scored.cause,
          tier,
          wastedTokens: scored.wastedTokens,
          wasteRate: scored.wasteRate,
          previousVerdict: verdict ? verdict.status : null,
          reason: verdict && tier === "aggressive"
            ? `Last ${entry.lastTier} repair came back ${verdict.status}; escalating to aggressive.`
            : `${scored.cause} is the top waste cause (${scored.wastedTokens.toLocaleString()} tokens, ${(scored.wasteRate * 100).toFixed(1)}% of observed).`,
        };
      } else {
        skipped.push({ cause: scored.cause, reason: "lower-priority" });
      }
    }

    return {
      generatedAt: nowIso(),
      sessionsAnalyzed: analyzed.length,
      causes,
      decision,
      skipped,
    };
  }

  async function runPlannerOnce(rootDir = process.cwd(), options = {}) {
    const root = path.resolve(rootDir);
    const config = { ...DEFAULTS, ...options };
    const planResult = plan(root, config);
    const report = {
      schemaVersion: 1,
      command: "repair-planner",
      ...planResult,
      executed: false,
      outcome: null,
    };
    if (!planResult.decision || options.execute === false) return report;

    const { cause, tier } = planResult.decision;
    const executor = repairExecutors.forCause(cause);
    const action = {
      id: null,
      actionType: "repair",
      command: `${NPX_COMMAND} repair ${cause}`,
      label: `Auto-repair ${cause} (${tier})`,
      targetCause: cause,
    };
    let outcome;
    try {
      outcome = await executor(action, root, { options: { ...options, tier } });
    } catch (error) {
      outcome = {
        status: "failed",
        statusMessage: `Repair executor failed: ${error && error.message ? error.message : String(error)}`,
        result: null,
      };
    }

    const state = readState(root);
    const previous = state.causes[cause] || { attempts: 0 };
    state.causes[cause] = {
      ...previous,
      lastRepairAt: nowIso(),
      lastTier: tier,
      lastStatus: outcome.status,
      attempts: Number(previous.attempts || 0) + 1,
      lastVerdict: planResult.decision.previousVerdict || previous.lastVerdict || null,
    };
    state.history = [
      { at: nowIso(), cause, tier, status: outcome.status, wastedTokens: planResult.decision.wastedTokens },
      ...(state.history || []),
    ].slice(0, config.historyLimit);
    writeState(root, state);

    report.executed = outcome.status === "completed";
    report.outcome = {
      status: outcome.status,
      statusMessage: outcome.statusMessage,
      tier,
      generatedFiles: (outcome.result && outcome.result.generatedFiles) || [],
    };
    return report;
  }

  function renderPlannerTerminal(report) {
    const lines = [];
    lines.push("");
    lines.push("PrismoDev Repair Planner");
    lines.push("");
    lines.push(`Sessions analyzed: ${report.sessionsAnalyzed}`);
    if (report.causes.length) {
      lines.push("");
      lines.push("Waste causes:");
      report.causes.forEach((entry) => {
        lines.push(`- ${entry.cause}: ${entry.wastedTokens.toLocaleString()} tokens (${(entry.wasteRate * 100).toFixed(1)}% of observed, ${entry.sessions} session(s))`);
      });
    } else {
      lines.push("No attributable waste causes in recent sessions.");
    }
    if (report.decision) {
      lines.push("");
      lines.push(`Decision: repair ${report.decision.cause} (${report.decision.tier} tier)`);
      lines.push(`Why: ${report.decision.reason}`);
    } else {
      lines.push("");
      lines.push("Decision: nothing to repair right now.");
    }
    if (report.skipped.length) {
      lines.push("");
      lines.push("Held back:");
      report.skipped.forEach((item) => lines.push(`- ${item.cause}: ${item.reason}`));
    }
    if (report.outcome) {
      lines.push("");
      lines.push(`Repair: ${report.outcome.status}`);
      if (report.outcome.statusMessage) lines.push(report.outcome.statusMessage);
    } else if (report.decision && !report.executed) {
      lines.push("");
      lines.push(`Not executed (planning only). Run: ${NPX_COMMAND} repair ${report.decision.cause}`);
    }
    return lines.join("\n");
  }

  return {
    DEFAULTS,
    judgeRepair,
    plan,
    readState,
    renderPlannerTerminal,
    runPlannerOnce,
  };
};
