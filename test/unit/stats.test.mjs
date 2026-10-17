import { beforeAll, describe, expect, it } from "vitest";
import { aggregate, checkOutcome, diceFaces, dieLuck, estimateMoves, extractRecords, actorKey, fightFromExport } from "../../scripts/lib/stats.mjs";
import { contextFromFixture, loadFixture } from "./fixture-context.mjs";

describe("checkOutcome (Crucible rules)", () => {
  it("needs a total above the DC to succeed", () => {
    expect(checkOutcome(15, 15).success).toBe(false);
    expect(checkOutcome(16, 15).success).toBe(true);
  });

  it("is a critical success above DC + 6 and a critical failure at DC - 6 or below", () => {
    expect(checkOutcome(21, 15).critSuccess).toBe(false);
    expect(checkOutcome(22, 15).critSuccess).toBe(true);
    expect(checkOutcome(9, 15).critFailure).toBe(true);
    expect(checkOutcome(10, 15).critFailure).toBe(false);
  });

  it("uses custom thresholds when the roll sets them", () => {
    expect(checkOutcome(19, 15, { critSuccess: 3 }).critSuccess).toBe(true);
  });

  it("has no outcome without a DC", () => {
    expect(checkOutcome(12, null)).toEqual({ success: null, critSuccess: false, critFailure: false });
  });
});

describe("helpers", () => {
  it("reads each die's size and result from a serialized roll", () => {
    // A boon steps a d8 up to a d10. A bane steps one down to a d6.
    const roll = { terms: [{ class: "Die", faces: 10, results: [{ result: 7, active: true }] }, { class: "OperatorTerm" }, { class: "Die", faces: 6, results: [{ result: 1, active: true }] }, { class: "NumericTerm", number: 2 }] };
    expect(diceFaces(roll)).toEqual([[10, 7], [6, 1]]);
    expect(diceFaces(JSON.stringify(roll))).toEqual([[10, 7], [6, 1]]);
  });

  it("scores luck against the die's own size", () => {
    expect(dieLuck(4, 4)).toBe(1);
    expect(dieLuck(12, 1)).toBe(0);
    expect(dieLuck(8, 4.5)).toBe(0.5);
    expect(dieLuck(12, 4)).toBeLessThan(dieLuck(4, 3)); // a 4 on a d12 is worse than a 3 on a d4
  });

  it("keys unlinked token actors by token id and linked actors through the metadata", () => {
    const meta = { T1: { key: "T1", actorId: "A1", linked: true } };
    expect(actorKey("Scene.S.Token.T9.Actor.A9", meta)).toBe("T9");
    expect(actorKey("Actor.A1", meta)).toBe("T1");
    expect(actorKey("Actor.ZZ", meta)).toBe("actor:ZZ");
  });
});

describe("Day One: The Feral Scramble (fixture)", () => {
  let ctx, records, stats;
  const byName = (name) => Object.values(stats.combatants).find((s) => s.name === name && s.side === "hero");

  beforeAll(() => {
    const d = loadFixture("day1-ring-of-valor.json");
    ctx = contextFromFixture(d);
    records = estimateMoves(extractRecords(d.messages, ctx), ctx.grid, ctx.finalPositions);
    stats = aggregate(records, ctx.meta);
  });

  it("extracts initiative for 12 combatants over 3 rounds, 46 actions and 5 checks", () => {
    const count = (k) => records.filter((r) => r.kind === k).length;
    expect(count("initiative")).toBe(36);
    expect(count("action")).toBe(46);
    expect(count("check")).toBe(5);
  });

  it("places combat actions in rounds 1 to 3 and leaves post-fight Recover out of combat", () => {
    const actions = records.filter((r) => r.kind === "action");
    const recovers = actions.filter((r) => r.actionId === "recover");
    expect(recovers).toHaveLength(4);
    expect(recovers.every((r) => r.round === null)).toBe(true);
    expect(actions.filter((r) => r.actionId !== "recover").every((r) => [1, 2, 3].includes(r.round))).toBe(true);
    expect(stats.summary.rounds).toBe(3);
  });

  it("credits all 8 kills to heroes, with no hero deaths", () => {
    expect(stats.kills).toHaveLength(8);
    expect(stats.summary.heroKills).toBe(8);
    expect(stats.summary.heroDeaths).toBe(0);
    expect(byName("Duurath").kills).toBe(3);
    expect(byName("Eliorwen").kills).toBe(3);
    expect(byName("Agnath").kills).toBe(2);
    expect(byName("Kagura").kills).toBe(0);
  });

  it("marks a final blow as stolen when someone else did more of the damage", () => {
    const firstBaizaz = stats.kills.find((k) => k.round === 1 && k.targetName === "Baizaz");
    expect(firstBaizaz.kind).toBe("stolen");
    expect(stats.combatants[firstBaizaz.by].name).toBe("Agnath");
    expect(stats.combatants[firstBaizaz.topDamage].name).toBe("Kagura");
    expect(byName("Kagura").assists).toBe(2);
  });

  it("calls out the major adversary separately, with wounds and its kill attribution", () => {
    expect(stats.majorAdversaries).toHaveLength(1);
    expect(stats.majorAdversaries[0].name).toBe("Huiana");
    expect(stats.majorAdversaries[0].woundsTaken).toBe(9);
    const kill = stats.kills.find((k) => k.important);
    expect(stats.combatants[kill.by].name).toBe("Duurath");
    expect(kill.kind).toBe("stolen");
    expect(stats.adversaries.members).toBe(7); // the minions, rolled up
  });

  it("counts glances as landed hits", () => {
    const adv = stats.adversaries;
    expect(adv.glances).toBe(3);
    expect(adv.hits).toBe(1);
    expect(adv.damageDealt).toBe(21);
    expect(byName("Agnath").damageTaken).toBe(21);
    expect(adv.avoidedBy.armor).toBeUndefined(); // the two armour misses came from the major Huiana
    expect(stats.majorAdversaries[0].avoidedBy.armor).toBe(2);
  });

  it("records the group Medicine check: every hero failed, two critically", () => {
    const medicine = records.filter((r) => r.kind === "check" && r.skill === "medicine");
    expect(medicine).toHaveLength(4);
    expect(medicine.every((r) => r.success === false)).toBe(true);
    expect(medicine.filter((r) => r.critFailure).map((r) => ctx.meta[r.actor].name).sort()).toEqual(["Eliorwen", "Kagura"]);
  });

  it("keeps boon and bane dice at their own size", () => {
    const sizes = (s) => Object.keys(s.dice.sizes).map(Number).sort((a, b) => a - b);
    const all = new Set(Object.values(stats.combatants).flatMap(sizes));
    expect([...all].sort((a, b) => a - b)).toEqual([4, 6, 8, 10, 12]);
    for (const s of Object.values(stats.combatants)) {
      for (const [size, b] of Object.entries(s.dice.sizes)) expect(Math.max(...Object.keys(b.faces).map(Number))).toBeLessThanOrEqual(Number(size));
    }
    const party = stats.party;
    expect(party.boons).toBeGreaterThan(0);
    expect(party.rollsWithBoons).toBeGreaterThan(0);
    expect(party.luck).toBeGreaterThan(0);
    expect(party.luck).toBeLessThan(1);
  });

  it("tracks Focus spent and buffs from Inspire Heroism", () => {
    expect(byName("Duurath").focusSpent).toBe(1);
    expect(byName("Duurath").buffs).toBeGreaterThanOrEqual(1);
  });

  it("averages initiative and turn position per round", () => {
    const d = byName("Duurath");
    expect(d.initiativeRolls).toBe(3);
    expect(d.avgPosition).toBeGreaterThanOrEqual(1);
    expect(d.avgPosition).toBeLessThanOrEqual(12);
  });

  it("estimates move distances and flags them as estimates", () => {
    expect(byName("Duurath").feetMoved).toBeGreaterThan(0);
    expect(byName("Duurath").feetEstimated).toBe(true);
    expect(byName("Eliorwen").feetMoved).toBe(0);
  });

  it("builds a play-by-play timeline with kill lines", () => {
    expect(stats.timeline.length).toBeGreaterThan(30);
    expect(stats.timeline.filter((l) => l.kill)).toHaveLength(8);
  });
});

describe("fightFromExport", () => {
  it("builds a stored fight with metadata, records and the Heroism lost when combat ended", () => {
    const fight = fightFromExport(loadFixture("day1-ring-of-valor.json"), { name: "Day One" });
    expect(fight.name).toBe("Day One");
    expect(Object.keys(fight.meta)).toHaveLength(12);
    expect(fight.records.filter((r) => r.kind === "heroism" && r.reason === "combatEnd")).toHaveLength(4);
    const stats = aggregate(fight.records, fight.meta);
    expect(stats.party.heroismLostAtEnd).toBe(4);
    expect(stats.kills).toHaveLength(8);
  });

  it("still reads older records that stored bare d8 results", () => {
    const meta = { H: { key: "H", name: "Hero", type: "hero" } };
    const s = aggregate([{ kind: "initiative", actor: "H", total: 10, dice: [8, 1, 4], position: 1, round: 1 }], meta).combatants.H;
    expect(s.dice.sizes[8].count).toBe(3);
    expect(s.ones).toBe(1);
    expect(s.dice.maxes).toBe(1);
  });
});

describe("progression records", () => {
  it("counts milestones, level-ups and Ember attunement points and ranks", () => {
    const meta = { H: { key: "H", name: "Hero", type: "hero" } };
    const records = [
      { kind: "milestone", actor: "H", amount: 2, round: null },
      { kind: "levelUp", actor: "H", amount: 1, level: 2, round: null },
      { kind: "attunement", actor: "H", amount: 3, attunement: "ragen", rank: 1, ranksGained: 1, round: null },
      { kind: "attunement", actor: "H", amount: 1, attunement: "ragen", rank: 1, ranksGained: 0, round: null }
    ];
    const s = aggregate(records, meta).combatants.H;
    expect(s.milestones).toBe(2);
    expect(s.levelsGained).toBe(1);
    expect(s.level).toBe(2);
    expect(s.attunementPoints).toBe(4);
    expect(s.attunementRanks).toBe(1);
    expect(s.attunements.ragen).toEqual({ points: 4, rank: 1 });
  });
});
