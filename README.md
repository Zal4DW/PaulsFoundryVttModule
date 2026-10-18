# Paul's Foundry VTT Module

Minimal hello-world framework module for Foundry VTT v13+, system-agnostic (works with Crucible; Ember is not required).

- `module.json` – manifest
- `scripts/main.mjs` – settings registration, `/hello` chat command, render hook
- `scripts/lib/` – pure helpers with no Foundry globals (unit tested)
- `scripts/quench/` – in-Foundry tests, loaded only when Quench is active
- `lang/en.json`, `styles/module.css`

Install by placing this folder in `Data/modules/pauls-foundry-module` (or using the manifest URL), enable it, and type `/hello` in chat.

## Crucible: weapon grip

Crucible's sheet always equips a Versatile weapon in its default grip, so a Bastard Sword can't be wielded two-handed (Swipe needs a two-handed weapon). The module adds a hand icon to each equipped Versatile weapon in the inventory. Click it to switch between one hand and two. It costs 0 AP, and two hands need the other hand free. Macros can call `game.modules.get("pauls-foundry-module").api.toggleGrip(item)`.

## Development

A Docker Foundry v14 server, ESLint, Vitest, Quench and a Playwright smoke test are set up. See [docs/testing.md](docs/testing.md).
