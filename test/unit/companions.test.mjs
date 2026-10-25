import { describe, expect, it } from "vitest";
import { aggregate, aggregateToDate, fightOutcome, isAlly, mergeMeta, sideOf } from "../../scripts/lib/stats.mjs";

const hero = (key, extra = {}) => ({ key, name: key, type: "hero", combatantId: `c${key}`, ...extra });
const foe = (key, extra = {}) => ({ key, name: key, type: "adversary", combatantId: `c${key}`, ...extra });
const ally = (key, extra = {}) => foe(key, { ally: true, ...extra });
const hit = (actor, target, round, health) => ({ kind: "action", actor, round, actionId: "strike", tags: [], spent: {}, restored: {}, effects: [], heals: [], attacks: [{ target, total: 15, dc: 10, result: "hit", health, wounds: 0, morale: 0 }] });

describe("companions and summons", () => {
  it("counts a non-hero as an ally when it is in the party, has a Friendly token, or is flagged as a companion", () => {
    expect(isAlly({ type: "adversary", partyMember: true })).toBe(true); // Tide, or an Ember companion
    expect(isAlly({ type: "adversary", friendly: true })).toBe(true); // a hero's summon takes the hero's disposition
    expect(isAlly({ type: "adversary", companion: true })).toBe(true);
    expect(isAlly({ type: "adversary" })).toBe(false);
    expect(isAlly({ type: "hero", partyMember: true })).toBe(false); // heroes are heroes
    expect(isAlly({ type: null, friendly: true })).toBe(false);
  });

  it("puts each key on one side", () => {
    expect(sideOf("T", ally("T"))).toBe("ally");
    expect(sideOf("X", foe("X"))).toBe("adversary");
    expect(sideOf("H", hero("H"))).toBe("hero");
    expect(sideOf("hazard:rockfall", undefined)).toBe("hazard");
    expect(sideOf("?", {})).toBe("unknown");
  });

  it("never lets a companion decide the result", () => {
    // The only foe is down; Tide still standing must not make it undecided, and Tide down must not make it a win.
    expect(fightOutcome({ H: hero("H"), T: ally("T"), X: foe("X", { dead: true }) }).result).toBe("victory");
    expect(fightOutcome({ H: hero("H"), T: ally("T", { dead: true }), X: foe("X") }).result).toBe("undecided");
  });

  it("lists companions apart, counts their kills for the party, and keeps them out of the party total and MVP", () => {
    const meta = { H: hero("H"), T: ally("T", { name: "Tide" }), X: foe("X", { dead: true }), Y: foe("Y", { dead: true }) };
    const s = aggregate([hit("H", "X", 1, 9), hit("T", "Y", 1, 30)], meta);
    expect(s.heroes.map((r) => r.key)).toEqual(["H"]);
    expect(s.allies.map((r) => [r.name, r.side, r.kills])).toEqual([["Tide", "ally", 1]]);
    expect(s.adversaries.members).toBe(2); // X and Y, not Tide
    expect(s.summary.heroKills).toBe(2);
    expect(s.summary.adversaryKills).toBe(0);
    expect(s.party.damageDealt).toBe(9); // heroes only
    expect(s.summary.mvp).toBe("H");
  });

  it("counts a companion killed by an adversary as an adversary kill", () => {
    const meta = { H: hero("H"), T: ally("T", { dead: true }), X: foe("X") };
    const s = aggregate([hit("X", "T", 2, 10)], meta);
    expect([s.summary.heroKills, s.summary.adversaryKills]).toEqual([0, 1]);
  });

  it("merges a companion across fights by actor", () => {
    const fight = (id, started) => ({ id, started, name: id, meta: { H: hero("H", { actorId: "h" }), T: ally("T", { name: "Tide", actorId: "tide" }), X: foe("X", { dead: true }) }, records: [hit("T", "X", 1, 10)] });
    const s = aggregateToDate([fight("f1", 1), fight("f2", 2)]);
    expect(s.allies.map((r) => [r.key, r.name, r.fights, r.kills])).toEqual([["ally:tide", "Tide", 2, 2]]);
    expect(s.summary.heroKills).toBe(2);
  });
});

describe("mergeMeta", () => {
  const sprite = { key: "S", name: "Earth Sprite", type: "adversary", ally: true, actorId: "a1", combatantId: "cS", dead: false, fled: false };
  const gone = { key: "S", name: "S", type: null, ally: false, actorId: null, combatantId: "cS", dead: false, fled: false };

  it("keeps a summon's name when its token is deleted but its combatant stays", () => {
    expect(mergeMeta(sprite, gone)).toEqual(sprite);
  });

  it("takes the live combatant id when a deleted token's combatant is still in the tracker", () => {
    expect(mergeMeta({ ...sprite, combatantId: "old" }, gone).combatantId).toBe("cS");
    expect(mergeMeta(sprite, { ...gone, combatantId: null }).combatantId).toBe("cS");
  });

  it("marks a deleted token dead when its combatant was defeated", () => {
    expect(mergeMeta(sprite, { ...gone, dead: true }).dead).toBe(true);
  });

  it("takes a fresh read in combat, so a revived combatant is no longer dead", () => {
    expect(mergeMeta({ ...sprite, dead: true }, { ...sprite, dead: false }).dead).toBe(false);
  });

  it("keeps dead, fled and the combatant id off the tracker", () => {
    const m = mergeMeta({ ...sprite, dead: true, fled: true }, { ...sprite, combatantId: null }, { inCombat: false });
    expect(m).toMatchObject({ dead: true, fled: true, combatantId: "cS" });
  });

  it("uses the fresh read when nothing was stored", () => {
    expect(mergeMeta(undefined, gone)).toBe(gone);
  });
});
