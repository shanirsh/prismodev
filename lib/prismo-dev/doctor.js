module.exports = function createDoctor(deps) {
  const {
    fs,
    path,
    NPX_COMMAND,
    color,
    applyFixes,
    calculateReductionPercent,
    chooseRecommendedScope,
    createOptimizeContext,
    estimateExposedContextTokens,
    formatTokenCount,
    getContextFileForScope,
    getNextCommands,
    getTopTokenLeaks,
    renderContextCommand,
    renderStarterPrompt,
    runOptimize,
    safeReadJson,
    scanRepo,
    writeGeneratedFile,
    backupIfExists,
    printStep,
  } = deps;

function createDemoResult() {
  const issues = [
    {
      severity: "critical",
      category: "repo_size",
      title: "Recent local AI sessions used 2.40M tokens",
      description: "Prismo found exact token counts in local coding-agent logs.",
      recommendation: "Use compact context packs and split long sessions at task boundaries.",
      estimatedTokenImpact: "Actual local usage observed: 2,400,000 tokens across 3 recent sessions.",
    },
    {
      severity: "high",
      category: "large_file",
      title: "Large exposed file detected",
      description: "logs/debug-output.json (6.8 MB)",
      recommendation: "Ignore or summarize large logs before loading them into an agent.",
      estimatedTokenImpact: "Likely avoidable token exposure: up to ~1,700,000 tokens if read into context.",
    },
    {
      severity: "medium",
      category: "instruction_file",
      title: "CLAUDE.md is ~1,900 tokens",
      description: "Persistent instructions are larger than the recommended baseline.",
      recommendation: "Trim CLAUDE.md under 500 tokens and link to details only when needed.",
      estimatedTokenImpact: "Potential savings estimate: about 1,400 persistent instruction tokens per turn.",
    },
  ];
  return {
    root: "/demo/prismo-app",
    score: 58,
    risk: "Medium",
    avoidableWaste: "20-40%",
    issues,
    recommendations: [
      "Create .claudeignore with generated/cache folders and large artifacts excluded.",
      "Run `prismo optimize` to generate compact context files.",
      "Start coding sessions from `.prismo/architecture-summary.md` instead of broad repo exploration.",
      "Split long-running coding sessions at task boundaries.",
    ],
    realUsage: {
      tool: "all",
      confidence: "exact-local-log",
      totals: { sessions: 3, displayTokens: 2400000, estimatedTokens: 180000, exactTokens: 2400000, toolTokens: 95000 },
      sessions: [{}, {}, {}],
    },
    stats: { totalFiles: 842, sourceFiles: 318, largeFiles: 4, exposedLargeFiles: 2, highRiskDirs: 7, exposedHighRiskDirs: 3 },
    agentReadiness: {
      claudeCode: { detected: true, localLogsFound: true, mcpServers: 4, hooks: 2, exactProxyTracking: "limited-for-subscription-mode" },
      codex: { detected: true, localLogsFound: true, mcpServers: 1, exactProxyTracking: "available-when-using-api-key-base-url-mode" },
      cursor: { detected: false, exactProxyTracking: "available-only-if-configured-for-openai-compatible-base-url" },
      localUsageLogsAvailable: true,
    },
    optimizationStack: {
      tools: {
        rtk: { detected: false },
        headroom: { detected: false },
        distill: { detected: false },
        mana: { detected: false },
      },
      claudeHooks: 2,
      mcpServerTotal: 5,
    },
    toolOutputRisk: {
      level: "High",
      summary: "Large logs, test reports, build output, or generated files are exposed to coding-agent reads.",
      exposedNoisyDirectories: ["logs", "coverage"],
      exposedNoisyFiles: [{ path: "logs/debug-output.json" }],
    },
    proxyTrackingReadiness: {
      codingAgentBaseUrlMode: {
        codex: "possible-if-using-api-key-mode",
        claudeCode: "limited-for-subscription-sessions",
      },
    },
    topTokenLeaks: getTopTokenLeaks(issues),
    hasClaudeIgnore: false,
    repoDetected: true,
  };
}

function renderDemoTerminal() {
  return [
    color("PrismoDev Product Loop", "bold"),
    "",
    "Before session",
    `${NPX_COMMAND} doctor`,
    "- Diagnose token/context waste",
    "- Apply safe ignore/context fixes",
    "- Show before/after score",
    "",
    "During session",
    `${NPX_COMMAND} watch`,
    "- Context Pressure: HIGH",
    "- Recent Growth: +380k",
    "- package-lock.json likely entered context",
    "- Suggested Action: start from a scoped context pack",
    "",
    "After session",
    `${NPX_COMMAND} cc timeline`,
    "- Context spikes",
    "- Repeated command loops",
    "- Artifact leaks",
    "- Better next action",
    "",
    "Local-only: PrismoDev reads repo files and local coding-agent logs. It does not upload data.",
    "",
    "Try it on your repo:",
    `1. ${NPX_COMMAND} doctor`,
    `2. ${NPX_COMMAND} watch --once`,
    `3. ${NPX_COMMAND} cc timeline`,
  ].join("\n");
}

function runDevFlow(rootDir = process.cwd(), options = {}) {
  const root = path.resolve(rootDir);
  const scanDone = printStep("Scanning repo and local usage", options.json);
  const scan = scanRepo(root, { includeUsage: true, usageLimit: options.limit || 3 });
  scanDone();
  const initialContext = createOptimizeContext(root);
  const scope = initialContext.frameworks.some((name) => ["Next.js", "React", "Vite"].includes(name)) ? "frontend" : null;
  const optimizeDone = printStep("Generating compact context files", options.json);
  const optimize = runOptimize(root, { scope });
  optimizeDone();
  const ctx = createOptimizeContext(root, scope);
  const prompt = renderContextCommand(ctx, scope);
  return {
    scan,
    optimize,
    scope,
    prompt,
    nextCommands: getNextCommands(scan, scope),
  };
}

function runDoctor(rootDir = process.cwd(), options = {}) {
  const root = path.resolve(rootDir);
  const scanDone = printStep("Scanning repo and local usage", options.json);
  const before = scanRepo(root, {
    includeUsage: true,
    usageLimit: options.limit || 3,
    usageTool: options.usageTool || "all",
  });
  scanDone();

  const fixDone = printStep(options.dryRun ? "Planning safe AI-context fixes" : "Applying safe AI-context fixes", options.json);
  const applyIgnoresOnly = Boolean(options.applyIgnoresOnly);
  const noContextPacks = Boolean(options.noContextPacks || applyIgnoresOnly);
  const fixActions = applyFixes(before, { dryRun: options.dryRun, ignoresOnly: applyIgnoresOnly });
  fixDone();

  const initialContext = createOptimizeContext(root);
  const scope = options.scope || chooseRecommendedScope(initialContext);
  let optimize = { root, scope, generatedFiles: [], skipped: true };
  if (!noContextPacks) {
    const optimizeDone = printStep(options.dryRun ? "Planning compact context packs" : "Generating compact context packs", options.json);
    optimize = runOptimize(root, { scope, dryRun: options.dryRun });
    optimizeDone();
  }

  let after = before;
  if (!options.dryRun) {
    const rescanDone = printStep("Re-scanning optimized repo", options.json);
    after = scanRepo(root, {
      includeUsage: true,
      usageLimit: options.limit || 3,
      usageTool: options.usageTool || "all",
    });
    rescanDone();
  }

  const ctx = createOptimizeContext(root, scope);
  const beforeExposedTokens = estimateExposedContextTokens(before);
  const afterExposedTokens = estimateExposedContextTokens(after);
  const exposedTokenReductionPercent = calculateReductionPercent(beforeExposedTokens, afterExposedTokens);
  const contextCommand = `${NPX_COMMAND} context${scope ? ` ${scope}` : ""}`;

  return {
    root,
    before,
    after,
    scope,
    fixActions,
    optimize,
    generatedFiles: optimize.generatedFiles,
    beforeExposedTokens,
    afterExposedTokens,
    exposedTokenReductionPercent,
    contextFile: getContextFileForScope(ctx, scope),
    contextCommand,
    starterPrompt: renderStarterPrompt(ctx, scope),
    nextCommands: Array.from(new Set([
      contextCommand,
      `${NPX_COMMAND} watch --auto`,
      before.realUsage && before.realUsage.sessions.length ? `${NPX_COMMAND} cc` : `${NPX_COMMAND} scan --usage`,
    ])),
    dryRun: Boolean(options.dryRun),
    applyIgnoresOnly,
    noContextPacks,
    generatedAt: new Date().toISOString(),
  };
}

function renderPrismoReadme() {
  return [
    "# PrismoDev",
    "",
    "Local AI coding workflow helpers for this repo.",
    "",
    "## Core Loop",
    "",
    "- Before a session: `npx getprismo doctor`",
    "- During a session: `npx getprismo watch`",
    "- After a session: `npx getprismo cc`",
    "- For scoped context: `npx getprismo context <scope>`",
    "",
    "PrismoDev is local-first. It reads repo files and local coding-agent logs when available; it does not upload data.",
    "",
  ].join("\n");
}

function runInit(rootDir = process.cwd(), options = {}) {
  const root = path.resolve(rootDir);
  const actions = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Path not found: ${root}`);
  }
  const readmePath = path.join(root, ".prismo", "README.md");
  if (options.dryRun) {
    actions.push("Would create .prismo/README.md");
  } else {
    const written = writeGeneratedFile(root, path.join(".prismo", "README.md"), renderPrismoReadme());
    actions.push(`Created ${written.path}`);
  }

  const packagePath = path.join(root, "package.json");
  if (fs.existsSync(packagePath)) {
    const pkg = safeReadJson(packagePath);
    if (pkg && typeof pkg === "object") {
      pkg.scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
      const scripts = {
        "ai:doctor": "prismo doctor",
        "ai:watch": "prismo watch",
        "ai:context": "prismo context",
        "ai:scan": "prismo scan --usage",
      };
      const added = [];
      for (const [name, command] of Object.entries(scripts)) {
        if (!pkg.scripts[name]) {
          pkg.scripts[name] = command;
          added.push(name);
        }
      }
      if (added.length) {
        if (options.dryRun) {
          actions.push(`Would add npm scripts: ${added.join(", ")}`);
        } else {
          const backupPath = backupIfExists(packagePath);
          fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
          actions.push(`Added npm scripts: ${added.join(", ")}`);
          if (backupPath) actions.push(`Backed up package.json to ${path.basename(backupPath)}`);
        }
      } else {
        actions.push("Prismo npm scripts already exist");
      }
    }
  } else {
    actions.push("No package.json found; skipped npm scripts");
  }
  return {
    root,
    actions,
    dryRun: Boolean(options.dryRun),
    generatedAt: new Date().toISOString(),
  };
}

function renderInitTerminal(result) {
  const lines = [];
  lines.push("");
  lines.push("Prismo Init");
  if (result.dryRun) lines.push("Mode: dry run (no files changed)");
  lines.push("");
  result.actions.forEach((action) => lines.push(`- ${action}`));
  lines.push("");
  lines.push("Next:");
  lines.push(`${NPX_COMMAND} doctor`);
  return lines.join("\n");
}

function toDoctorJsonPayload(result) {
  const usage = result.before.realUsage;
  const compactRealUsage = usage
    ? {
        confidence: usage.confidence,
        totals: usage.totals,
        sources: usage.sources,
      }
    : null;
  return {
    schemaVersion: 1,
    scannedPath: result.root,
    before: {
      score: result.before.score,
      riskLevel: result.before.risk,
      tokenLeaks: result.before.issues.length,
      estimatedExposedContextTokens: result.beforeExposedTokens,
      realUsage: compactRealUsage,
    },
    after: {
      score: result.after.score,
      riskLevel: result.after.risk,
      tokenLeaks: result.after.issues.length,
      estimatedExposedContextTokens: result.afterExposedTokens,
    },
    scoreDelta: result.after.score - result.before.score,
    exposedTokenReductionPercent: result.exposedTokenReductionPercent,
    fixActions: result.fixActions,
    generatedFiles: result.generatedFiles,
    filesCreatedOrPlanned: [...result.fixActions, ...result.generatedFiles.map((file) => `${result.dryRun ? "Would generate" : "Generated"} ${file}`)],
    stillRisky: result.after.issues.slice(0, 5).map((issue) => ({
      severity: issue.severity,
      category: issue.category,
      title: issue.title,
      recommendation: issue.recommendation,
    })),
    scope: result.scope,
    contextFile: result.contextFile,
    contextCommand: result.contextCommand,
    starterPrompt: result.starterPrompt,
    nextCommands: result.nextCommands,
    dryRun: result.dryRun,
    applyIgnoresOnly: result.applyIgnoresOnly,
    noContextPacks: result.noContextPacks,
    generatedAt: result.generatedAt,
  };
}

function renderDoctorTerminal(result) {
  const scoreDelta = result.after.score - result.before.score;
  const scoreDeltaLabel = scoreDelta > 0 ? `+${scoreDelta}` : String(scoreDelta);
  const lines = [];
  lines.push("");
  lines.push(color("PrismoDev Doctor", "bold"));
  if (result.dryRun) lines.push("Mode: dry run (no files changed)");
  lines.push("");
  lines.push(`Before: ${result.before.score}/100 - ${result.before.risk} risk - ${result.before.issues.length} token leak${result.before.issues.length === 1 ? "" : "s"}`);
  if (result.dryRun) lines.push("After:  run without --dry-run to apply safe fixes and re-scan");
  else lines.push(`After:  ${result.after.score}/100 - ${result.after.risk} risk - ${result.after.issues.length} token leak${result.after.issues.length === 1 ? "" : "s"} (${scoreDeltaLabel})`);
  if (result.before.realUsage && result.before.realUsage.sessions.length) {
    lines.push(`Local usage: ${formatTokenCount(result.before.realUsage.totals.displayTokens)} tokens across ${result.before.realUsage.sessions.length} recent session(s)`);
  }
  lines.push(`Estimated exposed context reduction: ${result.exposedTokenReductionPercent}%`);
  if (!result.dryRun) {
    lines.push(`Payoff: ${scoreDelta > 0 ? `repo is ${scoreDelta} points cleaner for AI coding sessions` : "safe fixes applied; remaining risk needs manual cleanup"}`);
  }
  lines.push("");
  lines.push(result.dryRun ? "Would Fix:" : "Fixed:");
  if (result.fixActions.length) result.fixActions.forEach((action) => lines.push(`- ${action}`));
  else lines.push("- No safe fix files needed");
  if (result.noContextPacks) {
    lines.push("- Context pack generation skipped");
  } else {
    result.generatedFiles.slice(0, 8).forEach((file) => lines.push(`- ${result.dryRun ? "Would generate" : "Generated"} ${file}`));
    if (result.generatedFiles.length > 8) lines.push(`- ${result.dryRun ? "Would generate" : "Generated"} ${result.generatedFiles.length - 8} more .prismo file(s)`);
  }
  const stillRisky = result.after.issues.slice(0, 3);
  if (!result.dryRun && stillRisky.length) {
    lines.push("");
    lines.push("Still Risky:");
    stillRisky.forEach((issue) => lines.push(`- ${issue.title} -> ${issue.recommendation}`));
  }
  if (!result.dryRun && !stillRisky.length) {
    lines.push("");
    lines.push("Still Risky:");
    lines.push("- No major token-waste risks remain.");
  }
  lines.push("");
  lines.push("Recommended starting context:");
  lines.push(result.noContextPacks ? "Run doctor again without --no-context-packs when you want .prismo context files." : result.contextFile);
  lines.push("");
  lines.push("Next:");
  result.nextCommands.forEach((command, index) => lines.push(`${index + 1}. ${command}`));
  lines.push("");
  lines.push("Next live session:");
  lines.push(`${NPX_COMMAND} watch --auto`);
  lines.push("Tell your agent: Follow .prismo/live-guardrails.md during this session.");
  lines.push("");
  lines.push("Doctor only creates safe recommendation/context files. It does not overwrite CLAUDE.md, AGENTS.md, .gitignore, or source code.");
  return lines.join("\n");
}

function renderDevTerminal(result) {
  const lines = [];
  lines.push("");
  lines.push(color("PrismoDev", "bold"));
  lines.push("");
  lines.push(`Score: ${result.scan.score}/100  |  Risk: ${result.scan.risk}  |  Token leaks: ${result.scan.issues.length}`);
  if (result.scan.realUsage && result.scan.realUsage.sessions.length) {
    lines.push(`Real local usage: ${formatTokenCount(result.scan.realUsage.totals.displayTokens)} tokens (${result.scan.realUsage.confidence})`);
  } else if (result.scan.realUsage) {
    lines.push("Real local usage: no matching local sessions found for this repo");
  }
  lines.push("");
  lines.push("Generated:");
  result.optimize.generatedFiles.slice(0, 8).forEach((file) => lines.push(`- ${file}`));
  lines.push("");
  lines.push("Next Commands:");
  result.nextCommands.forEach((cmd, index) => lines.push(`${index + 1}. ${cmd}`));
  lines.push("");
  lines.push("Paste-ready prompt:");
  lines.push(renderStarterPrompt(createOptimizeContext(result.optimize.root, result.scope), result.scope));
  lines.push("");
  return lines.join("\n");
}

  return {
    createDemoResult,
    renderDemoTerminal,
    renderDevTerminal,
    renderDoctorTerminal,
    renderInitTerminal,
    renderPrismoReadme,
    runDevFlow,
    runDoctor,
    runInit,
    toDoctorJsonPayload,
  };
};
