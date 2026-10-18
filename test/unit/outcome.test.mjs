import { describe, expect, it } from "vitest";
import { aggregate, extractRecords, fightOutcome, isMajor } from "../../scripts/lib/stats.mjs";
import { fateLine, fightReport } from "../../scripts/lib/stats-view.mjs";
import { contextFromFixture, loadFixture } from "./fixture-context.mjs";

const hero = (key, extra = {}) => ({ key, name: key, type: "hero", ...extra });
const foe = (key, extra = {}) => ({ key, name: key, type: "adversary", ...extra });

describe("major adversaries", () => {
  it("counts important, boss and elite as major, and minions as not", () => {
    expect(isMajor({ important: true })).toBe(true);
    expect(isMajor({ rank: "boss" })).toBe(true);
    expect(isMajor({ rank: "elite" })).toBe(true);
    expect(isMajor({ rank: "minion" })).toBe(false);
    expect(isMajor({})).toBe(false);
  });

  it("lists an elite apart from the rolled-up adversaries", () => {
    const meta = { H: hero("H"), E: foe("E", { rank: "elite" }), M: foe("M", { rank: "minion" }) };
    const records = [{ kind: "initiative", actor: "E", total: 10, position: 1, of: 3, round: 1 }, { kind: "initiative", actor: "M", total: 8, position: 2, of: 3, round: 1 }];
    const s = aggregate(records, meta);
    expect(s.majorAdversaries.map((x) => x.name)).toEqual(["E"]);
    expect(s.adversaries.members).toBe(1);
  });
});

describe("fight result", () => {
  it("is a defeat when every hero is dead or insane", () => {
    const meta = { A: hero("A", { dead: true }), B: hero("B", { statuses: ["insane"] }), X: foe("X", { rank: "elite" }) };
    expect(fightOutcome(meta).result).toBe("defeat");
  });

  it("is a victory when every major adversary is down, even with minions left", () => {
    const meta = { A: hero("A"), X: foe("X", { rank: "boss", dead: true }), m: foe("m", { rank: "minion" }) };
    expect(fightOutcome(meta).result).toBe("victory");
  });

  it("is a victory when every adversary is down and none is major", () => {
    expect(fightOutcome({ A: hero("A"), m: foe("m", { dead: true }) }).result).toBe("victory");
  });

  it("is undecided when both sides still stand, and a GM ruling wins over all of it", () => {
    const meta = { A: hero("A"), X: foe("X", { rank: "elite" }) };
    expect(fightOutcome(meta).result).toBe("undecided");
    expect(fightOutcome(meta, { result: "defeat", note: "Duurath went insane" })).toEqual({ result: "defeat", reason: "Duurath went insane", by: "gm" });
  });

  it("calls Day One a victory: the major Huiana and every beast are dead", () => {
    const d = loadFixture("day1-ring-of-valor.json");
    const ctx = contextFromFixture(d);
    expect(aggregate(extractRecords(d.messages, ctx), ctx.meta).outcome.result).toBe("victory");
  });
});

describe("conditions, fates and the Roll of Valour page", () => {
  const meta = {
    D: hero("D", { statuses: ["insane"], state: { health: { value: 0, max: 40 }, wounds: { value: 51, max: 60 } } }),
    K: hero("K", { dead: true }),
    V: foe("V", { important: true, rank: "elite", state: { health: { value: 0, max: 105 }, wounds: { value: 63, max: 105 } } })
  };
  const records = [
    { id: "a1", kind: "action", actor: "V", round: 3, actionId: "heavyStrike", actionName: "Heavy Strike", tags: [], spent: {}, restored: {}, effects: [], heals: [], attacks: [{ target: "K", result: "hit", total: 20, dc: 15, critSuccess: false, critFailure: false, health: 30, morale: 0, wounds: 0 }] },
    { id: "c1", kind: "condition", actor: "D", status: "broken", on: true, round: 4 },
    { id: "c2", kind: "condition", actor: "D", status: "insane", on: true, round: 6 },
    { id: "c3", kind: "condition", actor: "D", status: "broken", on: false, round: 7 },
    { id: "n1", kind: "note", actor: "D", text: "Cured by Fizzit's Soul rite", round: null }
  ];
  const stats = aggregate(records, meta);

  it("counts conditions as they start, and lists them in the play-by-play", () => {
    expect(stats.combatants.D.conditions).toEqual({ broken: 1, insane: 1 });
    expect(stats.timeline.filter((l) => l.condition).map((l) => l.text)).toEqual(["D is broken", "D is insane"]);
  });

  it("words each fate from the kill log, conditions, final state and result", () => {
    expect(stats.outcome.result).toBe("defeat");
    expect(fateLine(stats.combatants.K, stats)).toBe("Defeated by V in round 3");
    expect(fateLine(stats.combatants.D, stats)).toBe("Insane with 51 of 60 wounds");
    expect(fateLine(stats.combatants.V, stats)).toBe("Victorious: fought on at 0 health with 63 of 105 wounds, 1 kill");
  });

  it("writes a page with the result, the major adversary, conditions and notes", () => {
    const html = fightReport(stats, { name: "Day Two", scene: "Arena", started: 0 });
    expect(html).toContain("<h3>Result: Defeat</h3>");
    expect(html).toContain("<strong>V</strong> (elite): Victorious");
    expect(html).toContain("D is insane");
    expect(html).toContain("Cured by Fizzit&#39;s Soul rite");
  });
});

describe("heroes who were not in the fight", () => {
  it("leaves out a hero recorded only for a milestone, from the heroes and the result", () => {
    const meta = { A: hero("A", { combatantId: "c1", dead: true }), Z: hero("Z"), X: foe("X", { combatantId: "c2", rank: "elite" }) };
    const records = [{ kind: "initiative", actor: "A", total: 9, position: 1, of: 2, round: 1 }, { kind: "milestone", actor: "Z", amount: 1, round: null }];
    const s = aggregate(records, meta);
    expect(s.heroes.map((h) => h.name)).toEqual(["A"]);
    expect(s.outcome.result).toBe("defeat");
  });
});
