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
│  validate · render · store     (OpenRouter → Claude Sonnet 5.5)      │
└───────────────┬──────────────────────────────────────────────────────┘
                │ optional HTTP
┌───────────────▼───────────── n8n ────────────────────────────────────┐
│  validation webhook · OMR (sheet music → ABC) webhook                │
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
  config.ts              Loads config.yaml, resolves API keys (config → env →
                         ~/.pi/agent/auth.json), sanitises values.
  types.ts               Shared types (ComposeRequest, ComposeResult, …).

  loop/
    orchestrator.ts      THE agent loop: compose|edit → validate → critique →
                         revise → render → store.  (composePiece)
    session.ts           Interactive REPL (/edit /critique /transpose /save …).
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
    n8n-workflow.json    Importable n8n workflow (validation).

  convert/
    convert.ts           Sheet music (PDF/image/MusicXML) → ABC via n8n or local
                         Audiveris+music21; ABC passes straight through.
    n8n-omr-workflow.json  Importable n8n workflow (OMR).

  render/renderer.ts     ABC → HTML viewer (abcjs, offline) + optional SVG.
  store/store.ts         Saves .json record + index.jsonl (optional SQLite).

prompts/                 composer.md, critic.md — the LLM system prompts.
pi-integration/          sheet-music.ts (Pi extension) + skills/sheet-music/.
scripts/                 n8n workflow generators + offline smoke tests.
examples/  input/  output/  docs/
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
`/music-render`, `/music-validate`, `/music-list`, `/music` (status).

### Tools the *composer LLM* itself can call (inside the music agent)

`analyze_score`, `transpose` (`src/loop/tools.ts`). If a provider rejects native
tool-calling, the agent silently falls back to plain chat and injects the same
facts into the prompt as a "Score facts" block, so quality does not depend on it.

### CLI (what everything above shells out to)

`compose · edit · analyze · transpose · convert · validate · render · list · show · session · config`

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
| 9 | **Composer LLM** (Sonnet 5.5 via OpenRouter) | Returns the full score in an ```` ```abc ```` block. `parse.ts` extracts it. |
| 10 | **orchestrator** | Re-runs gap detection → logs *"Remaining candidate gaps: none"*. |
| 11 | **validator** | abcjs parses the result (or the n8n webhook, if configured). If invalid, errors go back to the composer, up to `maxValidationRetries` (5). |
| 12 | **Critic LLM** | Scores 0–10 with strengths/issues/suggestions. If score ≥ `scoreThreshold` (8) → stop. Otherwise a *revise* pass runs (with "change nothing outside the edited passage") and we loop, up to `maxIterations` (3). |
| 13 | **renderer + store** | Writes `output/<title>-<id>.abc`, `.html` (offline viewer), a `.json` record, and appends `index.jsonl`. |
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

n8n is an **optional external service** with a deliberately small role. It runs
two importable webhook workflows. It contains **no LLM, no loop, no storage**.

```
music agent ──HTTP POST──► n8n Webhook ──► Code node ──► Respond to Webhook ──► JSON back
```

| | Validation workflow | OMR workflow |
|---|---|---|
| File | `src/validate/n8n-workflow.json` | `src/convert/n8n-omr-workflow.json` |
| Generator | `npm run gen:n8n` | `npm run gen:n8n:omr` |
| Webhook path | `/webhook/notation-validation` | `/webhook/omr-conversion` |
| Request | `{ notation, title?, style? }` | `{ filename, mimeType, data(base64) }` |
| Response | `{ valid, errors[], warnings[] }` | `{ abc, valid, errors[], warnings[] }` |
| Nodes | Webhook → Code (abcjs / structural checks) → Respond | Webhook → Code (Audiveris → MusicXML → music21 → ABC) → Respond |
| Used by | `validator.ts` (every compose/edit/revise cycle) | `convert.ts` (`convert` command / `sheetmusic_convert`) |
| Switch on | `validation.backend: n8n` | `conversion.backend: n8n` |

- **Default is no n8n.** `validation.backend: local` parses with abcjs in-process;
  `conversion.backend: none`. The system works fully without n8n.
- **Why n8n at all?** It is the project's required "validation as a service"
  boundary, and the natural place to bolt on heavyweight OMR tools (Audiveris,
  music21) without putting them inside the agent. Swap or extend the workflow
  visually without touching agent code.
- **Failure behaviour:** an unreachable webhook yields a clear
  `n8n webhook unreachable` validation error rather than a crash.
- **Tested offline** with a mock webhook: `scripts/smoke-n8n.ts`.
- **Not yet live-tested:** the OMR workflow against a real n8n + Audiveris
  install (the contract and error handling are tested with mocks; the setup is in
  `scripts/install-tools.md`).

Setup steps: [USAGE.md → n8n validation service](USAGE.md#n8n-validation-service-optional).

---

## 6. External services

| Service | Role | Required? |
|---|---|---|
| **OpenRouter** | LLM gateway; default model `anthropic/claude-sonnet-5.5` for composer and critic | yes (or Ollama) |
| **Ollama** | Local LLM alternative | no |
| **abcjs** (npm) | ABC parsing for validation + in-browser rendering | yes (bundled) |
| **abc2svg / abcm2ps** | Optional SVG engraving | no |
| **better-sqlite3** | Optional SQLite index | no |
| **n8n** | Validation + OMR webhooks (§5) | no |
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
  Claude Sonnet 5.5 works (live runs scored 7–7.3/10 after 1–2 iterations).
- **Offline-testable.** Every layer has a smoke test using fake LLMs / mock n8n.
