# Pi integration

This makes Pi the "base" for sheet-music tasks: a **music tool** Pi drives, not
code Pi edits. Music tasks (compose, transpose, convert sheet music → ABC) run
the fixed `pi-music-agent` CLI; Pi never touches the music agent's own source.

## What's in here

- `sheet-music.ts` — a Pi **extension** that registers slash commands and
  model-callable tools.
- `skills/sheet-music/` — a Pi **skill** (`SKILL.md` + an ABC cheatsheet) that
  teaches Pi how to do music tasks and when to stop.

## Install

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills/sheet-music/references
cp sheet-music.ts ~/.pi/agent/extensions/sheet-music.ts
cp skills/sheet-music/SKILL.md ~/.pi/agent/skills/sheet-music/SKILL.md
cp skills/sheet-music/references/abc-cheatsheet.md \
   ~/.pi/agent/skills/sheet-music/references/abc-cheatsheet.md
```

Then start Pi in that project (or anywhere) and it discovers both. Set
`MUSIC_AGENT_DIR` to point at your `pi-music-agent` checkout if it is not at
`~/pi-music-agent`.

## What the user can say in Pi

- `"write me a minuet based on the work in the input folder"` → Pi reads
  `input/*.abc`, then runs `/compose … --refs input`.
- `"rewrite this in F major"` → Pi analyzes the key, computes the semitone
  offset, then runs `/music-transpose <file> <semitones>`.
- `"fill in the gap in input/piece.abc"` → `sheetmusic_analyze` finds the gap, then `sheetmusic_edit` fills it.
- `"turn input/score.pdf into notation"` → Pi runs `/music-convert input/score.pdf`.

The skill keeps Pi honest: it composes/mutates **music**, and if asked to change
the music tool's code, it says so and switches to normal code-editing.

## Model tools

| Tool | Purpose |
|---|---|
| `sheetmusic_compose { request, style?, title?, refDir? }` | write a new piece (optionally in the style of reference ABC) |
| `sheetmusic_edit { file, instruction, style? }` | change an existing piece, e.g. "fill in the gap" |
| `sheetmusic_analyze { file }` | free facts: bars, meter, key, voices, candidate gaps |
| `sheetmusic_transpose { file, semitones }` | move to another key (deterministic) |
| `sheetmusic_convert { file }` | PDF/image/MusicXML → ABC |

## Slash commands

`/music` · `/compose` · `/music-edit` · `/music-analyze` · `/music-transpose` ·
`/music-convert` · `/music-render` · `/music-validate` · `/music-list`

Relative file paths are resolved against Pi's working directory first, then the
music agent folder (so `input/piece.abc` works from anywhere).

After changing the extension or skill, run `/reload` in Pi. The extension runs
the *built* CLI, so run `npm run build` in the music agent after pulling changes.
