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
- **My Hero.** One hero's stats with their rank in the party, misses by defence, skill checks, roll totals and progression. A player sees their assigned character first.
- **Adversaries.** A grid of cards. Each major adversary (marked important, or ranked boss or elite) gets a card with its rank, fate, end-of-fight health and wounds bars, and eight stats. A red left edge means it was defeated; gold means it survived. Ordinary adversaries share one rolled-up card.
- **Kill log** (on the Party view). Kills in round order. "Killed" means only the killer damaged the target, "finished" means the killer did the most damage, and "stole the kill on" means someone else did more. ★ marks a major adversary. The bar under each kill shows everyone's share of the damage, with the finishing blow in orange. A legend under the heading repeats this.
- **Play-by-Play.** Every action, check and kill, grouped by round.

## To date

Pick "To date (all fights)" at the top of the fight list to see every recorded fight added up.

- Heroes merge by actor, so a hero keeps one row when their token or token name changes. Two actors with the same name (a pregenerated copy, say) get separate rows, told apart by token name, else by level or a number.
- The party table gains three columns. **Status** is the hero now: Dead or Insane from the actor, else Active if they are on the party sheet, else Benched. **Fights** counts the combats they took part in. **W–L** is fights won and lost, with undecided or withdrawn fights in brackets.
- Major adversaries merge by name across fights. Other adversaries are rolled up into one row.
- The kill log names the fight each kill came from.
- The Roll of Valour tab lists every fight with its date, result, rounds, MVP and heroes. Click a fight to open it.
- The out-of-combat bucket for a session (checks rolled outside combat) counts toward a hero's totals but not as a fight.
- Play-by-Play is hidden here. Open a single fight for it.

The engine is `aggregateToDate` in `scripts/lib/stats.mjs`.

## Definitions

| Stat | Meaning |
| --- | --- |
| Hit % | Hits and glances divided by attacks. A glance falls short of the defence but still deals reduced damage. |
| Crit | An attack total above DC + 6 (or the roll's own threshold). Fumble is DC - 6 or below. |
| Dmg | Health damage plus wounds dealt. |
| Dmg/hit | Average damage over the attacks that dealt damage, with the lowest and highest. Misses are left out. |
| Kill | The final damaging blow on a target that ended dead or defeated. |
| Solo kill | Only the killer damaged the target. |
| Earned kill | The killer did the most damage to the target, tied or outright. |
| Stolen kill | Someone else did more damage, and the killer landed the last blow. |
| Assist | Damage on a target that someone else killed. |
| Heal | Health and morale restored to allies. Healing yourself, such as drinking your own potion, counts as healing received, not healing done. A heal spell cast on yourself still counts as a cast. |
| Avg pos | Average place in the round's initiative order. 1 is first. |
| Heroism | Gained / spent. The bracketed value was lost when combat ended. |
| Rolls | Totals in two groups, kept apart: combat (attack rolls) and skill checks. Each group has average, lowest, highest, successes, failures, critical successes and critical failures. Die faces are not tracked. A roll with no DC counts toward the average but not toward successes or failures. |
| Avg pos | Defeated combatants are left out, so position is counted among those still standing. |

## Names

Heroes show their own name. If a hero's token has a different name (for example Ignis with a token named "Anne"), the dashboard shows the token name as a tooltip. Adversaries show their token name, so two oozes can be told apart.

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

## Results, majors and the Roll of Valour

- **Keys.** K opens the stats window. L opens it on the Roll of Valour tab. Both can be rebound in Configure Controls.
- **Major adversaries** are those marked important, or ranked boss or elite. They are listed on their own; the rest are rolled up.
- **Fight result.** When combat ends, the result is worked out from who is left: Defeat when every hero is dead or insane, Victory when every major adversary (or, with none, every adversary) is down, otherwise Undecided. A GM can set it instead with `api.setFightOutcome(fightId, "victory" | "defeat" | "withdrawn", note)`.
- **End state.** Each combatant's health, wounds, morale, madness and conditions are kept from the end of the fight, so fates read in full: "Victorious: fought on at 0 health with 63 of 105 wounds, 3 kills".
- **Conditions.** Broken, insane, dead, weakened, frightened and similar conditions are logged as they start, with the round.
- **Notes.** `api.addFightNote(fightId, actorName, text)` records what the cards do not show, such as a ritual or a ruling.
- **Roll of Valour.** When combat ends, a page for the fight is written to the "Roll of Valour" journal, which players can read. Rename it with the Fight Journal Name setting. `api.writeFightJournal(fightId)` rewrites a page.
- **Rebuilding.** `api.rebuildFight(fightId)` re-extracts a fight's records from its chat cards after the stats engine changes.
