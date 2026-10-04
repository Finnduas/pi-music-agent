# Pi-Agent Brief: Classical Music Harness

**Division of labor:** n8n does validation only. Everything else (compose, critique,
iterate, render, store) is the agent's job as tools.

## 1. Notation language: ABC

Plain-text, LLM-friendly, mature local tooling. Input and output are ABC; every
generated or user-supplied ABC must pass validation before acceptance.

## 2. n8n — validation only

One small workflow "Notation Validation Service":

    Webhook (POST { notation, title?, style? })
      -> validation via real ABC tooling
         (abcjs parse in a Code node, or shell out to abc2svg/abcm2ps syntax check)
      -> JSON response { valid, errors[], warnings[] }

No LLM, no loop, no storage in n8n. Called as an HTTP tool.

## 3. Rendering ABC -> viewable sheet music (local)

- **abc2svg / abcm2ps** (CLI): `piece.abc` -> SVG/PDF — the default file output.
- **abcjs**: renders ABC to SVG in a small static HTML page for an interactive viewer.
- Optional upgrade: LilyPond (`abc2ly`) or MuseScore CLI for publication quality.

## 4. LLM: OpenRouter default, local open-source option

One OpenAI-compatible client with switchable `base_url`:

- OpenRouter: `https://openrouter.ai/api/v1` (user's key)
- Ollama (local, open models — Llama/Qwen/Mistral): `http://localhost:11434/v1`, no key

Config file picks provider + model per role (composer, critic). Local models are
weaker at ABC — the validation + retry loop absorbs format errors.

## 5. Agent loop (replaces the old in-n8n loop)

    User request/ABC
      -> composer LLM
      -> validate via n8n webhook (feed errors back, max 3-5 tries)
      -> critic LLM (score + structured feedback)
      -> revise until score >= threshold or max iterations
      -> render SVG/PDF
      -> store locally (SQLite or compositions/ folder)
      -> return ABC + file paths + critic report

## 6. Optional stretch: sheet music -> ABC in n8n

Second n8n workflow: webhook takes a PDF/image, runs local OMR (**Audiveris** ->
MusicXML) + conversion (**music21** or verovio -> ABC) on the Pi, returns ABC
through the validation service. Works on clean printed scores; handwritten/complex
engraving is error-prone.

## 7. What the user (Mika) must do

1. Create an OpenRouter API key -> put it in the agent config (not n8n).
2. Publish the validation workflow in n8n -> give the live webhook URL to the agent.
3. Install `abc2svg` (or abcjs) on the Pi; LilyPond optional.
4. Optional: install Ollama + pull a model for fully-local operation.
5. Optional (stretch): install Audiveris + music21, publish the conversion workflow.
6. Tell the agent where to store compositions.

The old all-in-n8n prototype can be archived once this is running — MIDI/audio
stays out of scope as before.

---

## Implementation notes (as built)

This harness is a **Node/TypeScript CLI + tool layer** implementing the section 5
loop with two validation backends:

- `local`  — `abcjs` parse, works with zero external infrastructure (default).
- `n8n`    — HTTP POST to the published validation webhook from section 2.

Rendering prefers `abc2svg`/`abcm2ps` if installed, and always writes a
self-contained `abcjs` HTML viewer so output is viewable even without the CLIs.

See `README.md` at the repo root for setup and usage.
