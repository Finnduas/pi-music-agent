# Examples

Ready-made files for a demo or presentation.

## input/ — drop these to drive composition

| File | What it is | Provenance |
|---|---|---|
| `ode-to-joy.abc` | Beethoven, "Ode to Joy" (opening phrase) | Public domain; hand-transcribed ABC |
| `twinkle-twinkle.abc` | "Twinkle, Twinkle, Little Star" | Traditional; public domain |

Use them as style references:

```bash
npx tsx src/cli.ts compose "a classical piano piece in the spirit of the input folder" --refs examples/input

# or transpose one into another key ("rewrite in F major")
npx tsx src/cli.ts transpose 5 examples/input/ode-to-joy.abc      # C -> F
```

## output/ — what the agent produces

| File | What it is |
|---|---|
| `minuet-in-g-major.abc` | The ABC source of a composed minuet |
| `minuet-in-g-major.html` | Offline, interactive sheet-music viewer (open in a browser; use its Print/Save PDF button) |
| `abcjs-basic-min.js` | Vendored renderer so `minuet-in-g-major.html` works offline |

This minuet was produced end-to-end by the agent loop: compose → validate →
critique (scored 7/10) → revise → render → store.

## Licensing note

All example music is public domain (Bach/Beethoven/traditional melodies are in
the public domain; the "minuet" is an original machine-generated work). No
copyrighted sheet music is bundled. If you add real scanned sheet music to
demonstrate the OMR (`convert`) pipeline, use public-domain scans and list their
source here.