const path = require("path");

// Commands whose output reliably floods agent context and should run through
// shield (full output to disk, compact summary to the model).
const NOISY_COMMAND_PATTERNS = [
  { re: /(^|\s)(jest|vitest|mocha|pytest|rspec|phpunit|ava|tap)(\s|$)|(\b(npm|yarn|pnpm|bun)\s+(run\s+)?test\b)|\b(go|cargo)\s+test\b/, why: "test runs emit large pass/fail output" },
  { re: /(^|\s)(webpack|rollup|esbuild|vite|tsc)(\s|$)|\b(next|nuxt|astro)\s+build\b|\b(npm|yarn|pnpm|bun)\s+(run\s+)?build\b|\b(go|cargo)\s+build\b|(^|\s)make(\s|$)/, why: "builds emit long compiler/bundler output" },
  { re: /\b(npm|pnpm|bun)\s+(install|ci|i)\b|\byarn(\s+install)?\b|\bpip\s+install\b|\bbundle\s+install\b/, why: "installs print large dependency trees" },
  { re: /(^|\s)(eslint|ruff|flake8|mypy|pylint)(\s|$)|\b(npm|yarn|pnpm)\s+(run\s+)?lint\b|tsc\s+--noEmit/, why: "linters/type-checkers emit many diagnostics" },
  { re: /\b(playwright|cypress|e2e)\b/, why: "e2e runs dump verbose logs" },
  { re: /\bdocker\s+build\b|\bterraform\b|\bkubectl\s+logs\b|\bcoverage\b|--verbose\b/, why: "infra/coverage/verbose commands flood output" },
];
const QUICK_COMMAND_PATTERNS = [
  /(^|\s)(git\s+(status|log|diff|branch|show)|ls|pwd|whoami|which|echo|cat|head|tail|wc|env|date|node\s+-v|--version)(\s|$)/,
];

function classifyCommandForShield(command, repeatedCommands = []) {
  const cmd = String(command || "").trim();
  if (!cmd) return { shouldShield: false, confidence: "low", reason: "No command provided." };
  const normalized = cmd.replace(/\s+/g, " ");
  const repeated = (repeatedCommands || []).some((item) => {
    const value = String(item.value || "").replace(/\s+/g, " ");
    return value && (normalized.includes(value) || value.includes(normalized)) && Number(item.count || 0) >= 3;
  });
  if (repeated) {
    return { shouldShield: true, confidence: "high", reason: "This command has already repeated several times in recent sessions; shield it so each retry costs a summary, not full output." };
  }
  const noisy = NOISY_COMMAND_PATTERNS.find((entry) => entry.re.test(normalized));
  if (noisy) {
    return { shouldShield: true, confidence: "high", reason: `Shield recommended: ${noisy.why}.` };
  }
  if (QUICK_COMMAND_PATTERNS.some((re) => re.test(normalized))) {
    return { shouldShield: false, confidence: "high", reason: "Quick, low-output command; shielding is unnecessary." };
  }
  return { shouldShield: false, confidence: "low", reason: "No known flooding pattern; shield only if you expect large output." };
}

function createTextResult(payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text", text }],
  };
}

function normalizeArgs(args) {
  return args && typeof args === "object" ? args : {};
}

function makeTool(name, description, properties = {}, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function createMcpTools(deps) {
  const {
    rootDir,
    scanRepo,
    toJsonPayload,
    runDoctor,
    toDoctorJsonPayload,
    getUsageSummary,
    getClaudeCodeCostSummary,
    getCursorSessionSummary,
    buildBoundaryCheck,
    buildInstructionsAblationPlan,
    buildInstructionsAudit,
    buildMultiSessionTimeline,
    buildReceipt,
    buildReplay,
    runOptimize,
    createOptimizeContext,
    renderStarterPrompt,
    runFirewall,
    runShield,
    runShieldLast,
    runShieldSearch,
  } = deps;

  const pathProperty = {
    type: "string",
    description: "Repository path. Defaults to the repo used when the MCP server started.",
  };
  const limitProperty = {
    type: "number",
    description: "Maximum number of recent sessions or runs to inspect.",
  };
  const scopeProperty = {
    type: "string",
    description: "Optional scope such as frontend, backend, auth, tests, billing, or routing.",
  };

  const tools = [
    makeTool("prismo_scan", "Scan a repo for AI coding token/context waste.", {
      path: pathProperty,
      includeUsage: { type: "boolean", description: "Include local Claude/Codex usage logs when available." },
      limit: limitProperty,
    }),
    makeTool("prismo_doctor_dry_run", "Preview PrismoDev doctor fixes and before/after payoff without writing files.", {
      path: pathProperty,
      scope: scopeProperty,
      limit: limitProperty,
    }),
    makeTool("prismo_watch_snapshot", "Return a one-shot local session/context pressure snapshot.", {
      path: pathProperty,
      tool: { type: "string", enum: ["all", "codex", "claude", "cursor"], description: "Which local session logs to inspect." },
      limit: limitProperty,
    }),
    makeTool("prismo_multi_agent_watch", "Return multi-agent coordination risks across visible local Codex/Claude sessions.", {
      path: pathProperty,
      tool: { type: "string", enum: ["all", "codex", "claude", "cursor"], description: "Which local session logs to inspect." },
      limit: limitProperty,
    }),
    makeTool("prismo_shield_run", "Run a noisy command through Prismo shield and store full output locally.", {
      path: pathProperty,
      command: {
        type: "array",
        items: { type: "string" },
        description: "Command argv array, for example [\"npm\", \"test\"].",
      },
    }, ["command"]),
    makeTool("prismo_shield_search", "Search stored shield stdout/stderr without loading full logs into context.", {
      path: pathProperty,
      query: { type: "string", description: "Text to search for in stored shield output." },
      limit: limitProperty,
    }, ["query"]),
    makeTool("prismo_shield_last", "List recent shielded command runs.", {
      path: pathProperty,
      limit: limitProperty,
    }),
    makeTool("prismo_context_pack", "Generate or preview a scoped Prismo context pack/starter prompt.", {
      path: pathProperty,
      scope: scopeProperty,
      dryRun: { type: "boolean", description: "When true, do not write .prismo files." },
    }),
    makeTool("prismo_firewall", "Generate a scoped context firewall policy for a task.", {
      path: pathProperty,
      task: { type: "string", description: "Task description such as auth-bug or frontend-test-failure." },
      scope: scopeProperty,
      dryRun: { type: "boolean", description: "When true, preview allowed/blocked context without writing files." },
    }),
    makeTool("prismo_cc_timeline", "Return the latest Claude Code session timeline/postmortem data.", {
      path: pathProperty,
      limit: limitProperty,
    }),
    makeTool("prismo_cursor_sessions", "Return Cursor session data including AI authorship, conversations, and AI-generated file tracking.", {
      path: pathProperty,
      limit: limitProperty,
      command: { type: "string", enum: ["latest", "list", "authorship", "timeline", "files"], description: "Subcommand: latest (summary), list (sessions), authorship (AI%), timeline (events), files (AI-generated)." },
    }),
    makeTool("prismo_receipt", "Return a run receipt covering repeated reads, tool output, artifacts, likely influence, and next-run scope.", {
      path: pathProperty,
      tool: { type: "string", enum: ["all", "codex", "claude", "cursor"], description: "Which local session logs to inspect." },
      limit: limitProperty,
    }),
    makeTool("prismo_instructions_audit", "Audit persistent instruction files for useful rules, observable violations, partial compliance, duplicates, and influence-unknown rules.", {
      path: pathProperty,
      limit: limitProperty,
    }),
    makeTool("prismo_instructions_ablate", "Create a dry-run instruction ablation plan with candidates, protocol, and variance warnings.", {
      path: pathProperty,
      limit: limitProperty,
      samples: { type: "number", description: "Comparable session sample target for controlled ablation." },
    }),
    makeTool("prismo_timeline", "Return recurring context-waste patterns across recent sessions.", {
      path: pathProperty,
      tool: { type: "string", enum: ["all", "codex", "claude", "cursor"], description: "Which local session logs to inspect." },
      limit: limitProperty,
    }),
    makeTool("prismo_replay", "Return incident replay and recovery prompt for recent coding-agent sessions.", {
      path: pathProperty,
      tool: { type: "string", enum: ["all", "codex", "claude", "cursor"], description: "Which local session logs to inspect." },
      limit: limitProperty,
    }),
    makeTool("prismo_boundaries", "Check whether parallel agents are isolated or overlapping in the same repo/worktree.", {
      path: pathProperty,
      tool: { type: "string", enum: ["all", "codex", "claude", "cursor"], description: "Which local session logs to inspect." },
      limit: limitProperty,
    }),
    // Agent-native, mid-loop decision tools: tight yes/no answers an agent can
    // act on during a session, not analysis dumps.
    makeTool("prismo_should_shield", "Decide whether a shell command should be run through Prismo shield (full output to disk, compact summary to context) before you run it. Call this before any command that might print a lot.", {
      command: { type: "string", description: "The exact shell command you are about to run." },
      path: pathProperty,
    }, ["command"]),
    makeTool("prismo_loop_check", "Check whether the current coding session is stuck in a loop (repeating the same command or failing repeatedly). Call this when you have retried something more than once.", {
      path: pathProperty,
      tool: { type: "string", enum: ["all", "codex", "claude", "cursor"], description: "Which local session logs to inspect." },
    }),
    makeTool("prismo_context_guard", "Get what repo you are in, which paths to avoid rereading, files you have already read repeatedly, and the compact context pack to start from. Call this at the start of a session or before broad exploration.", {
      path: pathProperty,
      scope: scopeProperty,
    }),
  ];

  function resolveRoot(args) {
    return args.path || rootDir || process.cwd();
  }

  async function callTool(name, rawArgs) {
    const args = normalizeArgs(rawArgs);
    const target = resolveRoot(args);

    if (name === "prismo_scan") {
      return createTextResult(toJsonPayload(scanRepo(target, {
        includeUsage: Boolean(args.includeUsage),
        usageLimit: Number(args.limit) || 5,
      })));
    }

    if (name === "prismo_doctor_dry_run") {
      const result = runDoctor(target, {
        dryRun: true,
        scope: args.scope || null,
        limit: Number(args.limit) || 3,
      });
      return createTextResult(toDoctorJsonPayload(result));
    }

    if (name === "prismo_watch_snapshot") {
      const summary = getUsageSummary({
        cwd: target,
        limit: Number(args.limit) || 3,
        tool: args.tool || "all",
      });
      return createTextResult(summary);
    }

    if (name === "prismo_multi_agent_watch") {
      const summary = getUsageSummary({
        cwd: target,
        limit: Number(args.limit) || 8,
        tool: args.tool || "all",
      });
      return createTextResult({
        schemaVersion: 1,
        generatedAt: summary.generatedAt,
        scannedPath: summary.scannedPath,
        tool: summary.tool,
        totals: summary.totals,
        multiAgent: summary.multiAgent,
      });
    }

    if (name === "prismo_shield_run") {
      return createTextResult(runShield(target, args.command));
    }

    if (name === "prismo_shield_search") {
      return createTextResult(runShieldSearch(target, args.query, { limit: Number(args.limit) || 5 }));
    }

    if (name === "prismo_shield_last") {
      return createTextResult(runShieldLast(target, { limit: Number(args.limit) || 5 }));
    }

    if (name === "prismo_context_pack") {
      const scope = args.scope || null;
      const result = runOptimize(target, { scope, dryRun: args.dryRun !== false });
      const context = createOptimizeContext(target, scope);
      return createTextResult({
        ...result,
        starterPrompt: renderStarterPrompt(context, scope),
      });
    }

    if (name === "prismo_firewall") {
      return createTextResult(runFirewall(target, {
        task: args.task || args.scope || "general",
        scope: args.scope || null,
        dryRun: args.dryRun !== false,
      }));
    }

    if (name === "prismo_cc_timeline") {
      return createTextResult(getClaudeCodeCostSummary({
        cwd: target,
        limit: Number(args.limit) || 1,
        mode: "timeline",
      }));
    }

    if (name === "prismo_cursor_sessions") {
      if (!getCursorSessionSummary) throw new Error("Cursor session support not available");
      return createTextResult(getCursorSessionSummary({
        cwd: target,
        limit: Number(args.limit) || 20,
        mode: args.command || "latest",
      }));
    }

    if (name === "prismo_receipt") {
      return createTextResult(buildReceipt({
        cwd: target,
        tool: args.tool || "all",
        limit: Number(args.limit) || 5,
      }));
    }

    if (name === "prismo_instructions_audit") {
      return createTextResult(buildInstructionsAudit({
        cwd: target,
        limit: Number(args.limit) || 20,
      }));
    }

    if (name === "prismo_instructions_ablate") {
      return createTextResult(buildInstructionsAblationPlan({
        cwd: target,
        limit: Number(args.limit) || 20,
        samples: Number(args.samples) || 10,
      }));
    }

    if (name === "prismo_timeline") {
      return createTextResult(buildMultiSessionTimeline({
        cwd: target,
        tool: args.tool || "all",
        limit: Number(args.limit) || 20,
      }));
    }

    if (name === "prismo_replay") {
      return createTextResult(buildReplay({
        cwd: target,
        tool: args.tool || "all",
        limit: Number(args.limit) || 5,
      }));
    }

    if (name === "prismo_boundaries") {
      return createTextResult(buildBoundaryCheck({
        cwd: target,
        tool: args.tool || "all",
        limit: Number(args.limit) || 10,
      }));
    }

    if (name === "prismo_should_shield") {
      let repeatedCommands = [];
      try {
        const summary = getUsageSummary({ cwd: target, limit: 3, tool: "all" });
        const latest = (summary.sessions || [])[0];
        repeatedCommands = (latest && latest.repeatedCommands) || [];
      } catch { /* command classification still works without session context */ }
      const decision = classifyCommandForShield(args.command, repeatedCommands);
      return createTextResult({
        schemaVersion: 1,
        command: args.command,
        shouldShield: decision.shouldShield,
        confidence: decision.confidence,
        reason: decision.reason,
        recommended: decision.shouldShield
          ? `npx -y getprismo@latest shield -- ${String(args.command || "").trim()}`
          : null,
        note: "Shield stores full stdout/stderr locally and returns a compact summary, so the output never floods context.",
      });
    }

    if (name === "prismo_loop_check") {
      const summary = getUsageSummary({ cwd: target, limit: 3, tool: args.tool || "all" });
      const latest = (summary.sessions || [])[0] || null;
      const repeatedCommands = (latest && latest.repeatedCommands) || [];
      const looping = Boolean(latest && latest.loopSuspicion) || repeatedCommands.some((c) => Number(c.count || 0) >= 4);
      const topRepeat = repeatedCommands[0] || null;
      return createTextResult({
        schemaVersion: 1,
        looping,
        confidence: latest ? (latest.loopConfidence || (looping ? "medium" : "low")) : "low",
        signals: {
          repeatedCommands: repeatedCommands.slice(0, 5),
          failureMentions: latest ? Number(latest.failureMentions || 0) : 0,
          turns: latest ? Number(latest.turns || 0) : 0,
        },
        advice: looping
          ? `You appear to be looping${topRepeat ? ` on \`${topRepeat.value}\` (${topRepeat.count}x)` : ""}. Stop retrying, change the approach, and capture the command once with \`npx -y getprismo@latest shield -- <command>\` instead of re-running it.`
          : "No loop detected. Keep going.",
      });
    }

    if (name === "prismo_context_guard") {
      const scope = args.scope || null;
      const scan = scanRepo(target, { includeUsage: true, usageLimit: 3 });
      const ctx = createOptimizeContext(target, scope);
      const usage = scan.realUsage && scan.realUsage.sessions ? scan.realUsage.sessions : [];
      const repeatedlyRead = [];
      for (const session of usage) {
        for (const item of session.repeatedPathMentions || []) {
          if (Number(item.count || 0) >= 4) repeatedlyRead.push({ path: item.value, reads: item.count });
        }
      }
      const blocked = (scan.recommendedClaudeIgnore || []).slice(0, 24);
      return createTextResult({
        schemaVersion: 1,
        repo: path.basename(path.resolve(target)),
        avoidRereading: {
          blockedContext: blocked,
          alreadyReadRepeatedly: repeatedlyRead.slice(0, 12),
        },
        startFrom: {
          contextFile: scope ? `.prismo/${scope}-summary.md` : ".prismo/architecture-summary.md",
          starterPrompt: renderStarterPrompt(ctx, scope),
        },
        advice: "Read the start-from context pack first. Do not reread blocked paths or files you have already read several times; quote what you already saw instead.",
      });
    }

    throw new Error(`Unknown MCP tool: ${name}`);
  }

  return { tools, callTool };
}

function runMcpServer(deps) {
  const readline = require("readline");
  const { packageVersion = "0.0.0" } = deps;
  const { tools, callTool } = createMcpTools(deps);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  async function handle(message) {
    if (!message || !message.method) return;
    if (!Object.prototype.hasOwnProperty.call(message, "id")) return;

    try {
      if (message.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "prismodev", version: packageVersion },
          },
        });
        return;
      }

      if (message.method === "tools/list") {
        send({ jsonrpc: "2.0", id: message.id, result: { tools } });
        return;
      }

      if (message.method === "tools/call") {
        const params = normalizeArgs(message.params);
        const result = await callTool(params.name, params.arguments);
        send({ jsonrpc: "2.0", id: message.id, result });
        return;
      }

      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error && error.message ? error.message : String(error),
        },
      });
    }
  }

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: error && error.message ? error.message : String(error),
        },
      });
    }
  });
}

async function runMcpDoctor(deps) {
  const { rootDir, packageVersion = "0.0.0" } = deps;
  const { tools, callTool } = createMcpTools(deps);
  const requiredTools = [
    "prismo_scan",
    "prismo_doctor_dry_run",
    "prismo_watch_snapshot",
    "prismo_multi_agent_watch",
    "prismo_shield_run",
    "prismo_shield_search",
    "prismo_shield_last",
    "prismo_context_pack",
    "prismo_firewall",
    "prismo_cc_timeline",
    "prismo_cursor_sessions",
    "prismo_receipt",
    "prismo_instructions_audit",
    "prismo_instructions_ablate",
    "prismo_timeline",
    "prismo_replay",
    "prismo_boundaries",
    "prismo_should_shield",
    "prismo_loop_check",
    "prismo_context_guard",
  ];
  const toolNames = tools.map((tool) => tool.name);
  const missingTools = requiredTools.filter((name) => !toolNames.includes(name));
  const scanResult = await callTool("prismo_scan", { path: rootDir, includeUsage: false, limit: 1 });
  let scanPayload = {};
  try {
    scanPayload = JSON.parse(scanResult.content?.[0]?.text || "{}");
  } catch {
    scanPayload = {};
  }
  const config = {
    mcpServers: {
      prismodev: {
        command: "npx",
        args: ["-y", "getprismo", "mcp", rootDir],
      },
    },
  };
  return {
    schemaVersion: 1,
    ok: missingTools.length === 0 && Boolean(scanPayload.schemaVersion),
    server: {
      name: "prismodev",
      version: packageVersion,
      transport: "stdio",
      root: rootDir,
    },
    tools: {
      count: tools.length,
      required: requiredTools,
      missing: missingTools,
      hasShield: toolNames.includes("prismo_shield_run") && toolNames.includes("prismo_shield_search"),
    },
    smoke: {
      scan: {
        ok: Boolean(scanPayload.schemaVersion),
        score: scanPayload.score ?? null,
        riskLevel: scanPayload.riskLevel ?? null,
      },
    },
    config,
    next: [
      "Add the config snippet to your MCP-compatible client.",
      "Restart the client and confirm prismodev appears in the MCP tool list.",
      "Ask the agent to call prismo_scan, prismo_multi_agent_watch, or prismo_shield_run.",
    ],
  };
}

function renderMcpDoctorTerminal(result) {
  const lines = [];
  lines.push("");
  lines.push("Prismo MCP Doctor");
  lines.push("");
  lines.push(`Status: ${result.ok ? "ready" : "needs attention"}`);
  lines.push(`Server: ${result.server.name}@${result.server.version}`);
  lines.push(`Transport: ${result.server.transport}`);
  lines.push(`Repo: ${result.server.root}`);
  lines.push("");
  lines.push("Checks");
  lines.push(`- Tools exposed: ${result.tools.count}`);
  lines.push(`- Required tools missing: ${result.tools.missing.length ? result.tools.missing.join(", ") : "none"}`);
  lines.push(`- Shield tools: ${result.tools.hasShield ? "ready" : "missing"}`);
  lines.push(`- Scan smoke: ${result.smoke.scan.ok ? `ok (${result.smoke.scan.score}/100, ${result.smoke.scan.riskLevel})` : "failed"}`);
  lines.push("");
  lines.push("MCP config");
  lines.push("");
  lines.push(JSON.stringify(result.config, null, 2));
  lines.push("");
  lines.push("Next");
  result.next.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  return lines.join("\n");
}

module.exports = {
  createMcpTools,
  renderMcpDoctorTerminal,
  runMcpDoctor,
  runMcpServer,
};
