module.exports = function createReport(deps) {
  const {
    fs,
    path,
    NPX_COMMAND,
    color,
    severityIcon,
    severityColor,
    estimateTokens,
    formatBytes,
    formatTokenCount,
    getNextCommands,
  } = deps;

function renderTerminalReport(result, options = {}) {
  const reportEnabled = options.reportEnabled !== false;
  const useColor = options.color !== false;
  const riskTone = result.risk === "High" ? "red" : result.risk === "Medium" ? "yellow" : "green";
  const lines = [];
  lines.push("");
  lines.push(color("PrismoDev", "bold", useColor));
  lines.push("");
  lines.push(`Score: ${color(`${result.score}/100`, riskTone, useColor)}  |  Risk: ${color(result.risk, riskTone, useColor)}  |  Token leaks: ${result.issues.length}`);
  lines.push(`Estimated avoidable waste: ${result.avoidableWaste}`);
  lines.push("");
  lines.push(color("Top Token Leaks", "bold", useColor));
  if (!result.topTokenLeaks.length) {
    lines.push("1. [ok] No major token leaks detected");
  } else {
    result.topTokenLeaks.forEach((leak, index) => lines.push(`${index + 1}. ${leak}`));
  }
  lines.push("");
  const nextCommands = getNextCommands(result, options.scope);
  lines.push(color("Top Fix", "bold", useColor));
  lines.push(`Run: ${nextCommands[0]}`);
  if (nextCommands[1]) lines.push(`Then: ${nextCommands[1]}`);
  if (nextCommands[2]) lines.push(`Then: ${nextCommands[2]}`);
  lines.push("");
  lines.push(color("Scan Context", "bold", useColor));
  lines.push(`- Files scanned: ${result.stats.totalFiles.toLocaleString()}`);
  lines.push(`- Source files: ${result.stats.sourceFiles.toLocaleString()}`);
  lines.push(`- Large files: ${result.stats.largeFiles.toLocaleString()} (${result.stats.exposedLargeFiles} exposed)`);
  lines.push(`- Risky directories: ${result.stats.highRiskDirs} (${result.stats.exposedHighRiskDirs} exposed)`);
  lines.push(`- Repo detected: ${result.repoDetected ? "yes" : "no"}`);
  if (result.realUsage && result.realUsage.sessions.length) {
    lines.push(`- Real local usage: ${formatTokenCount(result.realUsage.totals.displayTokens)} tokens across ${result.realUsage.sessions.length} session(s)`);
    lines.push(`- Usage confidence: ${result.realUsage.confidence}`);
  } else if (result.realUsage) {
    lines.push("- Real local usage: no matching local Codex/Claude Code sessions found for this repo");
  }
  lines.push("");
  lines.push(color("Coding Agent Readiness", "bold", useColor));
  lines.push(`- Claude Code: ${result.agentReadiness.claudeCode.detected ? "detected" : "not detected"}; logs: ${result.agentReadiness.claudeCode.localLogsFound ? "found" : "not found"}; MCP: ${result.agentReadiness.claudeCode.mcpServers}; hooks: ${result.agentReadiness.claudeCode.hooks}`);
  lines.push(`- Codex: ${result.agentReadiness.codex.detected ? "detected" : "not detected"}; logs: ${result.agentReadiness.codex.localLogsFound ? "found" : "not found"}; MCP: ${result.agentReadiness.codex.mcpServers}`);
  lines.push(`- Cursor: ${result.agentReadiness.cursor.detected ? "detected" : "not detected"}`);
  lines.push("");
  lines.push(color("Optimization Stack", "bold", useColor));
  const stack = result.optimizationStack;
  lines.push(`- RTK: ${stack.tools.rtk.detected ? "detected" : "not detected"}`);
  lines.push(`- Headroom: ${stack.tools.headroom.detected ? "detected" : "not detected"}`);
  lines.push(`- Distill: ${stack.tools.distill.detected ? "detected" : "not detected"}`);
  lines.push(`- Mana: ${stack.tools.mana.detected ? "detected" : "not detected"}`);
  lines.push(`- Claude hooks: ${stack.claudeHooks}; MCP servers: ${stack.mcpServerTotal}`);
  lines.push("");
  lines.push(color("Tool Output Risk", "bold", useColor));
  lines.push(`- Level: ${result.toolOutputRisk.level}`);
  lines.push(`- ${result.toolOutputRisk.summary}`);
  if (result.toolOutputRisk.exposedNoisyDirectories.length) lines.push(`- Exposed noisy dirs: ${result.toolOutputRisk.exposedNoisyDirectories.slice(0, 6).join(", ")}`);
  if (result.toolOutputRisk.exposedNoisyFiles.length) lines.push(`- Exposed noisy files: ${result.toolOutputRisk.exposedNoisyFiles.slice(0, 4).map((file) => file.path).join(", ")}`);
  lines.push("");
  lines.push(color("Prismo Proxy Tracking", "bold", useColor));
  lines.push("- Exact API tracking: available when traffic uses the Prismo OpenAI/Anthropic base URL");
  lines.push(`- Codex API/base-url mode: ${result.proxyTrackingReadiness.codingAgentBaseUrlMode.codex}`);
  lines.push(`- Claude Code subscription mode: ${result.proxyTrackingReadiness.codingAgentBaseUrlMode.claudeCode}`);
  lines.push("- Subscription sessions: local-log visibility when available, not guaranteed billing accuracy");
  lines.push("");
  lines.push(color("Issues", "bold", useColor));
  if (!result.issues.length) {
    lines.push("- [ok] No major token-waste risks detected.");
  } else {
    for (const issue of result.issues.slice(0, 8)) {
      const icon = color(severityIcon(issue.severity), severityColor(issue.severity), useColor);
      lines.push(`- ${icon} ${issue.title}. ${issue.description}`);
      if (issue.estimatedTokenImpact) lines.push(`  ${issue.estimatedTokenImpact}`);
    }
  }
  lines.push("");
  lines.push(color("Recommended Fixes", "bold", useColor));
  result.recommendations.forEach((rec, index) => lines.push(`${index + 1}. ${rec}`));
  lines.push("");
  lines.push(result.realUsage && result.realUsage.sessions.length
    ? "Usage findings come from local Codex/Claude Code logs when exact token fields are available; repo-risk estimates remain heuristic."
    : result.realUsage
      ? "No matching local usage sessions were found; repo-risk estimates remain heuristic."
    : "Potential savings estimates are heuristic and local-only, not provider billing data.");
  lines.push("");
  lines.push(reportEnabled ? "Report: .prismo/prismo-dev-report.md" : "Report: skipped (--no-report)");
  return lines.join("\n");
}

function evaluateCi(result, options = {}) {
  const minScore = Number(options.minScore || 80);
  const failures = [];
  if (result.score < minScore) failures.push(`Score ${result.score}/100 is below CI minimum ${minScore}/100.`);
  if (result.risk === "High") failures.push("Token risk is High.");
  if (!result.hasClaudeIgnore) failures.push(".claudeignore is missing.");
  if (!result.hasCursorIgnore) failures.push(".cursorignore is missing.");
  if (result.exposedHighRiskDirs.length) failures.push(`${result.exposedHighRiskDirs.length} generated/cache director${result.exposedHighRiskDirs.length === 1 ? "y is" : "ies are"} exposed.`);
  if (result.exposedLargeFiles.length) failures.push(`${result.exposedLargeFiles.length} large file${result.exposedLargeFiles.length === 1 ? " is" : "s are"} exposed.`);
  return {
    passed: failures.length === 0,
    minScore,
    failures,
  };
}

function renderCiReport(result, ci) {
  const lines = [];
  lines.push("");
  lines.push("Prismo CI");
  lines.push("");
  lines.push(`Status: ${ci.passed ? "PASS" : "FAIL"}`);
  lines.push(`Score: ${result.score}/100`);
  lines.push(`Risk: ${result.risk}`);
  lines.push("");
  if (ci.failures.length) {
    lines.push("Failures:");
    ci.failures.forEach((failure) => lines.push(`- ${failure}`));
  } else {
    lines.push("No CI token-risk failures detected.");
  }
  lines.push("");
  lines.push(`Next: ${NPX_COMMAND} doctor`);
  return lines.join("\n");
}

function renderSimpleScanReport(result) {
  const lines = [];
  const topLeaks = result.topTokenLeaks.length ? result.topTokenLeaks.slice(0, 4) : ["No major token-waste risks detected."];
  const nextCommands = getNextCommands(result);
  lines.push("");
  lines.push("PrismoDev Simple Scan");
  lines.push("");
  lines.push(`Result: ${result.risk} token-waste risk (${result.score}/100)`);
  lines.push(`What it means: Prismo found ${result.issues.length} thing${result.issues.length === 1 ? "" : "s"} that could make Claude Code, Codex, or Cursor use extra context.`);
  if (result.realUsage && result.realUsage.sessions.length) {
    lines.push(`Recent local usage: ${formatTokenCount(result.realUsage.totals.displayTokens)} tokens from local coding-agent logs.`);
  } else if (result.realUsage) {
    lines.push("Recent local usage: no matching Codex or Claude Code session logs found for this repo.");
  }
  lines.push("");
  lines.push("Main things to fix:");
  topLeaks.forEach((leak, index) => lines.push(`${index + 1}. ${leak}`));
  lines.push("");
  lines.push("Best next step:");
  lines.push(`${nextCommands[0]}`);
  if (nextCommands[1]) lines.push(`After that: ${nextCommands[1]}`);
  lines.push("");
  lines.push("Plain English:");
  lines.push("PrismoDev checks your project locally. It does not need API keys, does not connect to OpenAI or Anthropic, and does not change your code unless you run --fix.");
  lines.push("");
  return lines.join("\n");
}

function renderMarkdownReport(result) {
  const lines = [];
  lines.push("# PrismoDev Report");
  lines.push("");
  lines.push("## Executive Summary");
  lines.push("");
  lines.push(`- **Score:** ${result.score}/100`);
  lines.push(`- **Risk Level:** ${result.risk}`);
  lines.push(`- **Token Leaks Found:** ${result.issues.length}`);
  lines.push(`- **Estimated Avoidable Waste:** ${result.avoidableWaste}`);
  lines.push(`- **Repo:** \`${result.root}\``);
  lines.push(`- **Generated At:** ${result.generatedAt}`);
  if (result.realUsage) {
    lines.push(`- **Real Local Usage:** ${result.realUsage.totals.displayTokens.toLocaleString()} tokens across ${result.realUsage.sessions.length} session(s)`);
    lines.push(`- **Usage Confidence:** ${result.realUsage.confidence}`);
  }
  lines.push("");
  lines.push("Estimates are based on local file-size and configuration heuristics. They are not provider billing data and are not guaranteed savings.");
  lines.push("");
  lines.push("## Top Token Leaks");
  lines.push("");
  if (!result.topTokenLeaks.length) {
    lines.push("1. No major token leaks detected.");
  } else {
    result.topTokenLeaks.forEach((leak, index) => lines.push(`${index + 1}. ${leak}`));
  }
  lines.push("");
  lines.push("## Repo Context");
  lines.push("");
  lines.push(`- Total files scanned: ${result.stats.totalFiles}`);
  lines.push(`- Source files: ${result.stats.sourceFiles}`);
  lines.push(`- Large files: ${result.stats.largeFiles}`);
  lines.push(`- Exposed large files: ${result.stats.exposedLargeFiles}`);
  lines.push(`- Token-bloat directories: ${result.stats.highRiskDirs}`);
  lines.push(`- Exposed token-bloat directories: ${result.stats.exposedHighRiskDirs}`);
  lines.push("");
  lines.push("## Coding Agent Readiness");
  lines.push("");
  lines.push(`- Claude Code detected: ${result.agentReadiness.claudeCode.detected ? "yes" : "no"}`);
  lines.push(`  - Local logs found: ${result.agentReadiness.claudeCode.localLogsFound ? "yes" : "no"}`);
  lines.push(`  - MCP servers: ${result.agentReadiness.claudeCode.mcpServers}; hooks: ${result.agentReadiness.claudeCode.hooks}`);
  lines.push(`  - Exact proxy tracking: ${result.agentReadiness.claudeCode.exactProxyTracking}`);
  lines.push(`- Codex detected: ${result.agentReadiness.codex.detected ? "yes" : "no"}`);
  lines.push(`  - Local logs found: ${result.agentReadiness.codex.localLogsFound ? "yes" : "no"}`);
  lines.push(`  - MCP servers: ${result.agentReadiness.codex.mcpServers}`);
  lines.push(`  - Exact proxy tracking: ${result.agentReadiness.codex.exactProxyTracking}`);
  lines.push(`- Cursor detected: ${result.agentReadiness.cursor.detected ? "yes" : "no"}`);
  lines.push(`  - Exact proxy tracking: ${result.agentReadiness.cursor.exactProxyTracking}`);
  lines.push("");
  lines.push("## Optimization Stack");
  lines.push("");
  lines.push(`- RTK: ${result.optimizationStack.tools.rtk.detected ? "detected" : "not detected"}`);
  lines.push(`- Headroom: ${result.optimizationStack.tools.headroom.detected ? "detected" : "not detected"}`);
  lines.push(`- Distill: ${result.optimizationStack.tools.distill.detected ? "detected" : "not detected"}`);
  lines.push(`- Mana: ${result.optimizationStack.tools.mana.detected ? "detected" : "not detected"}`);
  lines.push(`- Claude hooks: ${result.optimizationStack.claudeHooks}`);
  lines.push(`- Total MCP/tool servers: ${result.optimizationStack.mcpServerTotal}`);
  lines.push("");
  lines.push("## Tool Output Risk");
  lines.push("");
  lines.push(`- Level: ${result.toolOutputRisk.level}`);
  lines.push(`- ${result.toolOutputRisk.summary}`);
  if (result.toolOutputRisk.exposedNoisyDirectories.length) {
    lines.push(`- Exposed noisy directories: ${result.toolOutputRisk.exposedNoisyDirectories.map((dir) => `\`${dir}/\``).join(", ")}`);
  }
  if (result.toolOutputRisk.exposedNoisyFiles.length) {
    result.toolOutputRisk.exposedNoisyFiles.slice(0, 20).forEach((file) => {
      lines.push(`- \`${file.path}\` - ${formatBytes(file.sizeBytes)} - ~${file.estimatedTokensIfRead.toLocaleString()} tokens if read`);
    });
  }
  lines.push("");
  lines.push("## Prismo Proxy Tracking Readiness");
  lines.push("");
  lines.push("- Exact API tracking: available when app/tool traffic uses the Prismo OpenAI/Anthropic base URL.");
  lines.push(`- Codex API/base-url mode: ${result.proxyTrackingReadiness.codingAgentBaseUrlMode.codex}.`);
  lines.push(`- Claude Code subscription mode: ${result.proxyTrackingReadiness.codingAgentBaseUrlMode.claudeCode}.`);
  lines.push("- Local estimate tracking: available from local Codex/Claude Code logs when those logs exist.");
  lines.push("- Unsupported: exact billing for hidden subscription sessions without provider traffic, API keys, or local token fields.");
  lines.push("");
  if (result.realUsage) {
    lines.push("## Real Local Usage");
    lines.push("");
    lines.push(`- Tool scope: ${result.realUsage.tool}`);
    lines.push(`- Displayed tokens: ${result.realUsage.totals.displayTokens.toLocaleString()}`);
    lines.push(`- Exact local-log tokens: ${result.realUsage.totals.exactTokens.toLocaleString()}`);
    lines.push(`- Estimated tool/output tokens: ${result.realUsage.totals.toolTokens.toLocaleString()}`);
    lines.push(`- Confidence: ${result.realUsage.confidence}`);
    lines.push("");
    result.realUsage.sessions.slice(0, 5).forEach((session, index) => {
      lines.push(`${index + 1}. ${session.tool} - ${session.title || session.sessionId}`);
      lines.push(`   - Tokens: ${session.displayTokens.toLocaleString()} (${session.confidence})`);
      lines.push(`   - Risk: ${session.contextRisk}; turns: ${session.turns}; tools: ${session.toolCalls}`);
      if (session.cwd) lines.push(`   - CWD: \`${session.cwd}\``);
    });
    lines.push("");
  }
  lines.push("## Issues");
  lines.push("");
  if (!result.issues.length) {
    lines.push("- No major token-waste risks detected.");
  } else {
    for (const issue of result.issues) {
      lines.push(`- **${issue.severity.toUpperCase()}** / \`${issue.category}\`: ${issue.title}`);
      lines.push(`  - ${issue.description}`);
      lines.push(`  - Fix: ${issue.recommendation}`);
      if (issue.estimatedTokenImpact) lines.push(`  - ${issue.estimatedTokenImpact}`);
    }
  }
  lines.push("");
  lines.push("## Claude Code Findings");
  lines.push("");
  lines.push(`- CLAUDE.md found: ${result.instructionFiles.some((file) => file.isClaude) ? "yes" : "no"}`);
  lines.push(`- .claudeignore found: ${result.hasClaudeIgnore ? "yes" : "no"}`);
  lines.push(`- Claude config files found: ${result.claudeConfig.files.length ? result.claudeConfig.files.map((file) => `\`${file}\``).join(", ") : "none"}.`);
  lines.push(`- MCP servers detected: ${result.claudeConfig.mcpServers}. Hooks detected: ${result.claudeConfig.hooks}. Plugin/skill references: ${result.claudeConfig.pluginRefs}.`);
  lines.push("- Keep `CLAUDE.md` under 500 tokens when possible.");
  lines.push("- Move long implementation notes into separate docs and reference them only when needed.");
  lines.push("- Create `.claudeignore` to hide generated files, caches, logs, coverage, and lock files.");
  lines.push("");
  lines.push("## OpenAI/Codex Findings");
  lines.push("");
  lines.push(`- AGENTS.md found: ${result.instructionFiles.some((file) => file.path === "AGENTS.md") ? "yes" : "no"}`);
  lines.push(`- Codex config files found: ${result.codexConfig.files.length ? result.codexConfig.files.map((file) => `\`${file}\``).join(", ") : "none"}.`);
  lines.push(`- Codex MCP/tool references detected: ${result.codexConfig.mcpServers}.`);
  lines.push("- Keep `AGENTS.md` and `.codex/` instructions concise and task-oriented.");
  lines.push("- Avoid pasting giant logs or generated JSON into Codex sessions.");
  lines.push("- Use cheaper/faster models for mechanical edits and low-risk refactors.");
  lines.push("");
  lines.push("## Large Files");
  lines.push("");
  if (!result.largeFiles.length) {
    lines.push("- No large text-like files over 500 KB detected.");
  } else {
    result.largeFiles.slice(0, 40).forEach((file) => {
      lines.push(`- \`${file.path}\` - ${formatBytes(file.size)} - ${file.kind}${file.ignored ? " - ignored" : ""}`);
    });
  }
  lines.push("");
  lines.push("## Risky Directories");
  lines.push("");
  if (!result.highRiskDirs.length) {
    lines.push("- No common token-bloat directories detected.");
  } else {
    result.highRiskDirs.forEach((dir) => {
      lines.push(`- \`${dir.path}/\`${dir.exposed ? " - exposed" : " - ignored"}`);
    });
  }
  lines.push("");
  lines.push("## Recommended .claudeignore");
  lines.push("");
  if (result.hasClaudeIgnore && result.missingClaudeIgnoreSuggestions && !result.missingClaudeIgnoreSuggestions.length) {
    lines.push("Existing .claudeignore already covers Prismo recommendations.");
    lines.push("");
  }
  lines.push("```gitignore");
  (result.hasClaudeIgnore && result.missingClaudeIgnoreSuggestions ? result.missingClaudeIgnoreSuggestions : result.recommendedClaudeIgnore).forEach((line) => lines.push(line));
  lines.push("```");
  lines.push("");
  lines.push("## Recommended .cursorignore");
  lines.push("");
  if (result.hasCursorIgnore && result.missingCursorIgnoreSuggestions && !result.missingCursorIgnoreSuggestions.length) {
    lines.push("Existing .cursorignore already covers Prismo recommendations.");
    lines.push("");
  }
  lines.push("```gitignore");
  (result.hasCursorIgnore && result.missingCursorIgnoreSuggestions ? result.missingCursorIgnoreSuggestions : result.recommendedCursorIgnore).forEach((line) => lines.push(line));
  lines.push("```");
  lines.push("");
  lines.push("## Recommended Next Steps");
  lines.push("");
  result.recommendations.forEach((rec, index) => lines.push(`${index + 1}. ${rec}`));
  lines.push("");
  lines.push("## Disclaimer");
  lines.push("");
  lines.push("PrismoDev is a fast local scanner. It does not connect to Anthropic, OpenAI, Claude Code, Codex, Cursor, or billing accounts. Token and savings estimates are heuristic and should be treated as directional diagnostics only.");
  lines.push("");
  return lines.join("\n");
}

function backupIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.${stamp}.bak`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function writeReport(result) {
  const prismoDir = path.join(result.root, ".prismo");
  fs.mkdirSync(prismoDir, { recursive: true });
  const reportPath = path.join(prismoDir, "prismo-dev-report.md");
  const backupPath = backupIfExists(reportPath);
  fs.writeFileSync(reportPath, renderMarkdownReport(result), "utf8");
  return { reportPath, backupPath };
}

  return {
    backupIfExists,
    evaluateCi,
    renderCiReport,
    renderMarkdownReport,
    renderSimpleScanReport,
    renderTerminalReport,
    writeReport,
  };
};
