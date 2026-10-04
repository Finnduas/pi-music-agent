---
name: sheet-music
description: Compose, transpose, rewrite, or convert sheet music using ABC notation. Use when the user wants music written, generated, transposed to a key, or sheet music (PDF/image) turned into notation. Do NOT edit the music agent's own source code for these tasks.
---

# Sheet music tasks

You are working with a **music tool**, not editing its source code. For music
tasks, drive the `pi-music-agent` CLI (already built at `<music-dir>/dist/cli.js`)
and report the results. Do not modify files under the music agent's `src/`,
`scripts/`, or `dist/` directories while doing music work.

## Folders

- `.input/` — drop source sheet music here (PDF, image, MusicXML, or ABC).
- `.output/` — rendered pieces land here (`.abc` and an `.html` viewer with Play / MIDI / Print).

## Slash commands (preferred, available in Pi)

- `/compose <request>` — write a piece (add `--style <s>`, `--refs .input`).
- `/music-list` — list stored compositions.
- `/music-analyze <file>` — bars, meter, key, tonic, voices.
- `/music-edit <file> <instruction>` — change an existing piece ("fill in the gap").
- `/music-transpose <file> <semitones>` — "rewrite in F major" style.
- `/music-convert <file>` — sheet music (PDF/image) → ABC.

## Model tools (you may call directly)

- `sheetmusic_analyze { file }` — free, instant facts: bars, key, meter, voices, **candidate gaps**.
- `sheetmusic_edit { file, instruction, style? }` — edit an existing score (fill a gap, rework a passage).
- `sheetmusic_compose { request, style?, title?, refDir? }`
- `sheetmusic_transpose { file, semitones }`
- `sheetmusic_convert { file }`

## Worked examples

**"Write me a minuet based on the work in the input folder."**
1. Look at `.input/*.abc` (convert any PDFs/images there first with `sheetmusic_convert`).
2. `/compose a minuet in the style of the input pieces --refs .input`.

**"Fill in the gap in this piece."**
1. `sheetmusic_analyze { file }` — it lists candidate gaps (rest-only or `"^GAP"` bars).
2. `sheetmusic_edit { file, instruction: "fill in the gap in bars 5-6, ..." }`. Include the bar numbers from step 1.
3. Tell the user where the result was written (`.output/`) and the critic score.

**"Rewrite this in F major."**
1. `runCli` `analyze <file>` to find the current tonic.
2. Compute the semitone offset to F (F = pitch class 5).
3. `/music-transpose <file> <semitones>` (or `sheetmusic_transpose`).

## ABC notation quick rules

Read `references/abc-cheatsheet.md`. The essentials:

- Headers: `X:` (number), `T:` (title), `M:` (meter), `L:` (note length), `K:` (key). `X:` and `K:` are mandatory.
- Sharps are `^F` (NOT `F#`), flats `_B`, naturals `=C`.
- Octaves: `C`=middle, `C,`=low, `c`/`c'`=high.
- Durations: `A2`=half, `A4`=quarter, `A3/2`=dotted.
- Bars: `|`, repeat `|: ... :|`, end `|]`.

## If asked to change the music tool itself

That is a DIFFERENT task — say so and switch to editing the pi-music-agent
source under `<music-dir>` like normal code. Do not mix it into music tasks.