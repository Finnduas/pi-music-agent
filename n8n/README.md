# n8n workflows

n8n is optional. These four workflows let it **drive** the music agent (inbox, webhook) and
**serve** it (validation, scanned-music conversion). Background and flow diagrams:
[docs/ARCHITECTURE.md §5](../docs/ARCHITECTURE.md#5-n8n-what-it-does-here).

| File | Direction | Trigger | Needs |
|---|---|---|---|
| `inbox.json` | n8n → agent | a new file in `.input/` | `npm run serve` |
| `compose-webhook.json` | n8n → agent | `POST /webhook/compose-piece` | `npm run serve` + LLM key |
| `validation.json` | agent → n8n | `POST /webhook/notation-validation` | `abcjs` available to n8n |
| `omr-conversion.json` | agent → n8n | `POST /webhook/omr-conversion` | Audiveris + music21 on n8n's `PATH` |

`code/validate.js` and `code/omr.js` are the JavaScript inside the two Code nodes.
**Edit those and run `npm run gen:n8n`** to rebuild the JSON (the JSON files are generated;
edits made only in n8n's UI are lost when you regenerate).

## Set up

1. **Install n8n** (self-hosted): `npm i -g n8n`. This was tested on **n8n 1.123 with Node 22**.
   n8n 2.x needs Node 24 and runs Code nodes in task runners (extra environment settings);
   not tested.
2. **Environment for n8n** (the Code nodes use `require`):

   ```bash
   export NODE_FUNCTION_ALLOW_EXTERNAL=abcjs                 # validation workflow
   export NODE_FUNCTION_ALLOW_BUILTIN=child_process,fs,os,path   # OMR workflow
   export N8N_RUNNERS_ENABLED=false                          # how it was tested
   ```

   and install abcjs where n8n can resolve it, e.g. in n8n's own folder: `npm i abcjs`.
   Without it the validation workflow still runs but only checks headers, and says so in
   its `warnings`.
3. **Start n8n from the project folder**, because the inbox watches `./.input` relative to
   where n8n was started:

   ```bash
   cd pi-music-agent && n8n start         # editor at http://localhost:5678
   ```

   (To watch another folder, open the *New file in .input* node and set an absolute path.)
4. **Import** each file: *Workflows → ⋯ → Import from File*, then flip **Active** on.
   A webhook that answers `404 … is not registered` means the workflow is not active.
5. **Start the agent API** (needed by the inbox and the compose webhook):

   ```bash
   npm run build && npm run serve          # http://127.0.0.1:7878
   ```

6. To have the agent *call* n8n, set `validation.backend: n8n` and/or
   `conversion.backend: n8n` in `config.yaml` (webhook URLs are preset to localhost).

> `n8n import:workflow` from the command line imports these files, but in n8n 1.123 the
> workflows cannot then be activated from the CLI; use the UI (or its REST API).

## Use

**Inbox:** copy a file into `.input/`.

| You drop | Result |
|---|---|
| `piece.abc` with a gap (rest-only or `"^GAP"` bars) | the gaps are filled; `.output/<title>-<id>.abc` + `.html` are written; the last node reports `gaps filled`, score and files |
| `piece.abc` without gaps | reports `no gaps found` (bars, key, meter) |
| `score.pdf` / `.png` / `.jpg` / `.musicxml` / `.mxl` … | converted to ABC (needs a conversion backend), then as above; otherwise reports `conversion failed` with the reason |
| anything else (`.txt`, …) | ignored |

Read the outcome in n8n under *Executions* (the last node, *Report: …*). To get notified,
add an Email / Slack / Telegram node after the *Report* nodes.

**Compose webhook:**

```bash
curl -X POST http://localhost:5678/webhook/compose-piece \
  -H 'Content-Type: application/json' \
  -d '{"request":"a short cheerful minuet in G major","style":"classical","title":"Hello"}'
```

Returns `{ id, title, score, summary, abc, files, warnings, seconds }` (about 20–60 s).
Missing `request` → HTTP 400 `{ "error": "\"request\" is required." }`. Optional `refs`: a folder
inside the project with `.abc` files to emulate.

## Check it

`npm run check:n8n` (with n8n and `serve` running and the workflows active) verifies that
the validation workflow gives the same verdicts as the local validator, that the compose
webhook handles bad input cleanly, and that the API refuses paths outside the project.
`npm run check:n8n -- --full` also composes a piece through the webhook.

## Safety notes

- The agent API listens on `127.0.0.1` only and accepts only paths inside the project.
- n8n webhooks are unauthenticated by default. `compose-piece` spends LLM credits, so do
  not expose n8n to the internet without adding authentication (Webhook node → Authentication).
- n8n's licence is "fair-code" (source-available), not OSI open source.
