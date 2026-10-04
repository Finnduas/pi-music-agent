# Usage reference

Install, configure, every command, the HTTP API and the file layout. For the 2-minute
overview see the [README](../README.md); for how the pieces fit together see
[ARCHITECTURE.md](ARCHITECTURE.md); for the n8n side see [n8n/README.md](../n8n/README.md).

## Requirements

- Node.js 18+ (built and tested on Node 22)
- An OpenRouter API key, **or** a local [Ollama](https://ollama.com) install
- Optional: n8n (automation), Audiveris + music21 (reading scanned sheet music)

## Install

```bash
cd pi-music-agent
npm install
npm run build
cp config.example.yaml config.yaml   # then edit
```

## Command reference

Run as `node dist/cli.js <command>` (after `npm run build`), or `npx tsx src/cli.ts <command>`
without building. All commands accept `-c, --config <path>` to use another config file.

| Command | Uses the LLM? | What it does |
|---|---|---|
| `compose "<request>"` | yes | Write a new piece, check it, critique it, revise it, render it |
| `edit <file> "<instruction>"` | yes | Change an existing piece (fill a gap, rework a passage) |
| `analyze [file]` | no | Bars, meter, key, voices, candidate gaps |
| `transpose <semitones> [file]` | no | Move a piece up or down; exact, key-signature aware |
| `convert <input>` | no | PDF / image / MusicXML / ABC → validated ABC |
| `validate [file]` | no | Check that ABC parses (local abcjs or n8n) |
| `render <file>` | no | Make the HTML viewer for an ABC file |
| `list` | no | List stored pieces |
| `serve` | – | Start the local HTTP API for n8n |
| `config` | no | Print the resolved configuration (secrets hidden) |

### compose

```bash
node dist/cli.js compose "a wistful baroque minuet in D minor" --style baroque
node dist/cli.js compose "a minuet in the style of these" --refs .input
node dist/cli.js compose "a short fanfare" --dry-run --json
```

| Option | Meaning |
|---|---|
| `-s, --style <style>` | style / period hint, e.g. `baroque`, `romantic` |
| `-t, --title <title>` | title for the piece (default: derived from the request) |
| `-r, --refs <dir>` | read every `.abc` in that folder and tell the composer to emulate them |
| `--dry-run` | skip rendering and saving (nothing is written) |
| `--json` | print the full result as JSON (id, title, abc, critic report, files, log) |

Loop: compose → validate (up to 5 retries on parse errors) → critic scores 0–10 →
revise until the score reaches 8 or 3 rounds are done → render → save. Progress goes to
stderr. The best-scoring version is returned, not necessarily the last.

### edit

```bash
node dist/cli.js edit examples/input/minuet-with-gap.abc "fill in the gap"
node dist/cli.js edit my_piece.abc "make bars 5-8 more lyrical" --style romantic
```

Options: `-s/--style`, `-t/--title`, `--dry-run`, `--json` (as above). The source file is
never modified; the result is saved as a new piece in `.output/`. For a **gap-fill** (the
instruction mentions gap/fill/missing/blank and gaps are found) the program verifies that
every bar outside the gap, and the `M:`/`L:`/`K:` headers, are unchanged; otherwise it
retries or rejects the revision. The critic is told to judge only the new bars.

A "gap" is a bar that is rest-only (`z3`) or annotated `"^GAP"` / `"?"`.

### analyze

```bash
node dist/cli.js analyze my_piece.abc
cat my_piece.abc | node dist/cli.js analyze -
```

Prints bars, meter, key, tonic, voices, whether it ends on the tonic, and candidate gaps.

### transpose

```bash
node dist/cli.js transpose 5 my_piece.abc      # up a fourth (C -> F)
node dist/cli.js transpose -3 my_piece.abc -o out/
```

Writes `<name>.abc` to `.output/` (or `-o <dir>`). Handles key signatures, accidentals,
modes, voices, inline key changes and chord symbols; verified against abcjs MIDI output.

### convert

```bash
node dist/cli.js convert .input/score.pdf
node dist/cli.js convert .input/piece.abc          # validates and copies
```

Options: `-o/--out <dir>`, `--json`. Needs `conversion.backend` set to `n8n` or `local` for
scans (see [install-tools](../scripts/install-tools.md)). Exits non-zero if the result is
not valid ABC.

### validate

```bash
node dist/cli.js validate my_piece.abc
printf 'X:1\nK:C\nCDEF|]' | node dist/cli.js validate -
```

Prints `valid`, `errors`, `warnings`; exit code 1 when invalid. Uses
`validation.backend` (`local` or `n8n`). Option: `--json`.

### render

```bash
node dist/cli.js render my_piece.abc            # -> .output/my_piece.html
```

Options: `-o/--out <dir>`, `-n/--name <base-name>`. See *Viewing and playing* below.

### list

```bash
node dist/cli.js list           # date, score, style, title, files, id
node dist/cli.js list --json    # one JSON record per line
```

### serve

```bash
npm run serve                   # = node dist/cli.js serve
node dist/cli.js serve --port 7878
```

Starts the HTTP API on `127.0.0.1` (local only). See [HTTP API](#http-api).

### config

`node dist/cli.js config` prints what the program will actually use.

## Configure

`config.yaml` (git-ignored; start from `config.example.yaml`) has these sections:

| Section | Controls |
|---|---|
| `storage` | `inputDir` (`./.input`) and `dir` (`./.output`) |
| `providers` | where LLM calls go: `openrouter`, `ollama`, … (one OpenAI-compatible client) |
| `roles` | which provider/model/temperature/`maxTokens`/`reasoning` for `composer` and `critic` |
| `validation` | `backend: local` (abcjs, default) or `n8n` + `n8n.webhookUrl` |
| `conversion` | `backend: none` (default) / `n8n` / `local` (Audiveris + music21) |
| `loop` | `maxValidationRetries` (5), `maxIterations` (3), `scoreThreshold` (8) |

### OpenRouter (default: Kimi K2.6, open weights)

```yaml
providers:
  openrouter:
    baseUrl: "https://openrouter.ai/api/v1"
    apiKey: ""            # leave blank to read OPENROUTER_API_KEY
roles:
  composer: { provider: openrouter, model: "moonshotai/kimi-k2.6", temperature: 0.9 }
  critic:   { provider: openrouter, model: "moonshotai/kimi-k2.6", temperature: 0.2 }
```

The key is read, in order: `config.yaml` → `OPENROUTER_API_KEY` env var → pi's own
`~/.pi/agent/auth.json`. Verify with `config` (secrets redacted).

**Thinking models:** Kimi K2.6 spends its token budget on hidden reasoning unless you set
`reasoning: { enabled: false }` on the role (the default config does). Other OpenRouter
reasoning options (`effort`, `max_tokens`) were ignored by this model when we tried them.

### Local / fully offline (Ollama)

```yaml
roles:
  composer: { provider: ollama, model: "qwen2.5:14b", temperature: 0.9 }
  critic:   { provider: ollama, model: "qwen2.5:14b", temperature: 0.2 }
```

Local models are weaker at ABC; the validation + retry loop absorbs format errors.

## HTTP API

`music-agent serve` exposes the same operations as the CLI for automation (this is what the
n8n workflows call). JSON in, JSON out, `127.0.0.1` only, file paths must stay inside the
project folder (anything else is HTTP 400).

| Route | Body | Returns |
|---|---|---|
| `GET /health` | – | `{ ok, routes }` |
| `POST /analyze` | `{ file }` or `{ abc }` | `{ file?, bars, meter, key, tonic, voices, gaps, … }` |
| `POST /compose` | `{ request, style?, title?, refs? }` | `{ id, title, score, summary, abc, files, warnings, seconds }` |
| `POST /edit` | `{ file, instruction, style?, title? }` | same as compose |
| `POST /transpose` | `{ file }` or `{ abc }`, `semitones`, `name?` | `{ abc, file }` |
| `POST /convert` | `{ file }` | `{ valid, abc, errors, warnings, backend, file }` |

```bash
curl -s localhost:7878/analyze -H 'Content-Type: application/json' -d '{"file":"examples/input/minuet-with-gap.abc"}'
```

Errors are `{ "error": "…" }` with status 400 (bad input), 404 (file not found) or 500.

## n8n (optional)

Four importable workflows in [`n8n/`](../n8n/): an **inbox** (drop a file in `.input`),
a **compose webhook**, and the **validation** and **OMR** services the agent can call.
Setup, environment variables and testing: [n8n/README.md](../n8n/README.md).

To make the agent use n8n for a service, set in `config.yaml`:

```yaml
validation: { backend: n8n }     # needs the Notation Validation workflow active
conversion: { backend: n8n }     # needs the OMR workflow + Audiveris + music21
```

## Viewing and playing ABC files

**Easiest: the generated `.html` viewer** (next to every `.abc` in `.output/`).
Double-click it to open it in any browser. It needs no install.

| Button | Does | Offline? |
|---|---|---|
| **▶ Play / ■ Stop** | plays the score with a piano sound (abcjs synth) | no, piano samples load from the internet on first play |
| **Download MIDI** | saves a `.mid` file (open in Windows Media Player, VLC, GarageBand, MuseScore…) | yes |
| **Print / Save PDF** | clean printable score (choose "Save as PDF") | yes |
| **Download .abc** / **Show ABC** | the plain-text source | yes |

The score is always drawn black on white, also in a browser's dark mode. Check the
viewer on your machine with `npm run check:browser` (headless Chrome/Edge: renders,
plays, stops, MIDI, contrast); add `--full` to also wait until the piece finishes.

**Other programs** (to *edit* ABC with live preview + playback):

- **EasyABC**: free desktop ABC editor for Windows/macOS/Linux; plays, exports MIDI/PDF/MusicXML.
- **abcjs editor / abcnotation.com**: paste ABC into a web page.
- **MuseScore**: import the MIDI (or MusicXML exported from EasyABC) to edit graphically.
- **abc2midi** (from abcMIDI): `abc2midi piece.abc -o piece.mid`.

## Tests and checks

| Command | What | Needs |
|---|---|---|
| `npm run typecheck` | TypeScript | – |
| `npm run smoke` | 9 offline suites: music logic, transposer (+ abcjs MIDI oracle), viewer, conversion, agent loop with fake LLMs, edit/gap guard, n8n client mock, HTTP API | nothing (no key, no network) |
| `npm run check:browser` | the viewer in a real headless Chrome/Edge | Chrome or Edge |
| `npm run check:n8n` | the n8n integration against a running n8n + `serve` (`-- --full` also composes a piece) | n8n, `npm run serve`, an LLM key for `--full` |

## Storage layout

```
.input/                          # drop sheet music (PDF/image/MusicXML/ABC) here
.output/                         # everything generated lands here
  <title>-<id>.abc               # the score
  <title>-<id>.html              # offline viewer (Play, MIDI, Print / Save PDF)
  <timestamp>-<title>-<id>.json  # full record (ABC + critic report + metadata)
  abcjs-basic-min.js             # vendored viewer dependency
examples/input|output/           # committed public-domain demos (not touched by the program)
```
