# prismodev

find token waste before your coding agent eats the whole repo.

prismodev is a local cli for codex, claude code, cursor, and other ai coding workflows. it scans your project, points out noisy files, reads local usage logs when they exist, and generates smaller context packs so your agent has less junk to carry around.

MIT license

## what it does

- repo scan — finds big files, generated folders, missing ignores, and oversized instruction docs
- local usage — reads codex and claude code logs when token fields are available
- claude code cost — shows session spend, cache write/read cost, cost drivers, avoidable spend, and next actions
- context packs — writes compact `.prismo/` files for frontend, backend, auth, and architecture work
- safe fixes — suggests or creates `.claudeignore`, `CLAUDE.md`, and `AGENTS.md` improvements
- offline first — no api keys, no account, no provider login

## quickstart

```bash
npx getprismo demo
npx getprismo scan --simple
npx getprismo scan --usage
```

## common commands

```bash
npx getprismo scan --usage
npx getprismo scan --fix
npx getprismo cc
npx getprismo cc last 5
npx getprismo optimize
npx getprismo context frontend
npx getprismo setup
npx getprismo watch --once
```

## how it works

1. run it inside a project folder
2. prismodev scans local files and ignore rules
3. it checks local codex and claude code logs if they exist
4. it prints the biggest token-waste risks
5. optional commands create safer ignore files and smaller context docs

## generated files

```text
.prismo/architecture-summary.md
.prismo/backend-summary.md
.prismo/frontend-summary.md
.prismo/recommended-CLAUDE.md
.prismo/recommended-AGENTS.md
.prismo/recommended-.claudeignore
.prismo/optimize-report.md
```

`optimize` writes templates and context packs. it does not overwrite your real `CLAUDE.md`, `AGENTS.md`, `.gitignore`, or `.claudeignore`.

## example

```text
PrismoDev

Score: 72/100  |  Risk: Medium  |  Token leaks: 5
Estimated avoidable waste: 20-40%

Top Token Leaks
1. Missing .claudeignore
2. Recent local AI sessions used 2.40M tokens
3. Large exposed file detected
4. Tool output/context contributed about 95k tokens
5. CLAUDE.md is ~1,900 tokens

Top Fix
Run: npx getprismo scan --fix
Then: npx getprismo optimize
Then: npx getprismo context frontend
```

## project layout

```text
bin/
  prismo.js              # cli entrypoint
lib/
  prismo-dev-scan.js     # scanner, usage reader, reports, context generation
tests/
  prismo-dev-scan.test.js
```

## requirements

node.js 18+

## scope

this repo is only the prismodev local cli.

it does not include the hosted prismo app, managed proxy, dashboard, billing, auth, provider vault, team features, or customer infrastructure.

## license

MIT
