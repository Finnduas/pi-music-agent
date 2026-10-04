# ABC notation cheatsheet

ABC is a plain-text music format. The music agent composes in this form.

## Minimal example

```abc
X:1
T:Minuet in D minor
M:3/4
L:1/8
Q:1/4=108
K:Dm
d2 e2 f2 | g2 a2 ^b2 | c'2 b2 a2 | d4 d2 |]
```

## Headers

| Header | Meaning | Example |
|---|---|---|
| `X:` | tune number (required) | `X:1` |
| `T:` | title | `T:Minuet` |
| `C:` | composer / credit | `C:Anonymous` |
| `M:` | meter | `M:3/4`, `M:4/4`, `M:6/8` |
| `L:` | default note length | `L:1/8` |
| `Q:` | tempo | `Q:1/4=108` |
| `K:` | key (required) | `K:D`, `K:Dm`, `K:F#` |

## Note names and octaves

- Notes are `A`–`G` and `a`–`g`. Uppercase is the lower octave, lowercase one octave up.
- `C` = middle C; `C,` = one octave lower; `C,` can be repeated (`C,,`).
- `c` = one octave above middle C; `c'` = two octaves up (repeat `'`).

## Accidentals

- Sharp: `^F` (a sharp sign `^` before the letter, NOT `F#`).
- Flat: `_B`.
- Natural: `=C`.
- Double sharp: `^^f`, double flat: `__B`.

## Durations

- Follow the note with a number: `A2` = half note, `A4` = quarter, `A` = default length (`L:`).
- Dotted: `A3/2`, `A/2` (fractions allowed).
- Ties: `A-B` (same pitch, held across the bar).
- Slurs: `(abc)`.

## Bars and repeats

- Bar line: `|`
- Repeat: `|: ... :|`
- Final bar: `|]`
- First/second endings: `[1 ... :|[2 ... |]`

## Chords and multiple voices

- Chord: `[CEG]`
- Voice: `V:1`, `V:2`, with `%%score (1 2)` for two-staff piano layouts.

## Good habits

- Put a blank line between the header block and the music body.
- Keep lines short; group a few measures per line.
- Every tune must start with `X:` and `K:` and be syntactically parseable by abcjs.