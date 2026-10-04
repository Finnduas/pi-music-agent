# Presentation: "Claude Code for sheet music"

A 15–20 minute talk + live demo. One slide per heading; speaker notes under each.

---

## 1. The idea (1 min)

**"Claude Code, but the thing you're editing is a score."**

You type *"fill in the gap in this piece"*; an agent finds the gap, writes the
music, checks it is valid, has it critiqued, and hands you printable sheet music.

*Notes:* Frame it as a pattern, not just music: a general-purpose agent (Pi) plus a
small, fixed, domain tool.

## 2. The problem (1 min)

- LLMs can "write music" but output is often invalid, unplayable, or unverifiable.
- Sheet music is locked in PDFs/images; an LLM cannot read them.
- General coding agents are happy to *edit their own tools* — risky and unpredictable.

## 3. The architecture (3 min)

Show the diagram from [ARCHITECTURE §1](ARCHITECTURE.md#1-the-big-picture):

```
You → Pi (base agent) → sheetmusic_* tools → pi-music-agent CLI → LLM · abcjs · n8n
```

Three ideas to land:

1. **ABC notation is the intermediate language** — plain text an LLM can read/write
   and a parser can verify. PDF/image → ABC → HTML/SVG.
2. **Pi is the brain, the music agent is a fixed tool.** Pi never edits the music
   agent's code during music tasks (enforced by a skill).
3. **Deterministic code does what code does well** (analysis, gap detection,
   transposition, validation); the **LLM only does the creative part**.

## 4. The agent loop (2 min)

```
compose|edit → validate ⇄ fix → critic (0–10) → revise → render → store
```

- Validation errors are fed back to the composer (up to 5 times).
- The critic scores the piece; below 8/10 it revises (up to 3 rounds).
- Output: `.abc`, offline `.html` viewer (Print/Save PDF), JSON record.

## 5. Where n8n fits (2 min)

- Two webhook workflows: **validation** and **sheet-music → ABC (OMR)**.
- No LLM and no state in n8n; the agent calls it over HTTP.
- Optional: defaults work with zero n8n. Flip `validation.backend: n8n` to use it.
- Why: validation-as-a-service boundary + a visual place to hang heavy OMR tools
  (Audiveris, music21) outside the agent.

## 6. LIVE DEMO (6 min)

Setup: `pi` open in `pi-music-agent/`. Have `examples/input/minuet-with-gap.abc`
and a browser ready.

| Step | You type in Pi | What the audience sees |
|---|---|---|
| 0 | `/music` | Extension loaded; list of commands |
| 1 | *"Fill in the gap in examples/input/minuet-with-gap.abc"* | Pi reads the file, calls `sheetmusic_analyze` (gaps: bars 5–6), then `sheetmusic_edit` |
| 2 | (open the new `output/*.html`) | Rendered sheet music; click **Print / Save PDF** |
| 3 | *"Rewrite examples/input/ode-to-joy.abc in F major"* | `analyze` → compute 5 semitones → `sheetmusic_transpose` (instant, no LLM) |
| 4 | *"Write me a short minuet in the style of the pieces in examples/input"* | `sheetmusic_compose` with references; ~1–2 min |
| 5 | *"What key is output/….abc in?"* | `sheetmusic_analyze` only — free |

*Tips:* the compose/edit calls take 30–90 s (two LLM calls per round) — talk
through the loop while waiting. Run step 1 once before the talk as a backup and
keep its HTML open in a tab.

**If the network or API fails:** run `npm run smoke` — the whole loop runs
offline with fake LLMs and prints PASS lines; show `examples/output/` instead.

## 7. Trust & testing (1 min)

- `npm run smoke`: 8 offline suites (analysis, transposition + abcjs-MIDI oracle, render, convert, full loop,
  edit/gap-fill, n8n mock) — no API key.
- Real LLM and real Pi runs verified end-to-end.
- Honest limits: gap-finder is a heuristic; musical quality is "plausible and in
  key" (critic scored 7–7.3/10); OMR (PDF → ABC) is wired and mock-tested but needs
  Audiveris + n8n installed to run for real.

## 8. What I learned / design choices (1 min)

- Model matters: DeepSeek V4 Pro failed at strict ABC; Claude Sonnet 5.5 works.
- Giving the LLM *facts* (bar count, key, gaps) beats asking it to count.
- Keep the creative LLM inside validate-and-critique rails.

## 9. Next steps (30 s)

OMR end-to-end with real scans · MIDI/audio playback · multi-voice-aware gap
filling · richer critic (voice-leading rules).

---

## Likely questions

**Is it really "Claude Code for sheet music"?** Same pattern: a general agent with
file access plus a domain tool. Here the "code" is ABC and the "compiler" is the
abcjs validator.

**Why not let the LLM transpose?** It makes arithmetic mistakes; transposition is
deterministic code. Same for counting bars and finding gaps.

**Can it read a PDF?** Via the OMR workflow (Audiveris → MusicXML → music21 → ABC)
in n8n or locally. Not live-tested end-to-end yet — it is mock-tested.

**Which model?** `anthropic/claude-sonnet-5.5` through OpenRouter (swap in
`config.yaml`; Ollama also supported).

**Can Pi break the music agent?** For music tasks the skill forbids editing its
source; the extension only runs the built CLI.

**Cost/time?** Roughly one composer + one critic call per round; a typical run is
30–90 s.
