module.exports = function createScanScore(deps) {
  const { estimateTokens, formatTokenCount, NPX_COMMAND } = deps;

  const CLAUDE_INSTRUCTION_TOKEN_BASELINE = 800;
  const ASSUMED_TURNS_PER_AI_SESSION = 40;
  const ASSUMED_INPUT_COST_PER_1K_TOKENS = 0.003;
  const ASSUMED_SESSIONS_PER_MONTH = 30;

  function severityWeight(severity) {
    return severity === "critical" ? 10 : severity === "high" ? 6 : severity === "medium" ? 4 : 2;
  }

  function severityRank(severity) {
    return { critical: 0, high: 1, medium: 2, low: 3 }[severity] ?? 4;
  }

  function addIssue(issues, severity, category, title, description, recommendation, estimatedTokenImpact = null) {
    issues.push({
      severity,
      category,
      title,
      description,
      recommendation,
      estimatedTokenImpact,
    });
  }

  function levelFromScore(score) {
    if (score >= 70) return "High";
    if (score >= 35) return "Medium";
    return "Low";
  }

  function addEvidence(evidence, text) {
    if (text && !evidence.includes(text)) evidence.push(text);
  }

  function estimateClaudeInstructionImpact(tokens) {
    if (!tokens || tokens <= CLAUDE_INSTRUCTION_TOKEN_BASELINE) return null;
    const extra = Math.max(0, tokens - CLAUDE_INSTRUCTION_TOKEN_BASELINE);
    const sessionCost = ((extra * ASSUMED_TURNS_PER_AI_SESSION) / 1000) * ASSUMED_INPUT_COST_PER_1K_TOKENS;
    const monthlyCost = sessionCost * ASSUMED_SESSIONS_PER_MONTH;
    return `Estimated baseline cost: ~$${sessionCost.toFixed(2)}/session ($${monthlyCost.toFixed(2)}/month at 1 session/day). ${extra.toLocaleString()} extra tokens may load every turn above the ~${CLAUDE_INSTRUCTION_TOKEN_BASELINE} token baseline.`;
  }

  function estimateLargeFileImpact(files) {
    if (!files.length) return null;
    const totalTokens = files.reduce((sum, file) => sum + estimateTokens(file.size), 0);
    return `Likely avoidable token exposure: up to ~${totalTokens.toLocaleString()} tokens if these files are read into agent context.`;
  }

  function estimateRiskyDirImpact(dirs) {
    if (!dirs.length) return null;
    return "Likely avoidable token exposure: generated/cache directories can create high repo-read risk when agents explore broadly.";
  }

  function estimateMcpImpact(count) {
    if (!count || count < 5) return null;
    return "Possible baseline/tool overhead: many MCP servers can expand tool choice and produce extra tool traffic.";
  }

  function buildRecommendations({ hasClaudeIgnore, gitignorePatterns, exposedHighRiskDirs, largeFiles, instructionFiles, claudeConfig, toolOutputRisk, operationalNoise, agentReadiness }) {
    const recs = [];
    if (!hasClaudeIgnore) {
      recs.push("Create .claudeignore with generated/cache folders and large artifacts excluded.");
    }
    if (gitignorePatterns.length && !hasClaudeIgnore) {
      recs.push("Use .gitignore as the baseline for .claudeignore, then add AI-specific exclusions.");
    }
    if (exposedHighRiskDirs.length) {
      recs.push(`Ignore generated/cache folders: ${exposedHighRiskDirs.slice(0, 8).map((d) => `${d.path}/`).join(", ")}.`);
    }
    if (largeFiles.some((file) => !file.ignored)) {
      recs.push("Avoid loading large logs, JSON dumps, coverage reports, and minified assets into coding-agent context.");
    }
    if (toolOutputRisk && toolOutputRisk.level !== "Low") {
      recs.push("Use command-output filtering or narrower shell commands for noisy tests, logs, diffs, and generated reports.");
    }
    if (operationalNoise && operationalNoise.level !== "Low") {
      recs.push("Keep inbox/calendar/GitHub polling dumps out of coding-agent context; summarize them outside the repo or add them to AI ignore files.");
    }
    if (instructionFiles.some((file) => file.isClaude && file.tokens > 1500)) {
      recs.push("Review CLAUDE.md for content that could move to linked docs; keep persistent instructions focused on durable rules.");
    }
    if (claudeConfig.mcpServers >= 5) {
      recs.push("Disable MCP servers that are not needed for the current project or task.");
    }
    recs.push("Start fresh sessions for unrelated tasks and compact long sessions when context growth accelerates.");
    recs.push("Use cheaper/faster models for mechanical edits, formatting, and low-risk refactors.");
    if (agentReadiness && (agentReadiness.codex.detected || agentReadiness.claudeCode.detected)) {
      recs.push("Run `npx getprismo watch` for local coding-session visibility while working.");
    }
    recs.push("Route API-mode coding tools through Prismo when they support custom OpenAI/Anthropic base URLs for exact cost tracking.");
    return Array.from(new Set(recs));
  }

  function countRepeatedSourceReads(realUsage) {
    if (!realUsage || !Array.isArray(realUsage.sessions)) return 0;
    const generatedPattern = /(^|\/)(node_modules|dist|build|coverage|\.next|__pycache__|logs|test-results|playwright-report)\//;
    return realUsage.sessions.reduce((sum, session) => {
      return sum + (session.repeatedPathMentions || []).filter((item) => {
        const value = String(item.value || "");
        if (!value || generatedPattern.test(value)) return false;
        return /\.(js|jsx|ts|tsx|py|go|rs|java|kt|swift|rb|php|cs|svelte|vue|astro|md|json|toml|yaml|yml)$/i.test(value);
      }).reduce((inner, item) => inner + Number(item.count || 0), 0);
    }, 0);
  }

  function buildOptimizerFit(result) {
    const bottlenecks = [];
    const realUsage = result.realUsage;
    const toolTokens = realUsage ? Number(realUsage.totals.toolTokens || 0) : 0;
    const displayTokens = realUsage ? Number(realUsage.totals.displayTokens || 0) : 0;
    const highRiskSessions = realUsage ? realUsage.sessions.filter((session) => session.contextRisk === "High").length : 0;
    const repeatedSourceReads = countRepeatedSourceReads(realUsage);

    const ignoreEvidence = [];
    let ignoreScore = 0;
    if (!result.hasClaudeIgnore) {
      ignoreScore += 35;
      addEvidence(ignoreEvidence, ".claudeignore is missing");
    }
    if (!result.hasCursorIgnore) {
      ignoreScore += 20;
      addEvidence(ignoreEvidence, ".cursorignore is missing");
    }
    if (result.exposedHighRiskDirs.length) {
      ignoreScore += Math.min(35, result.exposedHighRiskDirs.length * 8);
      addEvidence(ignoreEvidence, `${result.exposedHighRiskDirs.length} generated/cache directories are exposed`);
    }
    if ((result.sessionIgnoreSuggestions || []).length) {
      ignoreScore += 25;
      addEvidence(ignoreEvidence, `${result.sessionIgnoreSuggestions.length} ignore rules came from actual session leaks`);
    }
    bottlenecks.push({
      id: "ignore-cleanup",
      label: "Generated artifacts / ignore cleanup",
      score: Math.min(100, ignoreScore),
      level: levelFromScore(ignoreScore),
      evidence: ignoreEvidence.length ? ignoreEvidence : ["No major ignore-file leak detected"],
    });

    const outputEvidence = [];
    let outputScore = result.toolOutputRisk.level === "High" ? 70 : result.toolOutputRisk.level === "Medium" ? 45 : 10;
    if (toolTokens >= 150000) outputScore += 25;
    else if (toolTokens >= 50000) outputScore += 15;
    if (result.toolOutputRisk.exposedNoisyFiles.length) addEvidence(outputEvidence, `${result.toolOutputRisk.exposedNoisyFiles.length} noisy files are exposed`);
    if (result.toolOutputRisk.exposedNoisyDirectories.length) addEvidence(outputEvidence, `${result.toolOutputRisk.exposedNoisyDirectories.length} noisy directories are exposed`);
    if (toolTokens) addEvidence(outputEvidence, `${formatTokenCount(toolTokens)} tool/output tokens found in local sessions`);
    bottlenecks.push({
      id: "output-sandboxing",
      label: "Oversized command/tool output",
      score: Math.min(100, outputScore),
      level: levelFromScore(outputScore),
      evidence: outputEvidence.length ? outputEvidence : ["No dominant command-output flood detected"],
    });

    const indexEvidence = [];
    let indexScore = 0;
    if (result.stats.sourceFiles >= 1000) indexScore += 35;
    else if (result.stats.sourceFiles >= 250) indexScore += 20;
    if (result.stats.totalFiles >= 5000) indexScore += 25;
    else if (result.stats.totalFiles >= 1000) indexScore += 15;
    if (repeatedSourceReads >= 50) indexScore += 35;
    else if (repeatedSourceReads >= 12) indexScore += 20;
    if (result.stats.sourceFiles >= 250) addEvidence(indexEvidence, `${result.stats.sourceFiles.toLocaleString()} source files`);
    if (repeatedSourceReads) addEvidence(indexEvidence, `${repeatedSourceReads} repeated source-file mentions in local sessions`);
    bottlenecks.push({
      id: "code-indexing",
      label: "Repeated source exploration",
      score: Math.min(100, indexScore),
      level: levelFromScore(indexScore),
      evidence: indexEvidence.length ? indexEvidence : ["Repo/source exploration does not look like the main bottleneck"],
    });

    const instructionEvidence = [];
    const instructionTokens = result.instructionFiles.reduce((sum, file) => sum + Math.max(0, (file.tokens || 0) - 500), 0);
    let instructionScore = instructionTokens >= 3000 ? 80 : instructionTokens >= 1000 ? 55 : instructionTokens > 0 ? 30 : 0;
    result.instructionFiles
      .filter((file) => file.tokens > 500)
      .slice(0, 3)
      .forEach((file) => addEvidence(instructionEvidence, `${file.path} is ~${(file.tokens || 0).toLocaleString()} tokens`));
    bottlenecks.push({
      id: "instruction-trim",
      label: "Persistent instruction bloat",
      score: Math.min(100, instructionScore),
      level: levelFromScore(instructionScore),
      evidence: instructionEvidence.length ? instructionEvidence : ["Persistent instruction files look manageable"],
    });

    const sessionEvidence = [];
    let sessionScore = 0;
    if (displayTokens >= 2000000) sessionScore += 60;
    else if (displayTokens >= 500000) sessionScore += 35;
    if (highRiskSessions) sessionScore += Math.min(35, highRiskSessions * 18);
    if (displayTokens) addEvidence(sessionEvidence, `${formatTokenCount(displayTokens)} tokens across recent local sessions`);
    if (highRiskSessions) addEvidence(sessionEvidence, `${highRiskSessions} high-context-risk session${highRiskSessions === 1 ? "" : "s"}`);
    bottlenecks.push({
      id: "session-splitting",
      label: "Long-session context buildup",
      score: Math.min(100, sessionScore),
      level: levelFromScore(sessionScore),
      evidence: sessionEvidence.length ? sessionEvidence : ["No matching high-growth local sessions found"],
    });

    const mcpEvidence = [];
    let mcpScore = result.optimizationStack.mcpServerTotal >= 10 ? 70 : result.optimizationStack.mcpServerTotal >= 5 ? 45 : 10;
    if (result.optimizationStack.mcpServerTotal) addEvidence(mcpEvidence, `${result.optimizationStack.mcpServerTotal} MCP/tool servers detected`);
    const totalToolCalls = realUsage ? realUsage.sessions.reduce((sum, session) => sum + Number(session.toolCalls || 0), 0) : 0;
    const repeatedCommands = realUsage ? realUsage.sessions.reduce((sum, session) => sum + (session.repeatedCommands || []).reduce((inner, item) => inner + Number(item.count || 0), 0), 0) : 0;
    if (totalToolCalls >= 500) mcpScore += 30;
    else if (totalToolCalls >= 100) mcpScore += 15;
    if (repeatedCommands >= 20) mcpScore += 20;
    if (totalToolCalls) addEvidence(mcpEvidence, `${totalToolCalls} tool calls in recent local sessions`);
    if (repeatedCommands) addEvidence(mcpEvidence, `${repeatedCommands} repeated command/tool mentions`);
    bottlenecks.push({
      id: "tool-surface",
      label: "Tool/MCP surface overhead",
      score: Math.min(100, mcpScore),
      level: levelFromScore(mcpScore),
      evidence: mcpEvidence.length ? mcpEvidence : ["Tool surface does not look unusually large"],
    });

    const ranked = bottlenecks.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    const primary = ranked[0];
    const actionById = {
      "ignore-cleanup": {
        action: "Apply safe ignore/context fixes first.",
        command: `${NPX_COMMAND} doctor --apply-suggestions --dry-run`,
        category: "ignore cleanup",
        examples: ["Prismo doctor", ".claudeignore", ".cursorignore"],
      },
      "output-sandboxing": {
        action: "Sandbox noisy command output before adding more code-indexing tools.",
        command: `${NPX_COMMAND} shield -- <noisy command>`,
        category: "output sandboxing",
        examples: ["Prismo shield", "context-mode", "RTK", "tokf", "distill"],
      },
      "code-indexing": {
        action: "Use a code indexer if repeated source exploration keeps happening.",
        command: `${NPX_COMMAND} context`,
        category: "code indexing",
        examples: ["codegraph", "jcodemunch", "codebase-memory-mcp", "sigmap"],
      },
      "instruction-trim": {
        action: "Trim persistent instructions before adding runtime compression.",
        command: `${NPX_COMMAND} doctor`,
        category: "instruction quality",
        examples: ["CLAUDE.md cleanup", "AGENTS.md cleanup", "caveman-style concise responses"],
      },
      "session-splitting": {
        action: "Split long sessions and recover from context pressure while working.",
        command: `${NPX_COMMAND} watch --auto`,
        category: "session control",
        examples: ["Prismo watch", "Prismo rescue", "fresh task sessions"],
      },
      "tool-surface": {
        action: "Reduce unused MCP/tool surface for the current task.",
        command: `${NPX_COMMAND} mcp doctor`,
        category: "tool hygiene",
        examples: ["disable unused MCP servers", "strict task-scoped tool config"],
      },
    };

    const recommendedStack = ranked
      .filter((item) => item.level !== "Low")
      .slice(0, 4)
      .map((item, index) => ({ rank: index + 1, bottleneck: item.id, ...actionById[item.id], why: item.evidence[0] }));

    if (!recommendedStack.length) {
      recommendedStack.push({
        rank: 1,
        bottleneck: "baseline",
        action: "Keep the stack simple; no major optimizer fit signal was detected.",
        command: `${NPX_COMMAND} watch --once`,
        category: "baseline monitoring",
        examples: ["Prismo watch", "Prismo cc timeline"],
        why: "Repo scan did not find a dominant token-waste source.",
      });
    }

    return {
      schemaVersion: 1,
      primaryBottleneck: primary.id,
      summary: `${primary.label}: ${primary.level}`,
      bottlenecks: ranked,
      recommendedStack,
      toolFit: [
        {
          category: "PrismoDev workflow",
          fit: "High",
          examples: ["doctor", "watch", "shield", "cc timeline"],
          reason: "Use this first to diagnose repo/session waste and verify before stacking optimizers.",
        },
        {
          category: "Output compression/sandboxing",
          fit: ranked.find((item) => item.id === "output-sandboxing").level,
          examples: ["Prismo shield", "context-mode", "RTK", "tokf", "distill", "headroom"],
          reason: "Best when shell/test/log output is the dominant waste source.",
        },
        {
          category: "Code indexing / AST graph",
          fit: ranked.find((item) => item.id === "code-indexing").level,
          examples: ["codegraph", "jcodemunch", "codebase-memory-mcp", "sigmap"],
          reason: "Best when the agent repeatedly greps/reads source files to orient itself.",
        },
        {
          category: "Repo packing",
          fit: result.stats.sourceFiles && result.stats.sourceFiles <= 250 && result.toolOutputRisk.level === "Low" ? "Medium" : "Low",
          examples: ["repomix", "Prismo context packs"],
          reason: "Best for one-shot repo handoff, less ideal for long live coding sessions.",
        },
      ],
      roundTripContext: {
        level: levelFromScore(Math.max(mcpScore, repeatedSourceReads >= 50 ? 60 : repeatedSourceReads >= 12 ? 35 : 0)),
        toolCalls: totalToolCalls,
        repeatedCommandMentions: repeatedCommands,
        repeatedSourceReads,
        mcpServers: result.optimizationStack.mcpServerTotal,
        summary: totalToolCalls || repeatedCommands || repeatedSourceReads || result.optimizationStack.mcpServerTotal
          ? "Round-trip context risk includes tool calls, repeated commands, repeated source reads, and MCP/tool surface."
          : "No strong round-trip context signal found in local logs.",
        recommendation: "Measure workflow-level savings, not only compressed payload size. Fewer tool round trips can beat smaller individual responses.",
      },
      caveats: [
        "Do not stack optimizers blindly; measure one real workflow before and after.",
        "Payload reduction is not the same as workflow savings; repeated tool calls can erase compression wins.",
        "Token savings are only useful if the agent still finds the right files and produces accepted changes.",
      ],
      nextCommands: recommendedStack.map((item) => item.command),
    };
  }

  function scoreScan(issues, stats, context = {}) {
    const issuePenalty = issues.reduce((sum, issue) => sum + severityWeight(issue.severity), 0);
    const repoPenalty =
      (stats.totalFiles > 2500 ? 4 : 0) +
      (stats.exposedLargeFiles > 10 ? 4 : 0) +
      (stats.exposedHighRiskDirs > 4 ? 4 : 0);
    const toolOutputPenalty = context.toolOutputRisk && context.toolOutputRisk.level === "High" ? 8 : context.toolOutputRisk && context.toolOutputRisk.level === "Medium" ? 4 : 0;
    const readinessCredit = context.agentReadiness && context.agentReadiness.localUsageLogsAvailable ? 3 : 0;
    const proxyCredit = context.proxyTrackingReadiness && context.proxyTrackingReadiness.exactApiTracking.available ? 2 : 0;

    let score = 100 - issuePenalty - repoPenalty - toolOutputPenalty + readinessCredit + proxyCredit;
    score = Math.max(0, Math.min(100, score));

    const risk = score >= 80 ? "Low" : score >= 55 ? "Medium" : "High";
    const avoidableWaste = risk === "Low" ? "5-15%" : risk === "Medium" ? "20-40%" : "40-65%";
    return { score, risk, avoidableWaste };
  }

  function getTopTokenLeaks(issues, limit = 5) {
    return [...issues]
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
      .slice(0, limit)
      .map((issue) => issue.title);
  }

  function getNextCommands(result, scope = null) {
    const commands = [];
    if (!result.hasClaudeIgnore || result.issues.some((issue) => ["instruction_file", "codex_config"].includes(issue.category))) {
      commands.push(`${NPX_COMMAND} scan --fix`);
    }
    commands.push(`${NPX_COMMAND} optimize`);
    if (scope) commands.push(`${NPX_COMMAND} context ${scope}`);
    else commands.push(result.stats.sourceFiles ? `${NPX_COMMAND} context` : `${NPX_COMMAND} --help`);
    if (result.realUsage && result.realUsage.sessions.length) commands.push(`${NPX_COMMAND} usage --limit 3`);
    else commands.push(`${NPX_COMMAND} scan --usage`);
    return Array.from(new Set(commands)).slice(0, 4);
  }

  function estimateExposedContextTokens(result) {
    if (!result) return 0;
    const largeFileTokens = (result.exposedLargeFiles || []).reduce((sum, file) => sum + estimateTokens(file.size), 0);
    const riskyDirTokens = (result.exposedHighRiskDirs || []).length * 50000;
    const instructionExcessTokens = (result.instructionFiles || []).reduce((sum, file) => sum + Math.max(0, (file.tokens || 0) - 500), 0);
    const toolOutputTokens = result.toolOutputRisk && result.toolOutputRisk.level === "High" ? 50000 : result.toolOutputRisk && result.toolOutputRisk.level === "Medium" ? 20000 : 0;
    return largeFileTokens + riskyDirTokens + instructionExcessTokens + toolOutputTokens;
  }

  function calculateReductionPercent(beforeTokens, afterTokens) {
    if (!beforeTokens || beforeTokens <= 0) return 0;
    const reduction = Math.max(0, beforeTokens - Math.max(0, afterTokens || 0));
    return Math.round((reduction / beforeTokens) * 100);
  }

  function chooseRecommendedScope(ctx) {
    if (ctx.scope) return ctx.scope;
    if (ctx.frameworks.some((name) => ["Next.js", "React", "Vite", "Vue", "Svelte", "SvelteKit", "Solid", "Astro", "Nuxt"].includes(name))) return "frontend";
    if (ctx.frameworks.some((name) => ["FastAPI", "Django", "Flask", "Python"].includes(name))) return "backend";
    return null;
  }

  function addRealUsageIssues(issues, usage) {
    if (!usage || !usage.sessions.length) return;
    const total = usage.totals.displayTokens || 0;
    const exact = usage.totals.exactTokens || 0;
    const toolTokens = usage.totals.toolTokens || 0;
    const highRiskSessions = usage.sessions.filter((session) => session.contextRisk === "High");

    if (total >= 1000000) {
      addIssue(
        issues,
        total >= 10000000 ? "high" : "medium",
        "repo_size",
        `Recent local AI sessions used ${formatTokenCount(total)} tokens`,
        exact ? "Prismo found exact token counts in local Codex/Claude Code session logs." : "Prismo estimated usage from local session text because exact token fields were unavailable.",
        "Use Prismo Optimize context packs, compact long sessions, and start fresh sessions for unrelated tasks.",
        exact
          ? `Actual local usage observed: ${total.toLocaleString()} tokens across ${usage.sessions.length} recent session(s).`
          : `Estimated local usage observed: ${total.toLocaleString()} tokens across ${usage.sessions.length} recent session(s).`
      );
    }

    if (toolTokens >= 50000) {
      addIssue(
        issues,
        toolTokens >= 150000 ? "high" : "medium",
        "mcp_tooling",
        `Tool output/context contributed about ${formatTokenCount(toolTokens)} tokens`,
        "Large tool results and repeated command output can dominate coding-agent context.",
        "Prefer targeted file reads and summarize long logs before pasting or loading them.",
        `Local session estimate: about ${toolTokens.toLocaleString()} tool/output tokens in recent sessions.`
      );
    }

    if (highRiskSessions.length) {
      addIssue(
        issues,
        "medium",
        "repo_size",
        `${highRiskSessions.length} recent session${highRiskSessions.length === 1 ? "" : "s"} reached high context risk`,
        "Long-running sessions tend to accumulate stale context, repeated reads, and tool output.",
        "Start a new session after major task boundaries and use scoped `.prismo/*-context.md` files.",
        "Actual/observed local sessions crossed Prismo's high context-risk threshold."
      );
    }
  }

  function buildRealUsageRecommendations(usage) {
    if (!usage || !usage.sessions.length) return [];
    const recs = [];
    if (usage.totals.displayTokens >= 1000000) {
      recs.push("Use real session usage as the primary optimization signal; prioritize reducing the largest recent sessions first.");
      recs.push("Run `prismo optimize` and start coding sessions from `.prismo/architecture-summary.md` instead of broad repo exploration.");
    }
    if (usage.totals.toolTokens >= 50000) {
      recs.push("Reduce large tool outputs by narrowing commands, reading smaller file ranges, and summarizing logs before loading them.");
    }
    if (usage.sessions.some((session) => session.turns >= 25)) {
      recs.push("Split long-running coding sessions at task boundaries to prevent context accumulation.");
    }
    return recs;
  }

  return {
    addIssue,
    addRealUsageIssues,
    buildOptimizerFit,
    buildRecommendations,
    buildRealUsageRecommendations,
    calculateReductionPercent,
    chooseRecommendedScope,
    estimateClaudeInstructionImpact,
    estimateExposedContextTokens,
    estimateLargeFileImpact,
    estimateMcpImpact,
    estimateRiskyDirImpact,
    getNextCommands,
    getTopTokenLeaks,
    scoreScan,
  };
};
