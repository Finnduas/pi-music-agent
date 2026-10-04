# Contributing

Thanks for your interest in `pi-music-agent`! This project is licensed under the
GNU General Public License, version 3 or later, and contributions of all kinds
are welcome: bug reports, feature ideas, docs, and pull requests.

## Getting started

```bash
git clone https://github.com/Finnduas/pi-music-agent.git
cd pi-music-agent
npm install
cp config.example.yaml config.yaml   # optional; defaults work out of the box
npm run typecheck
npm run smoke                        # offline loop + n8n mock, no API key needed
```

You do **not** need an API key to develop: the smoke tests inject fake LLM roles
and a mock validation webhook. Only `compose` with real models needs
OpenRouter or Ollama.

## Project conventions

- TypeScript, ESM, strict mode. Keep `npm run typecheck` green.
- Keep the validation/render/store layers free of LLM-specific logic — the agent
  loop in `src/loop/orchestrator.ts` wires them together.
- New behaviour should be covered by a `scripts/smoke-*.ts` check where practical.
- Never commit secrets. `config.yaml`, `.env` and generated `.input/*` and `.output/*` are
  git-ignored on purpose.

## Pull requests

1. Fork and branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Run `npm run typecheck && npm run smoke` before opening the PR.
3. Describe the motivation and, for loop/render changes, paste sample output.

## Reporting issues

Open an issue at <https://github.com/Finnduas/pi-music-agent/issues> with steps to
reproduce, expected vs. actual behaviour, and your Node version.
