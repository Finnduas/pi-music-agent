# Usage reference

Full CLI, configuration and storage reference. For the 2-minute overview see the
[README](../README.md); for how the pieces fit together see
[ARCHITECTURE.md](ARCHITECTURE.md).

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
  composer: { provider: openrouter, model: "anthropic/claude-sonnet-5.5", temperature: 0.9 }
  critic:   { provider: openrouter, model: "anthropic/claude-sonnet-5.5", temperature: 0.2 }
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

## n8n validation service (optional)

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

- `abc2svg` / `abcm2ps` CLI → SVG. Auto-detected on `PATH`; override paths in
  `render.abc2svgPath` / `render.abcm2psPath`.
- The **abcjs** interactive HTML viewer is always produced and works offline (the
  abcjs bundle is vendored next to the HTML, with a CDN fallback). Its controls
  let you show/hide the ABC source, download the `.abc`, and **Print / Save PDF**
  — `<Ctrl/Cmd>-P` or the button prints a clean score, which is also the reliable
  way to get a PDF on any platform.
- Optional publication quality: LilyPond (`abc2ly`) or MuseScore CLI.

## Viewing and playing ABC files

**Easiest: the generated `.html` viewer** (next to every `.abc` in `.output/`).
Double-click it to open it in any browser. It needs no install.

| Button | Does | Offline? |
|---|---|---|
| **▶ Play / ■ Stop** | plays the score with a piano sound (abcjs synth) | no, piano samples load from the internet on first play |
| **Download MIDI** | saves a `.mid` file (open in Windows Media Player, VLC, GarageBand, MuseScore…) | yes |
| **Print / Save PDF** | clean printable score (choose "Save as PDF") | yes |
| **Download .abc** / **Show ABC** | the plain-text source | yes |

Check it on your machine: `npm run check:browser` (headless Chrome/Edge: renders,
plays, stops, MIDI). Add `--full` to also wait until the piece finishes.

Render a viewer for any ABC file (e.g. one you wrote yourself):

```bash
node dist/cli.js render my_piece.abc --formats html     # -> .output/my_piece.html
```

**Other programs** (if you want to *edit* ABC with live preview + playback):

- **EasyABC**: free desktop ABC editor for Windows/macOS/Linux. It shows, plays, and
  exports MIDI/PDF/MusicXML.
- **abcjs editor / abcnotation.com**: paste ABC into a web page for preview + playback.
- **MuseScore**: full notation editor. Import the MIDI (or MusicXML exported from
  EasyABC) to edit the score graphically.
- **abc2midi** (command line, from abcMIDI): `abc2midi piece.abc -o piece.mid`.

See [scripts/install-tools.md](scripts/install-tools.md) for install commands.

## Usage

```bash
# Compose
npx tsx src/cli.ts compose "a wistful baroque minuet in D minor" --style baroque

# Compose into a specific title, machine-readable output
npx tsx src/cli.ts compose "a 16-bar romantic nocturne" --json

# Edit an existing piece with an instruction (fill a gap, rework a passage)
npx tsx src/cli.ts edit examples/input/minuet-with-gap.abc "fill in the gap"
npx tsx src/cli.ts edit my_piece.abc "make bars 5-8 more lyrical"

# Dry run (no rendering / storage)
npx tsx src/cli.ts compose "a short fanfare" --dry-run

# Validate (uses the configured backend)
npx tsx src/cli.ts validate my_piece.abc
cat my_piece.abc | npx tsx src/cli.ts validate -

# Render an existing ABC file
npx tsx src/cli.ts render my_piece.abc -o out/
npx tsx src/cli.ts render my_piece.abc -o out/ --formats svg,html

# Compose in the style of pieces dropped in .input/
npx tsx src/cli.ts compose "a minuet in the style of the input pieces" --refs .input

# Rewrite a piece in another key (transpose by semitones)
npx tsx src/cli.ts transpose 2 my_piece.abc    # +2 semitones (D -> E)

# Deterministic quick facts (bars / meter / key / tonic / voices)
npx tsx src/cli.ts analyze my_piece.abc

# Convert sheet music (PDF/image/MusicXML) -> ABC (needs an OMR backend)
npx tsx src/cli.ts convert .input/score.pdf

# Interactive multi-turn editor (load, edit, critique, transpose, save)
npx tsx src/cli.ts session -f my_piece.abc
npx tsx src/cli.ts session <id>       # resume a stored piece by id

# List stored pieces / inspect one / inspect resolved config
npx tsx src/cli.ts list
npx tsx src/cli.ts show <id>            # full record + critic report + ABC
npx tsx src/cli.ts show <id> --abc      # just the ABC notation
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
.input/                            # drop sheet music (PDF/image/MusicXML/ABC) here
.output/                           # rendered pieces land here
  <timestamp>-<title>-<id>.abc    # the score
  <timestamp>-<title>-<id>.html   # offline abcjs viewer (open to print/save PDF)
  <timestamp>-<title>-<id>.svg    # if an SVG engine is installed
  abcjs-basic-min.js              # vendored viewer dependency
  <id>.json                       # full record (ABC + critic report + meta)
  index.jsonl                     # append-only index
  index.db                        # optional SQLite index (set storage.database)
```

