module.exports = function createReceipt(deps) {
  const {
    fs,
    path,
    GENERATED_ARTIFACT_PATTERNS,
    NPX_COMMAND,
    formatTokenCount,
    getUsageSummary,
    readIfText,
  } = deps;

  const {
    getActionableRepeatedPaths,
    summarizeGeneratedArtifacts,
  } = require("./usage-log-utils")({
    fs,
    path,
    GENERATED_ARTIFACT_PATTERNS,
    readIfText,
  });

  function sumCounts(items) {
    return (items || []).reduce((sum, item) => sum + Number(item.count || 0), 0);
  }

  function topItems(items, limit = 5) {
    return (items || [])
      .slice()
      .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
      .slice(0, limit)
      .map((item) => ({
        value: item.value,
        count: Number(item.count || 0),
      }));
  }

  function sessionScore(session) {
    let score = 0;
    if (session.contextRisk === "High") score += 45;
    else if (session.contextRisk === "Medium") score += 25;
    if ((session.estimatedToolTokens || 0) >= 75000) score += 30;
    else if ((session.estimatedToolTokens || 0) >= 25000) score += 15;
    score += Math.min(25, sumCounts(session.repeatedPathMentions) * 2);
    score += Math.min(20, sumCounts(session.generatedArtifacts) * 2);
    score += Math.min(20, sumCounts(session.repeatedCommands) * 3);
    if (session.loopSuspicion) score += 20;
    if ((session.turns || 0) >= 30) score += 10;
    return score;
  }

  function chooseRootCause(session) {
    if (!session) return { cause: "no-session", confidence: "low", summary: "No local coding-agent sessions were found for this repo." };
    if ((session.estimatedToolTokens || 0) >= 75000) {
      return {
        cause: "tool-output-flood",
        confidence: session.estimatedToolTokens >= 200000 ? "high" : "medium",
        summary: `Tool/output tokens dominated the session (${formatTokenCount(session.estimatedToolTokens)} estimated tokens).`,
      };
    }
    if (session.loopSuspicion && (session.repeatedCommands || []).length) {
      return {
        cause: "possible-command-loop",
        confidence: session.loopConfidence || "medium",
        summary: `${session.repeatedCommands[0].value} repeated ${session.repeatedCommands[0].count}x.`,
      };
    }
    const artifactGroup = summarizeGeneratedArtifacts(session.generatedArtifacts || [], 1)[0];
    if (artifactGroup) {
      return {
        cause: "artifact-leak",
        confidence: artifactGroup.count >= 10 ? "high" : "medium",
        summary: `${artifactGroup.type} artifacts appeared in context (${artifactGroup.count} mentions).`,
      };
    }
    const repeatedPath = getActionableRepeatedPaths(session, 1)[0] || topItems(session.repeatedPathMentions, 1)[0];
    if (repeatedPath) {
      return {
        cause: "repeated-file-read",
        confidence: repeatedPath.count >= 20 ? "high" : "medium",
        summary: `${repeatedPath.value} repeatedly entered context (${repeatedPath.count}x).`,
      };
    }
    if (session.contextRisk === "High") {
      return {
        cause: "high-context-pressure",
        confidence: "medium",
        summary: `Session reached high context pressure (${formatTokenCount(session.displayTokens || session.contextTokens)} tokens).`,
      };
    }
    return {
      cause: "healthy-or-low-signal",
      confidence: "low",
      summary: "No major repeated reads, command loops, tool-output floods, or artifact leaks were detected.",
    };
  }

  function buildReceiptSession(session) {
    const repeatedReads = topItems(getActionableRepeatedPaths(session, 10).length ? getActionableRepeatedPaths(session, 10) : session.repeatedPathMentions, 10);
    const artifactGroups = summarizeGeneratedArtifacts(session.generatedArtifacts || [], 10);
    const repeatedCommands = topItems(session.repeatedCommands, 10);
    const likelyInfluence = [];
    for (const item of repeatedReads.slice(0, 5)) {
      likelyInfluence.push({
        type: "repeated-read",
        value: item.value,
        reason: `Read or mentioned ${item.count}x in the session.`,
      });
    }
    for (const command of repeatedCommands.slice(0, 3)) {
      likelyInfluence.push({
        type: "repeated-command",
        value: command.value,
        reason: `Command appeared ${command.count}x${session.loopSuspicion ? "; possible loop signal." : "."}`,
      });
    }
    if ((session.estimatedToolTokens || 0) > 0) {
      likelyInfluence.push({
        type: "tool-output",
        value: `${formatTokenCount(session.estimatedToolTokens)} estimated tokens`,
        reason: "Tool output likely shaped later turns because it remained in session context.",
      });
    }

    const shouldIgnore = [];
    for (const group of artifactGroups) {
      shouldIgnore.push({
        value: group.type,
        reason: `${group.count} artifact mention${group.count === 1 ? "" : "s"} in context.`,
      });
    }
    for (const item of topItems(session.generatedArtifacts, 5)) {
      shouldIgnore.push({
        value: item.value,
        reason: `${item.count} mention${item.count === 1 ? "" : "s"} in context.`,
      });
    }

    const nextRun = [];
    if (session.contextRisk === "High") nextRun.push("Start a fresh scoped session before continuing.");
    if ((session.estimatedToolTokens || 0) >= 25000) nextRun.push(`Run noisy commands through ${NPX_COMMAND} shield -- <command>.`);
    if (artifactGroups.length || shouldIgnore.length) nextRun.push(`Run ${NPX_COMMAND} doctor --apply-suggestions --dry-run and review ignore candidates.`);
    if (repeatedReads.length) nextRun.push(`Use ${NPX_COMMAND} firewall <task> so the agent starts with a smaller read boundary.`);
    if (session.loopSuspicion) nextRun.push(`Run ${NPX_COMMAND} watch --rescue and ask the agent to summarize state before another command.`);
    if (!nextRun.length) nextRun.push("Keep the next session scoped; no urgent corrective action was detected.");

    return {
      sessionId: session.sessionId,
      tool: session.tool,
      model: session.model || "",
      startedAt: session.startedAt || null,
      updatedAt: session.updatedAt || null,
      contextRisk: session.contextRisk,
      confidence: session.confidence,
      turns: session.turns || 0,
      toolCalls: session.toolCalls || 0,
      toolResults: session.toolResults || 0,
      tokens: {
        display: session.displayTokens || 0,
        context: session.contextTokens || 0,
        exact: session.exactTotalTokens || 0,
        toolOutput: session.estimatedToolTokens || 0,
      },
      rootCause: chooseRootCause(session),
      readReceipt: {
        repeatedReads,
        repeatedReadMentions: sumCounts(repeatedReads),
      },
      outputReceipt: {
        toolOutputTokens: session.estimatedToolTokens || 0,
        repeatedCommands,
        loopSuspicion: Boolean(session.loopSuspicion),
        loopConfidence: session.loopConfidence || "low",
      },
      artifactReceipt: {
        artifactGroups,
        generatedArtifacts: topItems(session.generatedArtifacts, 10),
      },
      likelyInfluence: likelyInfluence.slice(0, 10),
      nextRun,
      score: sessionScore(session),
    };
  }

  function buildReceipt(options = {}) {
    const cwd = options.cwd || process.cwd();
    const limit = options.limit || 5;
    const tool = options.tool || "all";
    const usage = getUsageSummary({ cwd, limit, tool });
    const sessions = (usage.sessions || [])
      .map(buildReceiptSession)
      .sort((a, b) => b.score - a.score || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    const primary = sessions[0] || null;
    const aggregate = sessions.reduce((acc, session) => {
      acc.sessions += 1;
      acc.displayTokens += session.tokens.display || 0;
      acc.contextTokens += session.tokens.context || 0;
      acc.toolOutputTokens += session.tokens.toolOutput || 0;
      acc.repeatedReadMentions += session.readReceipt.repeatedReadMentions || 0;
      acc.repeatedCommands += session.outputReceipt.repeatedCommands.reduce((sum, item) => sum + Number(item.count || 0), 0);
      acc.artifactMentions += session.artifactReceipt.generatedArtifacts.reduce((sum, item) => sum + Number(item.count || 0), 0);
      return acc;
    }, {
      sessions: 0,
      displayTokens: 0,
      contextTokens: 0,
      toolOutputTokens: 0,
      repeatedReadMentions: 0,
      repeatedCommands: 0,
      artifactMentions: 0,
    });

    return {
      schemaVersion: 1,
      command: "receipt",
      generatedAt: new Date().toISOString(),
      scannedPath: cwd,
      tool,
      confidence: usage.confidence,
      sources: usage.sources || [],
      aggregate,
      primary,
      sessions,
      next: primary ? primary.nextRun : [`Run ${NPX_COMMAND} watch --once after starting a coding-agent session in this repo.`],
    };
  }

  function renderReceiptTerminal(receipt) {
    const lines = [];
    lines.push("");
    lines.push("Prismo Run Receipt");
    lines.push("");
    if (!receipt.sessions.length) {
      lines.push("No matching local coding-agent sessions found for this repo.");
      lines.push("");
      lines.push(`Next: ${receipt.next[0]}`);
      return lines.join("\n");
    }

    const primary = receipt.primary;
    lines.push(`Session: ${primary.sessionId || "unknown"} (${primary.tool})`);
    lines.push(`Model: ${primary.model || "unknown"}`);
    lines.push(`Updated: ${primary.updatedAt || "unknown"}`);
    lines.push(`Context: ${formatTokenCount(primary.tokens.display || primary.tokens.context)} tokens (${primary.contextRisk || "Unknown"} risk, ${primary.confidence})`);
    lines.push("");
    lines.push("Root Cause");
    lines.push(`- ${primary.rootCause.cause} (${primary.rootCause.confidence})`);
    lines.push(`- ${primary.rootCause.summary}`);
    lines.push("");
    lines.push("Read Receipt");
    if (primary.readReceipt.repeatedReads.length) {
      primary.readReceipt.repeatedReads.slice(0, 5).forEach((item) => lines.push(`- ${item.value} (${item.count}x)`));
    } else {
      lines.push("- No repeated source/file reads detected.");
    }
    lines.push("");
    lines.push("Output Receipt");
    lines.push(`- Tool/output tokens: ${formatTokenCount(primary.outputReceipt.toolOutputTokens)}`);
    if (primary.outputReceipt.repeatedCommands.length) {
      primary.outputReceipt.repeatedCommands.slice(0, 5).forEach((item) => lines.push(`- Repeated command: ${item.value} (${item.count}x)`));
    } else {
      lines.push("- No repeated commands detected.");
    }
    lines.push("");
    lines.push("Artifact Receipt");
    if (primary.artifactReceipt.artifactGroups.length) {
      primary.artifactReceipt.artifactGroups.slice(0, 5).forEach((item) => lines.push(`- ${item.type}: ${item.count} mentions`));
    } else {
      lines.push("- No generated artifact leaks detected.");
    }
    lines.push("");
    lines.push("Likely Influence");
    if (primary.likelyInfluence.length) {
      primary.likelyInfluence.slice(0, 5).forEach((item) => lines.push(`- ${item.value}: ${item.reason}`));
    } else {
      lines.push("- No strong influence signals detected.");
    }
    lines.push("");
    lines.push("Next Run");
    primary.nextRun.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    if (receipt.sessions.length > 1) {
      lines.push("");
      lines.push(`Receipt covered ${receipt.sessions.length} session(s): ${formatTokenCount(receipt.aggregate.displayTokens)} displayed tokens, ${formatTokenCount(receipt.aggregate.toolOutputTokens)} tool/output tokens.`);
    }
    return lines.join("\n");
  }

  return {
    buildReceipt,
    renderReceiptTerminal,
  };
};
