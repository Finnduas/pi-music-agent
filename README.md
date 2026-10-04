# pi-music-agent

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](https://nodejs.org/)

**Claude Code for sheet music.** Talk to Pi in plain
English; it drives a fixed, tested music tool that composes, edits, transposes and
converts sheet music, working in **ABC notation** (plain-text music).

```
you ─► Pi (the agent) ─► sheetmusic_* tools ─► pi-music-agent CLI ─► LLM + validator + renderer
          "fill in the gap        compose · edit · transpose            composer ⇄ critic loop,
           in this piece"         analyze · convert                     abcjs, optional n8n
```

The music agent is a **tool, not code Pi edits**: for music tasks Pi only calls the
CLI; it never touches this repo's source.

## What you can say to Pi

| You say | What happens |
|---|---|
| "Write me a minuet based on the work in the input folder" | `sheetmusic_compose` with `.input/` as style references |
| "Fill in the gap in this piece" | `sheetmusic_analyze` finds the gap → `sheetmusic_edit` fills only those bars |
| "Rewrite this in F major" | `sheetmusic_analyze` → compute semitones → `sheetmusic_transpose` (deterministic, no LLM) |
| "Turn .input/score.pdf into notation" | `sheetmusic_convert` (OMR via n8n or local Audiveris) |

Results land in `.output/` as `.abc` + an `.html` sheet-music viewer. Open it in any
browser: **Play** (audio), **Download MIDI**, **Print / Save PDF**, **Download .abc**.
See [Viewing and playing ABC files](docs/USAGE.md#viewing-and-playing-abc-files).

## Quick start

```bash
git clone https://github.com/Finnduas/pi-music-agent && cd pi-music-agent
npm install
cp config.example.yaml config.yaml        # default: Kimi K2.6 (open weights) via OpenRouter
export OPENROUTER_API_KEY=sk-or-...       # or put it in config.yaml
npm run build

npm run smoke                              # offline self-test, no key needed

# try it without Pi
node dist/cli.js edit examples/input/minuet-with-gap.abc "fill in the gap"
node dist/cli.js compose "a wistful baroque minuet in D minor" --style baroque
```

Open the `.html` in `.output/` to see and print the score.

### Hook it into Pi

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills/sheet-music/references
cp pi-integration/sheet-music.ts ~/.pi/agent/extensions/
cp pi-integration/skills/sheet-music/SKILL.md ~/.pi/agent/skills/sheet-music/
cp pi-integration/skills/sheet-music/references/* ~/.pi/agent/skills/sheet-music/references/
```

Start `pi` (or run `/reload`) and type `/music`. Details: [pi-integration/README.md](pi-integration/README.md).

## How it works, in one picture

```
request / existing ABC
   │
   ▼  composer LLM ─────────────┐
   ▼                            │ errors fed back (≤ N retries)
 validate ── invalid ───────────┘      local abcjs  OR  n8n webhook
   │ valid
   ▼  critic LLM ── score < threshold ──► revise ──► validate
   │ good enough
   ▼
 render (HTML viewer, optional SVG) ─► store in .output/
```

## Folders

| Folder | Purpose |
|---|---|
| `.input/` | drop source sheet music here (ABC, MusicXML, PDF, image) |
| `.output/` | rendered pieces land here |
| `src/` | the music agent (TypeScript) — see [ARCHITECTURE](docs/ARCHITECTURE.md) |
| `prompts/` | composer and critic system prompts |
| `pi-integration/` | Pi extension + skill |
| `examples/` | public-domain demo inputs and sample outputs |
| `scripts/` | n8n workflow generators and offline smoke tests |
| `docs/` | architecture, usage reference, presentation |

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — modules, tools, n8n, and a step-by-step walkthrough of "fill in the gap".
- [docs/USAGE.md](docs/USAGE.md) — full CLI, configuration, rendering, storage reference.
- [docs/PRESENTATION.md](docs/PRESENTATION.md) — talk outline and live-demo script.
- [examples/README.md](examples/README.md) — demo files.

## Development

```bash
npm run typecheck && npm run smoke      # must stay green (offline, no API key)
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE). Copyright (C) 2026 Finnduas.
