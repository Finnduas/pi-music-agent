# Installing the optional tools

The harness runs with just Node.js + (`local` abcjs) validation. Everything here
is optional and unlocks better rendering, fully-local LLMs, or the OMR stretch
goal.

---

## 1. SVG / PDF engraving

The renderer auto-detects these on `PATH` (or set `render.abc2svgPath` /
`render.abcm2psPath`). Without them you still get the offline abcjs HTML viewer.

### abc2svg (recommended)

`abc2svg` is a set of scripts around a JavaScript ABC engine. It needs Node or a
JS shell.

**Debian / Raspberry Pi OS**

```bash
sudo apt-get update
sudo apt-get install -y abc2svg
# or, for the newest version:
git clone https://github.com/abc2svg/abc2svg
cd abc2svg && sudo make install
```

**Windows** — via Scoop or Chocolatey, or install the upstream scripts and put
them on `PATH`:

```powershell
scoop install abc2svg        # if available in your bucket
# otherwise clone https://github.com/abc2svg/abc2svg and add it to PATH,
# ensuring `node` is available (already required by this project).
```

Verify: `echo 'X:1\nK:C\nCDEF|' | abc2svg -` should print SVG.

### abcm2ps (older but very stable)

```bash
# Debian / Pi
sudo apt-get install -y abcm2ps

# macOS
brew install abcm2ps

# Windows (MSYS2)
pacman -S mingw-w64-x86_64-abcm2ps
```

### LilyPond (publication quality, optional)

```bash
sudo apt-get install -y lilypond    # Debian/Pi
brew install lilypond               # macOS
choco install lilypond              # Windows
```

Convert ABC → LilyPond with `abc2ly`, then engrave with `lilypond`.

### MuseScore CLI (optional)

Install MuseScore 4, then use `mscore -o out.pdf in.musicxml`. Useful for the OMR
pipeline below.

---

## 2. Local LLMs with Ollama

Run the whole composer/critic pair offline.

```bash
# Install: https://ollama.com/download
ollama pull qwen2.5:14b        # good general model; use a smaller one on a Pi
ollama pull llama3.1:8b        # alternative
```

Ollama exposes an OpenAI-compatible endpoint at `http://localhost:11434/v1`
(no API key). Point the roles at it in `config.yaml`:

```yaml
roles:
  composer: { provider: ollama, model: "qwen2.5:14b", temperature: 0.9 }
  critic:   { provider: ollama, model: "qwen2.5:14b", temperature: 0.2 }
```

On a Raspberry Pi prefer `qwen2.5:3b` / `llama3.2:3b` and expect more validation
retries — the retry loop is designed to absorb that.

---

## 3. Stretch: sheet music → ABC (OMR)

Turns a PDF/image of **clean printed** music into MusicXML, then to ABC, returned
through the validation service. Handwritten or heavily engraved scores are
error-prone.

### Audiveris (OMR → MusicXML)

```bash
# Debian/Pi (Java required)
sudo apt-get install -y default-jre
# download the latest release from
# https://github.com/Audiveris/audiveris/releases
```

CLI example:

```bash
audiveris -batch -export -output ./out ./input.pdf
```

### music21 or verovio (MusicXML → ABC)

```bash
pip install music21
# or
pip install verovio
```

music21 conversion example:

```bash
python - <<'PY'
from music21 import converter
s = converter.parse('out/input.musicxml')
s.write('abc', fp='out/input.abc')
PY
```

Then POST the resulting ABC to the validation service, and only accept it when
`valid: true`.

### Suggested n8n conversion workflow

```
Webhook (PDF/image)
  -> write file
  -> Exec: audiveris -batch -export -> MusicXML
  -> Exec: music21 -> ABC
  -> HTTP Request: POST to Notation Validation Service
  -> Respond: { abc, valid, errors[], warnings[] }
```

---

## 4. Windows notes

- This project is developed and smoke-tested on Windows with Git Bash.
- Add tool directories (e.g. the abc2svg clone) to `PATH`, or set the absolute
  paths in `config.yaml`:

  ```yaml
  render:
    abc2svgPath: "C:/tools/abc2svg/abc2svg"
    abcm2psPath: "C:/msys64/mingw64/bin/abcm2ps"
  ```

- `better-sqlite3` is an **optional** dependency. If its native build fails, the
  store transparently falls back to `output/index.jsonl`; set
  `storage.database` only if you want the SQLite index.
