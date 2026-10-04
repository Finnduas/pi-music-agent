# pi-music-agent

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](https://nodejs.org/)

A classical-music composition harness in the spirit of the
[Pi-Agent Brief](docs/pi-agent-harness-brief.md): it composes in **ABC notation**,
validates every score, critiques it, iterates until it is good enough, renders
sheet music, and stores the result.

**Division of labor:** n8n does validation only. Everything else — compose,
critique, iterate, render, store — is this agent.

```
user request / ABC
      │
      ▼
  composer LLM ──────────────┐
      │                      │ (feed errors back)
      ▼                      │
  validate  ── invalid ──────┘   (local abcjs  OR  n8n webhook)
      │ valid                     max 3–5 retries
      ▼
  critic LLM ── score < threshold ──► revise ──► (back to validate)
      │ score ≥ threshold / max iterations
      ▼
  render  ──► SVG/PDF (abc2svg/abcm2ps) + interactive HTML (abcjs)
      │
      ▼
  store   ──► compositions/  (+ optional SQLite index)
      │
      ▼
  ABC + file paths + critic report
```

## Requirements

- Node.js 18+ (built and tested on Node 22)
- An OpenRouter API key, **or** a local [Ollama](https://ollama.com) install
- Optional: `abc2svg` or `abcm2ps` for SVG/PDF output (the HTML viewer works without them)

## Install

```bash
cd pi-music-agent
npm install
cp config.example.yaml config.yaml   # then edit
```

## Configure

`config.yaml` has four sections — providers, roles, validation, render/loop.

### OpenRouter (default)

```yaml
providers:
  openrouter:
    baseUrl: "https://openrouter.ai/api/v1"
    apiKey: ""            # leave blank to read OPENROUTER_API_KEY
roles:
  composer: { provider: openrouter, model: "anthropic/claude-sonnet-4", temperature: 0.9 }
  critic:   { provider: openrouter, model: "anthropic/claude-sonnet-4", temperature: 0.2 }
```

The key is read, in order: `config.yaml` → `OPENROUTER_API_KEY` env var → pi's
own `~/.pi/agent/auth.json`. Verify with `music-agent config` (secrets redacted).

### Local / fully offline (Ollama)

```yaml
roles:
  composer: { provider: ollama, model: "qwen2.5:14b", temperature: 0.9 }
  critic:   { provider: ollama, model: "qwen2.5:14b", temperature: 0.2 }
```

One OpenAI-compatible client is used for both; only `base_url` changes.
Local models are weaker at ABC — the validation + retry loop absorbs format errors.

### Validation backend

```yaml
validation:
  backend: local        # "local" = abcjs in-process (works immediately)
  n8n:
    webhookUrl: "http://localhost:5678/webhook/notation-validation"
```

Set `backend: n8n` after you publish the workflow (below).

## n8n validation service

An importable, validation-only workflow lives at
`src/validate/n8n-workflow.json` (regenerate with `npm run gen:n8n`).

1. n8n → **Import from File** → `src/validate/n8n-workflow.json`
2. Add `abcjs` to the n8n environment if you want full parsing, e.g.
   `NODE_FUNCTION_ALLOW_EXTERNAL=abcjs` and `npm i abcjs` in the n8n install
   (the Code node falls back to structural checks when abcjs is unavailable).
3. **Activate** the workflow and copy the production webhook URL.
4. Put that URL in `config.yaml` under `validation.n8n.webhookUrl` and set
   `validation.backend: n8n`.

Contract: `POST { notation, title?, style? }` →
`{ valid, errors[], warnings[] }`. No LLM, no loop, no storage.

## Rendering

- `abc2svg` / `abcm2ps` CLI → SVG (and PDF with the right flags). Auto-detected
  on `PATH`; override paths in `render.abc2svgPath` / `render.abcm2psPath`.
- The **abcjs** interactive HTML viewer is always produced and works offline (the
  abcjs bundle is vendored next to the HTML, with a CDN fallback).
- Optional publication quality: LilyPond (`abc2ly`) or MuseScore CLI.

See [scripts/install-tools.md](scripts/install-tools.md) for install commands.

## Usage

```bash
# Compose
npx tsx src/cli.ts compose "a wistful baroque minuet in D minor" --style baroque

# Compose into a specific title, machine-readable output
npx tsx src/cli.ts compose "a 16-bar romantic nocturne" --json

# Start from an existing ABC file (revision/critique only)
npx tsx src/cli.ts compose "improve the voice leading" -f my_piece.abc

# Dry run (no rendering / storage)
npx tsx src/cli.ts compose "a short fanfare" --dry-run

# Validate (uses the configured backend)
npx tsx src/cli.ts validate my_piece.abc
cat my_piece.abc | npx tsx src/cli.ts validate -

# Render an existing ABC file
npx tsx src/cli.ts render my_piece.abc -o out/

# List stored pieces / inspect resolved config
npx tsx src/cli.ts list
npx tsx src/cli.ts config
```

After `npm run build`, use `node dist/cli.js …` (or link the `music-agent` bin).

## Offline smoke tests (no API key, no network)

```bash
npm run typecheck   # TypeScript
npm run smoke       # full agent loop with fake LLMs + n8n backend mock
```

- `scripts/smoke-loop.ts` — drives compose → invalid→valid retry → low→high
  critique → revise → render → store, and asserts the loop and files.
- `scripts/smoke-n8n.ts` — starts a mock webhook and checks the n8n contract.

## Storage layout

```
compositions/
  <timestamp>-<title>-<id>.abc    # the score
  <timestamp>-<title>-<id>.html   # offline abcjs viewer
  <timestamp>-<title>-<id>.svg    # if an SVG engine is installed
  abcjs-basic-min.js              # vendored viewer dependency
  <id>.json                       # full record (ABC + critic report + meta)
  index.jsonl                     # append-only index
  index.db                        # optional SQLite index (set storage.database)
```

## Project layout

```
src/
  config.ts              # YAML config + env/secret resolution
  types.ts               # shared types
  llm/
    openai-client.ts     # OpenAI-compatible client (OpenRouter/Ollama)
    roles.ts             # provider+model wiring per role
    parse.ts             # ABC / JSON extraction from LLM output
  validate/
    validator.ts         # local abcjs  |  n8n webhook
    n8n-workflow.json    # importable validation workflow
  render/renderer.ts     # abc2svg/abcm2ps + offline abcjs HTML
  store/store.ts         # folder + JSONL (+ optional SQLite)
  loop/orchestrator.ts   # the agent loop
  cli.ts                 # command line interface
prompts/                 # composer.md, critic.md
scripts/                 # install docs, n8n generator, smoke tests
```

## Scope

In scope: ABC generation, validation, critique/iteration, engraving (SVG/PDF/HTML),
and local storage. **Out of scope (by design):** MIDI and audio synthesis.

The stretch goal — sheet music → ABC via Audiveris + music21 in a second n8n
workflow — is covered in [scripts/install-tools.md](scripts/install-tools.md).

## License

This project is free software, licensed under the **GNU General Public License
v3.0 or later** (`GPL-3.0-or-later`). See [LICENSE](LICENSE) for the full text.

Copyright (C) 2026 Finnduas.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please run
`npm run typecheck && npm run smoke` before opening a pull request.
