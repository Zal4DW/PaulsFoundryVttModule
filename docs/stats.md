# Fight stats

The module records play-by-play stats from Crucible chat cards and shows them on a dashboard that every user can open.

Open it with `/stats` in chat, or from a macro with `game.modules.get("pauls-foundry-module").api.openStats()`.

## How recording works

- Recording runs on the active GM's client only, so each event is stored once. If no GM is logged in, nothing is recorded.
- Records go into one world setting, `pauls-foundry-module.statsLog`. Every user can read it. Only a GM can write it.
- Each started combat is one fight, keyed by the combat id. Cards posted outside combat go into a `session-YYYY-MM-DD` fight.
- The recorder reads these cards and changes:
  - Crucible action cards: attacks, damage, wounds, healing, buffs, AP, Focus and Heroism spent, movement.
  - Group checks and requested skill checks.
  - The "Initiative - Round N" report, for initiative totals and turn order.
  - Actor updates: Heroism gained (Crucible awards it without a card), milestones, level-ups and Ember attunement points.
  - Combat deletion: Heroism each hero still held, because ending combat clears it.
- Move distance comes from the token's movement history, read when the move card is posted. Foundry clears that history at turn change, so the recorder must be running at the time. Imported fights estimate distance from move origins instead, and the dashboard marks those values with `*`.

## Views

- **Party.** Scoreboard, MVP, leaderboards, a stat table per hero with party and adversary totals, and the kill log.
- **My Hero.** One hero's stats with their rank in the party, misses by defence, skill checks, dice histogram and progression. A player sees their assigned character first.
- **Adversaries.** Ordinary adversaries rolled up into one row. Major adversaries (Crucible's "important" flag, the star on the sheet) get their own rows and their fate.
- **Play-by-Play.** Every action, check and kill, grouped by round.

## Definitions

| Stat | Meaning |
| --- | --- |
| Hit % | Hits and glances divided by attacks. A glance falls short of the defence but still deals reduced damage. |
| Crit | An attack total above DC + 6 (or the roll's own threshold). Fumble is DC - 6 or below. |
| Dmg | Health damage plus wounds dealt. |
| Kill | The final damaging blow on a target that ended dead or defeated. |
| Solo kill | Only the killer damaged the target. |
| Earned kill | The killer did the most damage to the target, tied or outright. |
| Stolen kill | Someone else did more damage, and the killer landed the last blow. |
| Assist | Damage on a target that someone else killed. |
| Avg pos | Average place in the round's initiative order. 1 is first. |
| Heroism | Gained / spent. The bracketed value was lost when combat ended. |

## MVP score

```
damage + morale damage + 3 × wounds
+ 10 × solo kills + 8 × earned kills + 4 × stolen kills
+ 3 × assists + healing + 3 × buffs
- 10 × deaths
```

The formula is in `mvpScore` in `scripts/lib/stats.mjs`.

## Importing a fight

A GM can add a fight from an export file, such as `test/fixtures/day1-ring-of-valor.json`:

```js
game.modules.get("pauls-foundry-module").api.importFight("path/to/export.json", { id: "day1", name: "Day One" });
```

The path is relative to Foundry's Data folder. Importing again with the same id replaces that fight.

## Code

- `scripts/lib/stats.mjs`: turns messages into records and records into stats. No Foundry globals, so Vitest tests it against the Day One fixture.
- `scripts/lib/stats-view.mjs`: formatting, leaderboards and ranks.
- `scripts/stats/recorder.mjs`: the GM-side hooks.
- `scripts/stats/store.mjs`: the world setting, with writes batched every 750 ms.
- `scripts/stats/dashboard.mjs`: the ApplicationV2 window.
