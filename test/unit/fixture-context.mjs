// Load exported fight fixtures for the stats tests.
import { readFileSync } from "node:fs";
import { fightFromExport } from "../../scripts/lib/stats.mjs";

export function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

/** The context the stats engine needs, built the same way the in-game import does. */
export function contextFromFixture(d) {
  const fight = fightFromExport(d);
  return { meta: fight.meta, rounds: Object.fromEntries(fight.records.filter((r) => r.round).map((r) => [r.id, { round: r.round, turn: r.turn }])), grid: fight.grid, finalPositions: d.finalPositions ?? {}, fight };
}
