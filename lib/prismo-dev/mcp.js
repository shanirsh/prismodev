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
      tool: { type: "string", enum: ["all", "codex", "claude"], description: "Which local session logs to inspect." },
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
        usageTool: args.tool || "all",
      });
      return createTextResult(summary);
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

module.exports = {
  createMcpTools,
  runMcpServer,
};
