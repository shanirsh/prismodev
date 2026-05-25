# PrismoDev MCP

PrismoDev can run as a local MCP server so compatible coding agents can inspect token waste, run noisy commands through shield, search stored output, and request scoped context without pasting huge logs into chat.

## Start

```bash
npx getprismo mcp /path/to/your/repo
```

## Doctor

Before adding PrismoDev to a client, validate the local MCP surface:

```bash
npx getprismo mcp doctor /path/to/your/repo
```

This checks that the MCP server can expose all Prismo tools, runs a scan smoke test, and prints a ready-to-use client config snippet.

## Generic MCP Config

```json
{
  "mcpServers": {
    "prismodev": {
      "command": "npx",
      "args": ["-y", "getprismo", "mcp", "/path/to/your/repo"]
    }
  }
}
```

For local development from this repo:

```json
{
  "mcpServers": {
    "prismodev": {
      "command": "node",
      "args": ["/path/to/prismodev/bin/prismo.js", "mcp", "/path/to/your/repo"]
    }
  }
}
```

## Tools

- `prismo_scan`: scan repo context/token waste
- `prismo_doctor_dry_run`: preview doctor payoff without writing files
- `prismo_watch_snapshot`: inspect live context pressure
- `prismo_multi_agent_watch`: inspect coordination risks across parallel local agents
- `prismo_shield_run`: run a noisy command and store full output locally
- `prismo_shield_search`: search stored shield output
- `prismo_shield_last`: list recent shielded command runs
- `prismo_context_pack`: generate or preview scoped context packs
- `prismo_firewall`: create a scoped context policy for a task
- `prismo_cc_timeline`: inspect Claude Code session postmortems

## Best Workflow

Ask your agent:

```text
Run the failing test command through Prismo shield, then search the stored output for the real error. Do not paste the full log into chat.
```

The agent should call:

1. `prismo_shield_run`
2. `prismo_shield_search`

This keeps full stdout/stderr in `.prismo/shield/runs/` and only brings the useful failure snippet back into the model context.

## Watch Integration

When `npx getprismo watch` detects a tool-output flood or repeated command loop, it now prints a Shield Plan:

```text
Shield Plan
Tool output is flooding context; shield the command so full logs stay local.
Run: npx getprismo shield -- <noisy command>
Then: npx getprismo shield search "<error text>"
MCP: prismo_shield_run -> prismo_shield_search
```

That is the intended live-session recovery path.
