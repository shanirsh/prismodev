module.exports = function createBenchmark(deps) {
  const {
    NPX_COMMAND,
    estimateTokens,
    formatTokenCount,
    getUsageSummary,
    runShield,
    scanRepo,
    color,
  } = deps;

function estimateSummaryTokens(shieldResult) {
  const lines = shieldResult.output && Array.isArray(shieldResult.output.interestingLines)
    ? shieldResult.output.interestingLines.join("\n")
    : "";
  return estimateTokens([
    `Command: ${shieldResult.command}`,
    `Exit: ${shieldResult.exitCode}`,
    `Duration: ${shieldResult.durationMs}ms`,
    lines,
  ].join("\n"));
}

function runBenchmark(rootDir = process.cwd(), commandArgs = [], options = {}) {
  if (options.sessionOnly || !commandArgs.length) {
    const scan = scanRepo(rootDir, { includeUsage: true, usageLimit: options.limit || 5 });
    const usage = getUsageSummary({ cwd: scan.root, limit: options.limit || 5, tool: "all" });
    const fit = scan.optimizerFit;
    return {
      schemaVersion: 1,
      mode: "session",
      scannedPath: scan.root,
      score: scan.score,
      riskLevel: scan.risk,
      sessions: usage.sessions.length,
      tokens: usage.totals,
      roundTripContext: fit.roundTripContext,
      optimizerFit: fit.summary,
      recommendedStack: fit.recommendedStack,
      next: [`${NPX_COMMAND} scan --optimizer-fit`, `${NPX_COMMAND} watch --once`, `${NPX_COMMAND} cc timeline`],
      generatedAt: new Date().toISOString(),
    };
  }

  const shield = runShield(rootDir, commandArgs);
  const rawTokens = shield.output.estimatedTokens || 0;
  const summaryTokens = estimateSummaryTokens(shield);
  const reductionPercent = rawTokens > 0 ? Math.max(0, Math.round(((rawTokens - summaryTokens) / rawTokens) * 100)) : 0;
  return {
    schemaVersion: 1,
    mode: "command",
    scannedPath: shield.cwd,
    command: shield.command,
    exitCode: shield.exitCode,
    durationMs: shield.durationMs,
    rawOutput: {
      bytes: shield.output.totalBytes,
      estimatedTokens: rawTokens,
    },
    shieldedSummary: {
      estimatedTokens: summaryTokens,
      interestingLines: shield.output.interestingLines,
    },
    estimatedTokenReductionPercent: reductionPercent,
    stored: shield.stored,
    next: [
      "Give the shield summary to the agent first.",
      `${NPX_COMMAND} shield search "<error text>"`,
      `${NPX_COMMAND} scan --optimizer-fit`,
    ],
    generatedAt: new Date().toISOString(),
  };
}

function renderBenchmarkTerminal(result) {
  const lines = [];
  lines.push("");
  lines.push(color("Prismo Benchmark", "bold"));
  lines.push("");
  if (result.mode === "session") {
    lines.push(`Mode: session`);
    lines.push(`Score: ${result.score}/100 (${result.riskLevel} risk)`);
    lines.push(`Sessions: ${result.sessions}`);
    lines.push(`Tokens: ${formatTokenCount(result.tokens.displayTokens || 0)} (${result.tokens.exactTokens ? "exact-local-log" : "estimated/local"})`);
    lines.push(`Optimizer fit: ${result.optimizerFit}`);
    lines.push("");
    lines.push("Round-Trip Context:");
    lines.push(`- Level: ${result.roundTripContext.level}`);
    lines.push(`- Tool calls: ${result.roundTripContext.toolCalls}`);
    lines.push(`- Repeated commands: ${result.roundTripContext.repeatedCommandMentions}`);
    lines.push(`- Repeated source reads: ${result.roundTripContext.repeatedSourceReads}`);
    lines.push("");
    lines.push("Next:");
    result.next.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    return lines.join("\n");
  }

  lines.push(`Mode: command`);
  lines.push(`Command: ${result.command}`);
  lines.push(`Exit: ${result.exitCode}`);
  lines.push(`Duration: ${result.durationMs}ms`);
  lines.push(`Raw output: ${result.rawOutput.bytes.toLocaleString()} bytes (~${result.rawOutput.estimatedTokens.toLocaleString()} tokens)`);
  lines.push(`Shield summary: ~${result.shieldedSummary.estimatedTokens.toLocaleString()} tokens`);
  lines.push(`Estimated reduction: ${result.estimatedTokenReductionPercent}%`);
  lines.push("");
  lines.push("Stored Output:");
  lines.push(`- ${result.stored.stdout}`);
  lines.push(`- ${result.stored.stderr}`);
  lines.push("");
  lines.push("Useful Lines:");
  result.shieldedSummary.interestingLines.slice(0, 12).forEach((line) => lines.push(`- ${line}`));
  lines.push("");
  lines.push("Next:");
  result.next.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  return lines.join("\n");
}

  return {
    renderBenchmarkTerminal,
    runBenchmark,
  };
};
