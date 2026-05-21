# PrismoDev Live Demo

Use this flow to show the full product loop on a real repo.

## 1. Before Session: Doctor

```bash
npx getprismo doctor
```

Shows:

- before/after repo score
- missing `.claudeignore` / `.cursorignore`
- generated artifacts exposed to AI context
- compact `.prismo/` context packs
- recommended next starting context

## 2. During Session: Watch

```bash
npx getprismo watch --once
```

Shows:

- context pressure
- session size
- recent context growth
- repeated file reads
- generated artifact leaks
- possible loops
- shield recommendation when command output is flooding context

If watch sees noisy output, the important part is:

```text
Shield Plan
Run: npx getprismo shield -- <noisy command>
Then: npx getprismo shield search "<error text>"
MCP: prismo_shield_run -> prismo_shield_search
```

## 3. Noisy Commands: Shield

```bash
npx getprismo shield -- npm test
npx getprismo shield search "AUTH_FAILURE"
npx getprismo shield last
```

Shows:

- compact command summary
- useful error lines
- full output stored locally
- searchable SQLite FTS index when `sqlite3` is available

Full output stays in:

```text
.prismo/shield/runs/
```

## 4. Agent-Native Mode: MCP

```bash
npx getprismo mcp /path/to/repo
```

Demo prompt:

```text
Use Prismo MCP to run the failing test through shield. Search the stored output for the root error. Do not paste the full test log into the chat.
```

Expected MCP tool flow:

1. `prismo_shield_run`
2. `prismo_shield_search`
3. `prismo_context_pack` if the agent needs scoped repo context

## 5. After Session: Timeline

```bash
npx getprismo cc timeline
```

Shows:

- generated artifacts that entered context
- repeated file/path mentions
- repeated command/tool patterns
- suggested cleanup action

## Screenshot Commands

For a quick terminal screenshot:

```bash
npx getprismo doctor
```

For the proactive story:

```bash
npx getprismo watch --once
```

For the MCP/shield story:

```bash
npx getprismo shield -- npm test
npx getprismo shield search "error"
```
