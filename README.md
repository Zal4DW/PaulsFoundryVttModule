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

Both items show up in Crucible Shop's default shop and in character creation's Equipment step without any setup: the module adds "Paul's Items" to Crucible's equipment packs when the world loads. It does not change Crucible's own Compendium Sources setting. To keep the items out, turn off the module's "Paul's Items in shops and character creation" setting. That only stops the module adding the pack: if a GM lists "Paul's Items" in Crucible's own Compendium Sources, Crucible's setting wins. For a custom shop, drag an item in from the compendium.

## Crucible: Dose of It'll Be Alright...

A back-alley tonic in "Paul's Items" that clears Madness and leaves an addiction. Like the Wound kit, a hero takes it straight after their Rest, one per Rest. It heals first, at the hero's current addiction level, and then adds its own addiction.

| Quality | Madness cleared | Addiction added | Price |
|---|---|---|---|
| Shoddy | 1 | +1 | 1.5 gp |
| Standard | 5 | +2 | 3 gp |
| Fine | 10 | +3 | 24 gp |
| Superior | 20 | +4 | 81 gp |
| Masterwork | 40 | +5 | 375 gp |

Each addiction level takes a flat amount off a dose, more at each level: 1, 3, 6, 10, 15, 21, 28, 36 Madness at levels 1 to 8. Cheap doses stop working quickly, and stronger ones still get through. A Rest lowers addiction by 1, but only if the hero took no dose since their last Rest. The hero's sheet shows the level as an "Addicted (N)" effect. Withdrawal: an addicted hero who Rests without a dose wakes with "The Shakes", 1 bane on attacks, spells and checks for 4 hours of game time. Any dose ends The Shakes at once. GM notes with the full tolerance table are in each item's Secret Description, which only GMs see. Macros can read or set a hero's addiction with `game.modules.get("pauls-foundry-module").api.getAddiction(actor)` and `.setAddiction(actor, level)`. An Insane hero cannot Rest, so they may take a dose at any time out of combat, and it is the only thing that brings them back. That dose leaves a "Fragile Calm": their next Rest restores no Madness, so the cure buys no free recovery. If Madness fills up before that Rest, the calm shatters: the hero is Insane once more and their addiction rises by 1.

## Crucible: confirm my own movement

Crucible's "auto-confirm self actions" setting has the GM's client confirm every Move card at once. That suits the GM, but a player still learning token edges and waypoints makes mistakes that the GM then has to undo. Each player can turn on "Confirm my own movement" in their module settings:

- Their Move cards wait for them. The token moves, but no AP is spent until the card is confirmed.
- Ctrl+Z takes a pending move back for free.
- A "Confirm move" button on their own card confirms it. The GM does not have to.
- Their next action confirms a pending move first. A second drag while a move is pending confirms it and asks them to drag again, because Crucible checks a move's AP before the earlier move has spent any. When their turn ends, the GM's client confirms anything still pending.

The GM's own auto-confirm setting is unchanged, and players who leave it off see no difference.

## Crucible: Item Piles setup

[Item Piles](https://github.com/fantasycalendar/FoundryVTT-ItemPiles) makes tokens into loot piles and containers, but it has no settings for Crucible: it warns "System Not Recognized" and doesn't know where Crucible keeps quantity, price or coin. When Item Piles is active, this module registers a Crucible setup with it:

- Quantity is `system.quantity` and price is `system.price`.
- Coin is one Copper currency on `system.currency`. Crucible stores all coin as copper (10 cp = 1 sp, 100 cp = 1 gp, 1000 cp = 1 pp), and Item Piles can't split one number into several coins.
- Ancestry, archetype, background, spell, talent and taxonomy items never show as loot.
- New piles are adversary actors.

Item Piles 3.3.4 shows its GM-only "Config Update" button in the loot window to players too, and a player's click fails with a permission error. The module hides that button on player clients.

Item Piles keeps a GM's own edits to these settings, and applies this setup again only when a module update raises its version. Turn off "Set up Item Piles for Crucible" to configure Item Piles by hand.

## Development

A Docker Foundry v14 server, ESLint, Vitest, Quench and a Playwright smoke test are set up. See [docs/testing.md](docs/testing.md).

Compendium content lives as JSON in `packs/_source/<pack>/`, one file per document. `npm run build:packs` compiles it into the LevelDB folders under `packs/`, which are gitignored. Return to Setup before a rebuild, because Foundry locks a pack while a world uses it. For a release, `npm run release:zip -- v<version>` builds the packs and writes `module.zip`: the tracked module files at that tag plus the built pack files, which a plain `git archive` would leave out.
