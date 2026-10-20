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

describe("single skill checks", () => {
  it("records a check a hero rolls from their own sheet", () => {
    const msg = { _id: "m1", timestamp: 1, speaker: { actor: "lyra" }, flags: { crucible: { skill: "arcana" } }, rolls: [{ total: 17, data: { actorId: "lyra", dc: 14, criticalSuccessThreshold: 6, criticalFailureThreshold: 6 } }] };
    const meta = { L: hero("L", { actorId: "lyra", name: "Lyra" }) };
    const recs = extractRecords([msg], { meta });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ kind: "check", actor: "L", skill: "arcana", total: 17, dc: 14, success: true });
    expect(aggregate(recs, meta).combatants.L.checksBySkill.arcana).toEqual({ checks: 1, successes: 1 });
  });
});

describe("Ember attunement awards", () => {
  it("records the type and points from Ember's award card, with the hero as speaker", () => {
    const content = `<section class="attunement-award"><table class="report-table attunement-award-table"><thead><tr><th colspan="2">Akon Attunement</th></tr></thead><tbody><tr><td class="report-label">Progress</td><td class="report-value boons"><i class="fa-solid fa-caret-up" inert></i> +1</td></tr></tbody></table></section>`;
    const msg = { _id: "a1", timestamp: 1, speaker: { actor: "vex" }, content, flags: { crucible: { isAwardSummary: true }, ember: { attunementAward: true } } };
    const meta = { V: hero("V", { actorId: "vex", name: "Vex" }) };
    const recs = extractRecords([msg], { meta });
    expect(recs).toMatchObject([{ kind: "attunement", actor: "V", attunement: "akon", amount: 1 }]);
    expect(aggregate(recs, meta).combatants.V.attunements.akon.points).toBe(1);
  });
});

describe("hazards", () => {
  // A Crucible hazard card: no actor, the speaker is "Environment", and the action carries the "hazard" tag.
  const card = { _id: "h1", timestamp: 1, speaker: { alias: "Environment", actor: null }, rolls: [{ total: 16, data: { dc: 13, result: 2 } }],
    flags: { crucible: { actor: null, action: { id: "environmentAttack", name: "Caustic Slime", tags: ["hazard", "reflex", "acid", "health"] },
      targets: [{ actor: "Actor.senna" }], events: [{ type: "activation", target: null, resources: [] },
        { type: "attack", rollIndex: 0, target: "Actor.senna", resources: [{ resource: "health", delta: -7, damageType: "acid" }] }] } } };
  const meta = { S: hero("S", { actorId: "senna", name: "Senna" }) };

  it("credits hazard damage to the named hazard, not to nobody", () => {
    const [rec] = extractRecords([card], { meta });
    expect(rec).toMatchObject({ kind: "action", actor: "hazard:caustic-slime", hazard: true, actionName: "Caustic Slime" });
    const s = aggregate([rec], meta);
    expect(s.hazards.map((h) => [h.name, h.side, h.attacks])).toEqual([["Caustic Slime", "hazard", 1]]);
    expect(s.combatants.S.attacksReceived).toBe(1);
    expect(s.adversaries.members).toBe(0); // a hazard is not an adversary
    expect(s.timeline.at(-1).text).toMatch(/^Caustic Slime Caustic Slime → Senna/);
  });

  it("counts conditions picked up outside combat", () => {
    const s = aggregate([{ kind: "condition", actor: "S", status: "blinded", on: true, round: null }, { kind: "check", actor: "S", skill: "medicine", total: 7, dc: 15, success: false }], meta);
    expect(s.combatants.S.conditions).toEqual({ blinded: 1 });
  });
});

describe("kill log order", () => {
  it("lists kills by the round they happened, not by who was hit first", () => {
    const hit = (actor, target, round, health) => ({ kind: "action", actor, round, actionId: "strike", tags: [], spent: {}, restored: {}, effects: [], heals: [], attacks: [{ target, total: 15, dc: 10, result: "hit", health, wounds: 0, morale: 0 }] });
    const meta = { H: hero("H"), X: foe("X", { dead: true }), Y: foe("Y", { dead: true }) };
    const s = aggregate([hit("H", "X", 1, 5), hit("H", "Y", 2, 9), hit("H", "X", 3, 9)], meta);
    expect(s.kills.map((k) => [k.targetName, k.round])).toEqual([["Y", 2], ["X", 3]]);
  });
});

describe("healing yourself", () => {
  const elixir = (actor, target) => ({ kind: "action", actor, round: 3, actionId: "healingElixir", tags: ["consume", "healing"], spent: { action: 2 }, restored: {}, attacks: [], heals: [], effects: [{ target, type: "other", health: 12 }] });
  const touch = (actor, target) => ({ kind: "action", actor, round: 3, actionId: "spell.life.touch", tags: ["spell"], spent: { action: 2, focus: 1 }, restored: {}, attacks: [], effects: [], heals: [{ target, health: 14, morale: 0 }] });
  const meta = { K: hero("K"), C: hero("C"), F: hero("F"), T: hero("T") };

  it("counts a potion drunk on yourself as healing received, not healing done", () => {
    const s = aggregate([elixir("K", "K"), elixir("C", "F")], meta).combatants;
    expect([s.K.healingDone, s.K.healingReceived]).toEqual([0, 12]);
    expect([s.C.healingDone, s.F.healingReceived]).toEqual([12, 12]);
  });

  it("counts a healing spell on yourself as received, but still as a successful cast", () => {
    const s = aggregate([touch("T", "T"), touch("T", "F")], meta).combatants;
    expect([s.T.healingDone, s.T.healingReceived, s.T.healCasts, s.T.healSuccesses]).toEqual([14, 14, 2, 2]);
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

describe("fled adversaries", () => {
  it("count as out: a fight is a victory when every major foe is dead or fled", () => {
    const meta = { A: hero("A"), X: foe("X", { rank: "elite", fled: true }), Y: foe("Y", { rank: "boss", dead: true }), m: foe("m", { rank: "minion" }) };
    expect(fightOutcome(meta)).toEqual({ result: "victory", reason: "every major adversary is down or fled", by: "auto" });
  });

  it("keep the plain reason when nothing fled", () => {
    expect(fightOutcome({ A: hero("A"), X: foe("X", { rank: "elite", dead: true }) }).reason).toBe("every major adversary is down");
  });

  it("leave the fight undecided while another major foe still stands", () => {
    const meta = { A: hero("A"), X: foe("X", { rank: "elite", fled: true }), Y: foe("Y", { rank: "elite" }) };
    expect(fightOutcome(meta).result).toBe("undecided");
  });

  it("read as fled, with the health they left on, in the fate line", () => {
    const meta = { A: hero("A"), S: foe("S", { name: "Suarrok Juvenile", rank: "elite", fled: true, state: { health: { value: 16, max: 93 } } }) };
    const stats = aggregate([{ kind: "initiative", actor: "S", total: 20, position: 1, of: 2, round: 1 }], meta);
    const s = stats.combatants.S;
    expect(s.fled).toBe(true);
    expect(s.out).toBe(true);
    expect(fateLine(s, stats)).toBe("Fled at 16 of 93 health");
    expect(stats.outcome.result).toBe("victory");
  });
});
