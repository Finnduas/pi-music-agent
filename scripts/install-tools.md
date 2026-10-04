# Optional tools

Nothing here is needed to compose, edit, transpose or view music. Install only what you use.

## 1. Local LLMs with Ollama (fully offline composing)

```bash
# Install: https://ollama.com/download
ollama pull qwen2.5:14b        # good general model; use a smaller one on a Raspberry Pi
```

Ollama exposes an OpenAI-compatible endpoint at `http://localhost:11434/v1` (no API key).
Point the roles at it in `config.yaml`:

```yaml
roles:
  composer: { provider: ollama, model: "qwen2.5:14b", temperature: 0.9 }
  critic:   { provider: ollama, model: "qwen2.5:14b", temperature: 0.2 }
```

Expect weaker ABC from small models and more validation retries; the loop absorbs that.

## 2. Reading scanned sheet music (PDF/image → ABC)

Turns a PDF/image of **clean printed** music into MusicXML (Audiveris), then into ABC
(music21). Handwritten or dense scores are error-prone. **This path has not been tested
with the real tools** (only the plumbing around it, see `docs/ARCHITECTURE.md` §5).

```bash
# Audiveris (needs Java): https://github.com/Audiveris/audiveris/releases
audiveris -batch -export -output ./out ./score.pdf

# music21 (needs Python)
pip install music21
```

Then choose where the conversion runs, in `config.yaml`:

| `conversion.backend` | Runs | Setup |
|---|---|---|
| `local` | the agent calls `audiveris` and `python` directly | both on `PATH` (or set `conversion.local.audiveris` / `.music21`) |
| `n8n` | the **OMR Conversion Service** workflow does it | import `n8n/omr-conversion.json`, allow `child_process` in n8n, tools on n8n's `PATH`; see [n8n/README.md](../n8n/README.md) |

Check: `node dist/cli.js convert .input/score.pdf`.

## 3. n8n

See [n8n/README.md](../n8n/README.md).

## 4. Windows notes

- Install tools somewhere and add the folder to `PATH`, or set the absolute path in
  `config.yaml` (use forward slashes: `"C:/tools/audiveris/bin/audiveris"`).
- The n8n Code node starts programs without a shell, so on Windows point it at a real `.exe`;
  a `.cmd`/`.bat` wrapper may not start (not tested).
- Git Bash / PowerShell both work for every command in the docs.
