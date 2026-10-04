# Architecture

A one-page map of what this project is, the services it uses, and how n8n fits in.

## What it is

`pi-music-agent` is a classical-music composition harness. It works in **ABC
notation** (a plain-text music format), and runs an agent loop:

```
request / input ABC
    -> composer LLM  (write a score)
    -> validate      (catch syntax errors; retry up to N times)
    -> critic LLM    (score 0-10 + structured feedback)
    -> revise        (if below threshold / not maxed out)
    -> render        (sheet music: HTML viewer + optional SVG/PDF)
    -> store         (output/ folder + index)
    -> return ABC + files + critic report
```

Pi (the coding agent) drives this loop as a **tool** for music tasks — it does
not edit the music agent's own code for those tasks. See `pi-integration/`.

## Services used

| Service | Role | When |
|---|---|---|
| **OpenRouter** | LLM API gateway (one OpenAI-compatible endpoint) | composer + critic, default |
| **Claude Sonnet 5.5** via OpenRouter | The composer + critic model | default configuration |
| **Ollama** (optional) | Fully-local LLM alternative (`http://localhost:11434/v1`) | offline use |
| **abcjs** | ABC parser (validation) + in-browser sheet-music renderer | always (local validation + HTML viewer) |
| **abc2svg / abcm2ps** (optional CLIs) | Standalone SVG engraving | if installed on `PATH` |
| **better-sqlite3** (optional) | SQLite index of compositions | if `storage.database` is set |
| **n8n** | External validation + OMR (sheet music → ABC) | optional; two importable workflows |
| **Audiveris + music21** (optional) | Optical Music Recognition (PDF/image → MusicXML → ABC) | the "stretch goal" conversion |
| **Pi** | The coding-agent "base" that drives the music tool | via `pi-integration/` extension + skill |

Every external service degrades gracefully: if you have none of the optional
tools, the project still works (local abcjs validation + HTML viewer + OpenRouter).

## How n8n is integrated

n8n is **validation and conversion only** — no LLM, no loop, no storage. It runs
as two importable webhook workflows; the Node agent calls them over HTTP.

### 1. Notation Validation Service

- File: `src/validate/n8n-workflow.json` (regenerate: `npm run gen:n8n`)
- Contract: `POST { notation, title?, style? }` → `{ valid, errors[], warnings[] }`
- Code node tries `require('abcjs')` for a real parse; falls back to structural
  checks. The same structural checks are mirrored in the local validator.

### 2. OMR Conversion Service (sheet music → ABC)

- File: `src/convert/n8n-omr-workflow.json` (regenerate: `npm run gen:n8n:omr`)
- Contract: `POST { filename, mimeType, data(base64) }` → `{ abc, valid, errors[], warnings[] }`
- Code node decodes the file, runs Audiveris (OMR → MusicXML), then music21
  (MusicXML → ABC), and structural-checks the result.

### Switching backends

In `config.yaml`:

```yaml
validation:
  backend: local   # default: abcjs in-process, zero setup
  # backend: n8n  # after importing the validation workflow + copying its URL

conversion:
  backend: none    # no OMR
  # backend: n8n    # after importing the OMR workflow + copying its URL
  # backend: local  # Audiveris + music21 installed locally
```

The CLI `validate`, `convert`, and the Pi tools all go through these backends.

## Project structure

```
pi-music-agent/
  src/
    cli.ts                 # all commands: compose/validate/render/convert/
                           #   transpose/analyze/session/list/show/config
    config.ts              # YAML config + env/secret resolution + sanitisation
    types.ts               # shared types
    llm/
      openai-client.ts     # OpenAI-compatible client (+ native tool-calling)
      roles.ts             # provider/model wiring per role (composer, critic)
      parse.ts             # extract ABC / JSON from LLM output
    music/
      abc.ts               # deterministic analysis + transposition (no LLM)
    validate/
      validator.ts         # local abcjs | n8n webhook
      n8n-workflow.json    # validation workflow
    convert/
      convert.ts           # sheet music (PDF/image/MusicXML) -> ABC
      n8n-omr-workflow.json
    render/renderer.ts     # abc2svg/abcm2ps + offline abcjs HTML viewer
    store/store.ts         # output/ + index.jsonl (+ optional SQLite)
    loop/
      orchestrator.ts      # the compose -> validate -> critique -> render loop
      tools.ts             # composer tools: analyze_score, transpose
      session.ts           # interactive /edit /critique /transpose repl
  prompts/                 # composer.md, critic.md (the LLM system prompts)
  scripts/                 # n8n generators + offline smoke tests
  examples/                # demo input/output files (see examples/README.md)
  pi-integration/          # Pi extension + skill (see below)
  input/                   # drop source sheet music here
  output/                  # rendered compositions land here
  docs/                    # brief + this architecture doc
```

## Pi integration

`pi-integration/sheet-music.ts` (extension) registers:

- Slash commands: `/compose`, `/music`, `/music-list`, `/music-analyze`,
  `/music-transpose`, `/music-render`, `/music-validate`, `/music-convert`.
- Model tools: `sheetmusic_compose`, `sheetmusic_transpose`, `sheetmusic_convert`.

`pi-integration/skills/sheet-music/` (skill) teaches Pi to map plain-English
requests ("write me a minuet based on the input folder", "rewrite this in F
major") onto those commands/tools, and not to edit the music agent's source.

## Development guardrails

```bash
npm run typecheck   # TypeScript
npm run smoke       # offline end-to-end tests (fake LLMs + mock n8n, no key)
npm run build       # compile to dist/
```