# Testing

The module has three test layers. Each one catches a different kind of fault.

| Layer | Tool | Runs where | Needs the server | Command |
|---|---|---|---|---|
| Lint | ESLint | Node | No | `npm run lint` |
| Unit | Vitest | Node | No | `npm test` |
| Integration | Quench | Inside a Foundry world | Yes | Quench window in Foundry, or the Playwright test |
| Smoke (end to end) | Playwright | Real browser against Docker Foundry | Yes | `npm run test:e2e` |

Keep logic that does not need `game` in `scripts/lib/`. That code takes no Foundry globals, so Vitest can test it in milliseconds. Code that touches documents, settings, hooks or the canvas gets a Quench test. Playwright checks that the whole thing loads on a real v14 server and that a user-visible flow works.

## One-time setup

You need Docker Desktop, Node 20 or later, and a Foundry VTT license.

1. Install the dev packages and the Playwright browser:

   ```bash
   npm install
   ```

   ```bash
   npx playwright install chromium
   ```

2. Copy the credentials template and fill it in. `secrets/foundry.json` is gitignored. Never commit it.

   ```bash
   cp secrets/foundry.example.json secrets/foundry.json
   ```

   The container uses your foundryvtt.com username and password to download the v14 release, and applies the license key. The server listens on `127.0.0.1` only, so the template has no admin key. If you want a password on the Setup screen, add `"foundry_admin_key": "..."`.

3. Start the server:

   ```bash
   npm run foundry:up
   ```

   Open http://localhost:30100. The first start downloads Foundry. Follow progress with `npm run foundry:logs`.

   Use `npm run foundry:up`, not plain `docker compose up`. The npm script first runs `tools/foundry-init.mjs`, which creates the data folders from Windows. If Docker creates them, they are owned by root, and Foundry stops with `EACCES: permission denied, mkdir '/data/Data/systems'`.

   The server uses host port 30100, so it does not clash with a normal Foundry server on 30000. Everything Foundry stores (worlds, systems, modules, settings) is in `.foundry/data` in this repo folder. It survives `docker compose down` and image updates.

4. In the browser, do these steps once. The data stays in `.foundry/data`.
   - Accept the license agreement (EULA).
   - Install a game system. Crucible is the module's target system. Any system works for these tests.
   - Install Quench from its manifest URL: `https://github.com/Ethaks/FVTT-Quench/releases/latest/download/module.json`
   - Create a world with the id `pfm-test`. That id matches `FOUNDRY_WORLD` in `compose.yaml`.
   - Launch the world as Gamemaster. Enable "Paul's Foundry Module" and "Quench" under Manage Modules.

5. Restart the server so it launches the world by itself from now on:

   ```bash
   docker compose restart foundry
   ```

## Worlds on the dev server

| World | System and content | Active modules | Use |
|---|---|---|---|
| `pfm-test` | Crucible, no adventure | Paul's Foundry Module, Quench | Automated tests. Keep it bare. |
| `pfm-ember` | Crucible with the Ember adventure imported | Ember and every installed module | Manual play testing with real content |

`pfm-ember` has four level 1 heroes in the Party group, and `crucible.party` points at that group:

| Hero | Build | Kit |
|---|---|---|
| Maren Ashgrove | Human, Arcturian, Imperial Conscript, Ragen. Soldier. | Bastard Sword, Leather Armor, Healing Elixir |
| Lyra Quillfeather | Neikas, Lumer, Academy Dropout, Luxarum. Arcanist. | Cinder Wand, Padded Armor, Healing Elixir |
| Brannoc Stoneroot | Thornling, Oaken, Shard God Devotee, Akon. Shield-bearer. | War Hammer, Kite Shield, Heavy Hides, Healing Elixir |
| Vex Duskwhisper | Kiska, Tayan, Shadow Walker, Abyss. Scout. | Shortbow, Hand Crossbow, Dagger, Studded Leather Armor, Healing Elixir |

`pfm-ember` also has a Trusted Player user `paul` who owns all four heroes. Paul has the password. Join as `paul` in one browser and as Gamemaster in another to test what players see.

The server starts the world named in `FOUNDRY_WORLD` in `compose.yaml` (`pfm-test`). To play `pfm-ember`, join `pfm-test` as Gamemaster, use Return to Setup in the Settings sidebar, and launch `pfm-ember`. The join page's own Return to Setup button needs an admin key, which this server does not have. Switch back before `npm run test:e2e`, or restart the container (`docker compose restart foundry`), which relaunches `pfm-test`.

## Daily loop

1. Edit files in `scripts/`, `styles/` or `lang/`. Docker bind-mounts them into the module folder, so press F5 in the browser to load the change. Restart the server only after a `module.json` change.
2. Run `npm run lint` and `npm test` while you work.
3. Open the Quench window (flask button in the sidebar) to run the in-world batches.
4. Before a push, run `npm run test:e2e` against the running server.

## Smoke test settings

| Variable | Default | Use |
|---|---|---|
| `FOUNDRY_URL` | `http://localhost:30100` | Server to test |
| `FOUNDRY_USER` | `Gamemaster` | User to join as |
| `FOUNDRY_USER_PASSWORD` | empty | That user's password in the test world, if it has one |

The smoke test joins the world, checks the server is v14 and the module is active, sends `/hello`, and runs the Quench batches. It skips the Quench step if Quench is not active.

## Known limits

- Quench 0.10.0 declares Foundry 13 as verified. On v14 (build 369) it works, with two quirks. It logs deprecation warnings for the globals `Game` and `FilePicker`, which v15 will remove. Its reporter also throws `Cannot read properties of undefined (reading 'querySelector')` and the run never ends if the Quench window is not open. The smoke test calls `quench.app.render(true)` before `runBatches` to avoid this.
- On v14 the module registers `/hello` in `ChatLog.CHAT_COMMANDS`. v14 rejects any slash command missing from that registry with "is not a valid chat message command". On v13 the module uses the `chatMessage` hook instead. The v14 chat box is a ProseMirror editor and sends HTML (`<p>/hello</p>`), so a test that calls `ui.chat.processMessage("/hello")` with a plain string does not exercise the real path. The smoke test types into `#chat-message` instead.
- Foundry allows one connection per user. If Gamemaster is logged in in your own browser, the smoke test cannot join and says so. Log out (or close the tab) before `npm run test:e2e`.
- Playwright runs at 1280x800, because Foundry needs at least 1024x768.
- Check your license terms before you run this server at the same time as your main game server.
- `felddy/foundryvtt:14` follows the newest v14 build. Pin an exact tag in `compose.yaml` when you need repeatable results.
