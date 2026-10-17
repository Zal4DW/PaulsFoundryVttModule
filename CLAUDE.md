# Paul's Foundry Module

Foundry VTT module. The target is Foundry VTT **v14**.

## Check the Foundry API docs before you use an API

Before you write or change code that calls a Foundry API (a class, method, hook, `CONFIG` or `CONST` entry, or a document field), look it up in the official API docs at https://foundryvtt.com/api/ and confirm it exists in v14 with that signature.

- Use the v14 pages: `https://foundryvtt.com/api/v14/...`. Hooks are at `https://foundryvtt.com/api/v14/modules/hookEvents.html`.
- Do not rely on memory or on older examples. The API changes between major versions, and v13 code is common online.
- If the docs mark an API as deprecated, use the replacement they name.
- If the docs leave a behaviour unclear (for example, the `chatMessage` hook is typed `void` but the module returns `false` to cancel), say so in a code comment, and add a Quench or Playwright test that checks the behaviour on the v14 server.
- For changes between builds, read the release notes at `https://foundryvtt.com/releases/<build>`.

General module guidance (manifest fields, folder layout): https://foundryvtt.com/article/module-development/

## Code layout

- `scripts/main.mjs` is the entry point. It registers hooks and settings.
- `scripts/lib/` holds pure helpers. They use no Foundry globals, so Vitest can test them in Node.
- `scripts/quench/` holds in-Foundry tests. `main.mjs` loads them only from the `quenchReady` hook.

## Tests

Read `docs/testing.md` for the full setup.

- `npm run lint` and `npm test` need no server. Run them after every change.
- `npm run test:e2e` needs the Docker v14 server (`npm run foundry:up`).
- Never read, print or commit `secrets/foundry.json`. It holds the user's Foundry credentials.
