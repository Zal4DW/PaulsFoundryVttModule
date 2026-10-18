# Paul's Foundry VTT Module

Minimal hello-world framework module for Foundry VTT v13+, system-agnostic (works with Crucible; Ember is not required).

- `module.json` – manifest
- `scripts/main.mjs` – settings registration, `/hello` chat command, render hook
- `scripts/lib/` – pure helpers with no Foundry globals (unit tested)
- `scripts/quench/` – in-Foundry tests, loaded only when Quench is active
- `lang/en.json`, `styles/module.css`

Install by placing this folder in `Data/modules/pauls-foundry-module` (or using the manifest URL), enable it, and type `/hello` in chat.

## Development

A Docker Foundry v14 server, ESLint, Vitest, Quench and a Playwright smoke test are set up. See [docs/testing.md](docs/testing.md).
