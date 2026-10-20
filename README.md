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

## Crucible: Reveal light

Crucible lights a token for a Torch, a Lantern or a Luminous gem, but Reveal's "tosslight" lights nothing. With this module, when the GM confirms a Reveal card, the target's token gets the tosslight: bright light to 20 ft and dim to 40 ft. With no target it goes on the caster. Each caster has one tosslight, so casting Reveal again moves it. A token that already gives off light keeps its own. To put the light out, open the token HUD and click the lightbulb, and the token's earlier light comes back. Reveal has other uses, such as invisible writing. Turn off the "Reveal makes light" setting if your table would rather place light by hand.

## Crucible: Wound Medical Kit

Crucible's Rest removes only level-many Wounds, so a level 1 hero gets back 1 Wound a night. The "Paul's Items" compendium has a Wound Medical Kit to close that gap. A hero uses it straight after their Rest, on themselves or an adjacent ally, and it is used up. Crucible's "After Rest" requirement means each hero can use one kit per Rest, and none in combat.

| Quality | Wounds recovered | Price |
|---|---|---|
| Shoddy | 3 | 1.5 gp |
| Standard | 5 | 3 gp |
| Fine | 10 | 24 gp |
| Superior | 20 | 81 gp |
| Masterwork | 40 | 375 gp |

Standard matches the cleric Briannon in Ember's Glinthome, who heals 5 Wounds for 1 gp, so a kit costs more than the temple but works in the field. Crucible scales the price by quality from the 3 gp base.

To sell the kit in Crucible Shop's default shop, open Crucible's system settings, choose Compendium Sources, and add "Paul's Items" under Equipment. Crucible Shop stocks its default shop from that list, and character creation's Equipment step uses it too. For a custom shop, drag the kit in from the compendium.

## Crucible: Dose of It'll Be Alright...

A back-alley tonic in "Paul's Items" that clears Madness and leaves an addiction. Like the Wound kit, a hero takes it straight after their Rest, one per Rest. It heals first, at the hero's current addiction level, and then adds its own addiction.

| Quality | Madness cleared | Addiction added | Price |
|---|---|---|---|
| Shoddy | 1 | +1 | 1.5 gp |
| Standard | 5 | +2 | 3 gp |
| Fine | 10 | +3 | 24 gp |
| Superior | 20 | +4 | 81 gp |
| Masterwork | 40 | +5 | 375 gp |

Each addiction level takes a flat amount off a dose, more at each level: 1, 3, 6, 10, 15, 21, 28, 36 Madness at levels 1 to 8. Cheap doses stop working quickly, and stronger ones still get through. A Rest lowers addiction by 1, but only if the hero took no dose since their last Rest. The hero's sheet shows the level as an "Addicted (N)" effect. An Insane hero cannot Rest, so they may take a dose at any time out of combat, and it is the only thing that brings them back. That dose leaves a "Fragile Calm": their next Rest restores no Madness, so the cure buys no free recovery.

## Development

A Docker Foundry v14 server, ESLint, Vitest, Quench and a Playwright smoke test are set up. See [docs/testing.md](docs/testing.md).

Compendium content lives as JSON in `packs/_source/<pack>/`, one file per document. `npm run build:packs` compiles it into the LevelDB folders under `packs/`, which are gitignored. Return to Setup before a rebuild, because Foundry locks a pack while a world uses it. A release zip must include the built `packs/` folders and `assets/`.
