# Architecture

1. [The big picture](#1-the-big-picture)
2. [Modules](#2-modules)
3. [What the agent can do: tools & commands](#3-what-the-agent-can-do-tools--commands)
4. [Walkthrough: "Fill in the gap in this piece"](#4-walkthrough-fill-in-the-gap-in-this-piece)
5. [n8n: what it does here](#5-n8n-what-it-does-here)
6. [External services](#6-external-services)
7. [Design decisions](#7-design-decisions)

---

## 1. The big picture

There are **two agents** and one rule.

```
┌──────────────────────── Pi (the base agent) ────────────────────────┐
│ understands plain English, reads files, picks a tool, reports back  │
│   skill: sheet-music  → teaches Pi WHEN and HOW to use the tools    │
│   extension: sheet-music.ts → registers tools + slash commands      │
└───────────────┬─────────────────────────────────────────────────────┘
                │ runs:  node dist/cli.js <command> …      (no code edits)
┌───────────────▼───────────── pi-music-agent (fixed tool) ───────────┐
│ deterministic helpers          LLM loop                              │
│  analyze · gaps · transpose    composer ⇄ validator ⇄ critic        │
│  validate · render · store     (OpenRouter → Kimi K2.6)             │
└───────────────┬──────────────────────────────────────────────────────┘
        ▲ HTTP (serve) │ HTTP (webhooks)
┌───────┴───────▼───────────── n8n (optional) ─────────────────────────┐
│  inbox: drop a file in .input → convert → fill gaps → viewer         │
│  compose webhook · validation service · OMR (scan → ABC) service     │
└──────────────────────────────────────────────────────────────────────┘
```

**The rule:** for music tasks Pi *calls* the music agent; it never edits the
music agent's source. The music agent is a fixed, tested tool.

**Why ABC?** It is plain text, so an LLM can read and write it, a parser can
validate it, and diffs are meaningful. Everything (PDF in, sheet music out) is
converted to/from ABC.

---

## 2. Modules

```
src/
  cli.ts                 Entry point. One sub-command per capability (see §3).
  server.ts              Local HTTP API (`serve`) so n8n can drive the agent.
  ops.ts                 Operations shared by the CLI and the server (convert, transpose).
  config.ts              Loads config.yaml, resolves API keys (config → env →
                         ~/.pi/agent/auth.json), sanitises values.
  types.ts               Shared types (ComposeRequest, ComposeResult, …).

  loop/
    orchestrator.ts      THE agent loop: compose|edit → validate → critique →
                         revise → render → store.  (composePiece)
    tools.ts             Two tools the composer LLM may call itself:
                         analyze_score, transpose.

  llm/
    openai-client.ts     One OpenAI-compatible client (OpenRouter or Ollama).
    roles.ts             Wires "composer" and "critic" roles to provider+model;
                         runs the tool-calling loop; falls back to plain chat if
                         a provider rejects `tools`.
    parse.ts             Extracts ```abc blocks and JSON from LLM replies.

  music/
    abc.ts               Deterministic, no-LLM music logic: headers, meter, key,
                         bar count, voices, ends-on-tonic, GAP DETECTION,
                         transposition.

  validate/
    validator.ts         Validation: local abcjs parse  OR  n8n webhook.

  convert/
    convert.ts           Sheet music (PDF/image/MusicXML) → ABC via n8n or local
                         Audiveris+music21; ABC passes straight through.

  render/renderer.ts     ABC → one self-contained HTML viewer (abcjs: notation,
                         Play, Download MIDI, Print / Save PDF).
  store/store.ts         One .json record per piece in .output/.

prompts/                 composer.md, critic.md — the LLM system prompts.
pi-integration/          sheet-music.ts (Pi extension) + skills/sheet-music/.
n8n/                     Importable n8n workflows (+ code/ = their JavaScript) and a README.
scripts/                 gen-n8n.mjs (builds n8n/*.json), smoke tests, live checks.
examples/  .input/  .output/  docs/
```

**Layering rule:** `validate/`, `render/`, `store/`, `music/` know nothing about
LLMs. Only `loop/` and `llm/` do. That is why most of the system is testable
offline (`npm run smoke`, no API key).

**Deterministic vs. LLM** — important for trust:

| Deterministic (instant, free, always right) | LLM (creative, can err) |
|---|---|
| analyze (bars, key, meter, voices, tonic) | compose a new piece |
| find gaps | write the notes that fill a gap |
| **transpose** (key-signature aware; checked against abcjs MIDI: 7 pieces × 23 shifts) | critique + score 0–10 |
| validate (abcjs parse) | revise from critic feedback |
| render, store | |

---

## 3. What the agent can do: tools & commands

### Model tools (Pi's LLM calls these; registered in `pi-integration/sheet-music.ts`)

| Tool | Does | Uses LLM? |
|---|---|---|
| `sheetmusic_compose { request, style?, title?, refDir? }` | New piece; `refDir` = reference ABC to emulate | yes |
| `sheetmusic_edit { file, instruction, style? }` | Change an existing piece, e.g. fill a gap | yes |
| `sheetmusic_analyze { file }` | Bars, meter, key, voices, candidate gaps | no |
| `sheetmusic_transpose { file, semitones }` | Move to another key | no |
| `sheetmusic_convert { file }` | PDF/image/MusicXML → ABC | no (OMR) |

Pi also has its normal built-ins (`read`, `bash`, `edit`, `write`) — the skill
tells it not to use them on the music agent's own code for music tasks.

### Slash commands (you type these in Pi)

`/compose`, `/music-edit`, `/music-analyze`, `/music-transpose`, `/music-convert`,
`/music-list`, `/music` (status).

### Tools the *composer LLM* itself can call (inside the music agent)

`analyze_score`, `transpose` (`src/loop/tools.ts`). If a provider rejects native
tool-calling, the agent silently falls back to plain chat and injects the same
facts into the prompt as a "Score facts" block, so quality does not depend on it.

### CLI (what everything above shells out to)

`compose · edit · analyze · transpose · convert · validate · render · list · serve · config`
(full reference: [USAGE.md](USAGE.md#command-reference))

### How to use it in Pi

1. Install once (see README → *Hook it into Pi*): copy the extension and skill.
2. Start `pi` in any folder (or `/reload`). Type `/music` to confirm it is loaded.
3. Either type a slash command, or just **say what you want** — the skill makes
   Pi pick the right tool.

---

## 4. Walkthrough: "Fill in the gap in this piece"

Example: `examples/input/minuet-with-gap.abc`, 3/4 in G major, where bars 5–6 are
`"^GAP" z3 | z3 |` (rests). This exact sequence was run live through Pi.

| # | Who | What happens |
|---|---|---|
| 1 | **You** | Type: *"Fill in the gap in examples/input/minuet-with-gap.abc"* |
| 2 | **Pi** | Matches the `sheet-music` skill (its description says "compose, transpose, rewrite…"). The skill body tells it the workflow for gaps. |
| 3 | **Pi** | Calls built-in `read` on the file to see the music. |
| 4 | **Pi → tool** | Calls `sheetmusic_analyze`. Extension resolves the path and runs `node dist/cli.js analyze <file>`. |
| 5 | **music agent** (deterministic) | `analyzeScore()` returns: 3/4, key G, 1 voice, **candidate gaps: bars 5–6** (rest-only bars or bars annotated `GAP`). |
| 6 | **Pi** | Writes an informed instruction: *"fill in the gap in bars 5–6, flowing from the previous phrase into `d B G`"*. |
| 7 | **Pi → tool** | Calls `sheetmusic_edit { file, instruction }` → `node dist/cli.js edit <file> "<instruction>" --json`. |
| 8 | **orchestrator** | `composePiece({ edit: true })`: builds an *edit prompt*: instruction + rules (keep every other bar identical; match key/meter/rhythm; remove the GAP marker) + the "Score facts" + the full ABC. |
| 9 | **Composer LLM** (Kimi K2.6 via OpenRouter) | Returns the full score in an ```` ```abc ```` block. `parse.ts` extracts it. |
| 10 | **orchestrator** | Re-runs gap detection → logs *"Remaining candidate gaps: none"*. |
| 11 | **validator** | abcjs parses the result (or the n8n webhook, if configured). If invalid, errors go back to the composer, up to `maxValidationRetries` (5). |
| 12 | **Critic LLM** | Scores 0–10 with strengths/issues/suggestions. If score ≥ `scoreThreshold` (8) → stop. Otherwise a *revise* pass runs (with "change nothing outside the edited passage") and we loop, up to `maxIterations` (3). |
| 13 | **renderer + store** | Writes `.output/<title>-<id>.abc`, `.html` (offline viewer) and a `.json` record. |
| 14 | **Extension → Pi** | Returns title, critic score, file paths and the ABC to Pi. |
| 15 | **Pi → You** | "The gap in bars 5–6 has been filled with `B c d | e d c |` … output files: …" |

Actual result of the live run (a diff of input vs. output; nothing else changed):

```diff
- "^GAP" z3 | z3 | d B G | A3 |
+ B c d | e d c | d B G | A3 |
```

Offline test of this exact flow: `npx tsx scripts/smoke-edit.ts`.

> **Honest limits.** The gap *finder* is a heuristic: any rest-only bar counts, so a
> deliberate rest in an accompaniment voice is also reported (it is a hint; your
> instruction decides). The *music quality* of the fill is the LLM's, judged by the
> critic — it is "plausible and in key", not guaranteed great.

---

## 5. n8n: what it does here

n8n is **optional**, and the integration runs in **both directions**. The workflows
live in [`n8n/`](../n8n/) (generated by `npm run gen:n8n`; setup in
[n8n/README.md](../n8n/README.md)). n8n holds **no LLM, no state**: every decision is
made by the agent; n8n is the plumbing and the automation.

```
 agent → n8n   (the agent calls a webhook for a service)
   music-agent ──POST──► n8n webhook ──► Code node ──► JSON back
        validation.backend: n8n          conversion.backend: n8n

 n8n → agent   (n8n triggers and orchestrates the agent)
   file dropped in .input ─► n8n ──POST──► music-agent serve  (127.0.0.1:7878)
   HTTP request           ─► n8n ──POST──►   /analyze /edit /compose /convert …
```

| Workflow | Direction | Trigger | What it does |
|---|---|---|---|
| **Sheet Music Inbox** (`inbox.json`) | n8n → agent | a new file in `.input` (Local File Trigger) | scan/MusicXML → `/convert`; then `/analyze`; if gaps → `/edit` "fill in the gap in …"; ends in a status report. `.abc` goes straight to analyze; other files are ignored |
| **Compose a Piece** (`compose-webhook.json`) | n8n → agent | `POST /webhook/compose-piece` | `{ request, style?, title?, refs? }` → `/compose` → the piece (abc, score, files). Errors come back as clean JSON with HTTP 400 |
| **Notation Validation Service** (`validation.json`) | agent → n8n | `POST /webhook/notation-validation` | abcjs `parseOnly` + header checks → `{ valid, errors[], warnings[] }`. Same verdicts as the local validator |
| **OMR Conversion Service** (`omr-conversion.json`) | agent → n8n | `POST /webhook/omr-conversion` | base64 scan → Audiveris → MusicXML → music21 → ABC |

**The inbox flow** (each box is a node):

```
New file in .input → Classify (abc / scan / ignore) → Is it a scan?
     scan ─► Convert scan to ABC (/convert) ─► Converted? ─no─► Conversion failed (report)
                                                    │yes
     abc  ───────────────────────────────────────► Analyze (/analyze) ─► Has gaps?
                                                         yes ─► Fill the gaps (/edit) ─► Report: gaps filled
                                                         no  ─► Report: nothing to do
```

**The API** (`music-agent serve`, `src/server.ts`): `GET /health`,
`POST /analyze | /compose | /edit | /transpose | /convert`. It binds to
`127.0.0.1` only, takes JSON, and only accepts file paths *inside the project
folder* (`../` and outside absolute paths get HTTP 400). Why HTTP and not "run a shell
command" nodes: webhook input (a composition request) would otherwise end up in a shell
command line.

**Defaults:** no n8n needed. `validation.backend: local`, `conversion.backend: none`.

**How it was tested.**
- Offline (`npm run smoke`): the validation client against a mock webhook
  (`smoke-n8n.ts`) and every API route/error/path-safety case (`smoke-server.ts`).
- **Against a real n8n 1.123** (`npm run check:n8n`, manual run): validation verdicts
  identical to the local validator on 4 cases; compose webhook (error path and a real
  composition, 20 s); inbox with 4 real files dropped in `.input` (complete piece →
  "no gaps", scan without a backend → clear error, `.txt` → ignored, piece with a gap →
  filled, only bars 5–6 changed, viewer rendered); OMR webhook → Audiveris missing → clean
  structured error. Running it for real found two bugs the mocks could not
  (abcjs needed `parseOnly`, not `renderAbc`, in n8n's sandbox; a bracket-count heuristic
  rejected every piece ending in `|]`), both fixed.
- **Not tested:** real score recognition (needs Audiveris + music21 installed; the plumbing
  around it is tested), n8n 2.x (needs Node 24; this was verified on 1.123 with
  `N8N_RUNNERS_ENABLED=false`).

---

## 6. External services

| Service | Role | Required? |
|---|---|---|
| **OpenRouter** | LLM gateway; default model `moonshotai/kimi-k2.6` (open weights) for composer and critic | yes (or Ollama) |
| **Ollama** | Local LLM alternative | no |
| **abcjs** (npm) | ABC parsing for validation + in-browser rendering | yes (bundled) |
| **n8n** | Automation: inbox, compose webhook, validation + OMR services (§5). Fair-code licence, not OSI open source | no |
| **Audiveris + music21** | OMR toolchain used by the OMR workflow / local backend | only for PDF/image → ABC |
| **Pi** | Base agent that drives everything | for the chat experience |

---

## 7. Design decisions

- **Fixed tool, not self-editing code.** The agent is invoked as a CLI; Pi's skill
  forbids touching `src/`, `scripts/`, `dist/` during music tasks.
- **Deterministic where possible.** Transposition, analysis and gap-finding are
  code, not LLM guesses; the LLM gets those facts in its prompt.
- **Validate everything.** Every LLM output is parsed by abcjs; errors loop back.
- **Model choice.** DeepSeek V4 Pro was tried first and dropped: it wrote
  single-line ABC, used `F#` instead of `^F`, and would not emit critic JSON.
  Kimi K2.6 (open weights, modified-MIT licence) is the default: valid multi-line ABC,
  correct `^F` accidentals, clean critic JSON. Measured on this project: 17–40 s per run
  (Claude Sonnet 5.5 took ~90 s) at critic scores of 4.5–7/10 (Sonnet: 7–7.3), and it is
  a "thinking" model, so `reasoning: { enabled: false }` is set per role (without it the
  4096-token budget was spent thinking and the answer was empty). Sonnet 5.5 remains a
  drop-in alternative in `config.yaml`.
- **Enforced, not requested.** In a gap-fill the model kept rewriting other bars during the
  critic-driven revision (seen live with Kimi). The loop now checks every bar outside the
  gap against the original, retries or rejects the edit, and keeps the best-scoring version.
- **Offline-testable.** Every layer has a smoke test using fake LLMs / mock n8n.
