import { describe, expect, it } from "vitest";
import { aggregate, aggregateToDate, isCombatFight } from "../../scripts/lib/stats.mjs";
import { contextFromFixture, loadFixture } from "./fixture-context.mjs";

const hero = (key, actorId, extra = {}) => ({ key, name: extra.name ?? actorId, actorId, type: "hero", combatantId: `c${key}`, ...extra });
const foe = (key, name, extra = {}) => ({ key, name, type: "adversary", combatantId: `c${key}`, ...extra });
const strike = (actor, target, damage, round = 1) => ({
  kind: "action", actor, round, actionId: "strike", tags: [], spent: { action: 2 }, restored: {}, effects: [], heals: [],
  attacks: [{ target, total: 15, dc: 12, result: damage ? "hit" : "dodge", health: damage, wounds: 0, morale: 0 }]
});

// Two fights. Hilde fights in both under different tokens; Zarajah dies in the first; the boss survives both.
const dayOne = {
  id: "f1", name: "Day One", started: 1,
  meta: { T1: hero("T1", "hilde", { name: "Hilde" }), T2: hero("T2", "zara", { name: "Zarajah", dead: true, statuses: ["dead"] }), M1: foe("M1", "Rat", { rank: "minion", dead: true }), B1: foe("B1", "Orivech", { rank: "boss" }) },
  records: [strike("T1", "M1", 6), strike("T1", "B1", 4), strike("B1", "T2", 30)],
  outcome: { result: "defeat" }
};
const dayTwo = {
  id: "f2", name: "Day Two", started: 2,
  meta: { T9: hero("T9", "hilde", { name: "Hilde", tokenName: "Hilde" }), T8: hero("T8", "keld", { name: "Keld" }), B7: foe("B7", "Orivech", { rank: "boss", dead: true }) },
  records: [strike("T9", "B7", 10, 1), strike("T8", "B7", 0, 1), strike("T8", "B7", 12, 2)]
};
const session = { id: "session-2026-10-18", name: "Out of combat", started: 3, meta: { T1: hero("T1", "hilde", { name: "Hilde", combatantId: undefined }) }, records: [{ kind: "check", actor: "T1", skill: "medicine", total: 14, dc: 12, success: true }] };

describe("stats to date", () => {
  const s = aggregateToDate([dayTwo, session, dayOne]);
  const byName = (n) => s.heroes.find((h) => h.name === n);

  it("merges a hero's fights by actor, across token changes", () => {
    const hilde = byName("Hilde");
    expect(hilde.fights).toBe(2);
    expect(hilde.attacks).toBe(3);
    expect(hilde.damageDealt).toBe(20);
    expect(hilde.checks).toBe(1); // the out-of-combat check still counts toward her totals
    expect(hilde.combatRolls.count).toBe(3);
  });

  it("lists the out-of-combat bucket as a session with its checks, and adds its checks to the party by skill", () => {
    expect(s.summary.sessions).toBe(1);
    expect(s.sessions).toMatchObject([{ id: "session-2026-10-18", heroes: ["Hilde"] }]);
    expect([s.sessions[0].checks.count, s.sessions[0].checks.successes]).toEqual([1, 1]);
    expect(s.party.checksBySkill.medicine).toEqual({ checks: 1, successes: 1 });
  });

  it("does not count the out-of-combat bucket as a fight", () => {
    expect(isCombatFight(session)).toBe(false);
    expect(s.summary.fights).toBe(2);
    expect(s.fights.map((f) => f.name)).toEqual(["Day One", "Day Two"]);
  });

  it("keeps each hero's win and loss record", () => {
    expect(s.results).toMatchObject({ victory: 1, defeat: 1 });
    expect(byName("Hilde").record).toMatchObject({ victory: 1, defeat: 1 });
    expect(byName("Keld").record).toMatchObject({ victory: 1, defeat: 0 });
  });

  it("works out status from the fights: dead, active in the latest fight, else benched", () => {
    expect(byName("Zarajah").status).toBe("dead");
    expect(byName("Keld").status).toBe("active");
    expect(byName("Hilde").status).toBe("active");
    const onlyFirst = aggregateToDate([dayOne, { ...dayTwo, meta: { ...dayTwo.meta, T9: undefined }, records: dayTwo.records.slice(1) }].map((f) => ({ ...f, meta: Object.fromEntries(Object.entries(f.meta).filter(([, m]) => m)) })));
    expect(onlyFirst.heroes.find((h) => h.name === "Hilde").status).toBe("benched");
  });

  it("prefers the world's status when one is given", () => {
    const live = aggregateToDate([dayOne, dayTwo], { statusOf: (id) => (id === "hilde" ? "benched" : null) });
    expect(live.heroes.find((h) => h.name === "Hilde").status).toBe("benched");
    expect(live.heroes.find((h) => h.name === "Keld").status).toBe("active");
  });

  it("merges a major adversary across fights by name, and keeps the kill with its fight", () => {
    expect(s.majorAdversaries).toHaveLength(1);
    const boss = s.majorAdversaries[0];
    expect(boss.name).toBe("Orivech");
    expect(boss.fights).toBe(2);
    expect(boss.damageTaken).toBe(26);
    const bossKill = s.kills.find((k) => k.target === boss.key);
    expect(bossKill.fightName).toBe("Day Two");
    expect(s.combatants[bossKill.by].name).toBe("Keld");
    expect(s.kills.find((k) => k.fightName === "Day One" && s.combatants[k.target].name === "Zarajah")).toBeTruthy();
  });

  it("does not count the out-of-combat bucket as a fight for a major adversary", () => {
    const withBoss = { ...session, meta: { ...session.meta, B9: foe("B9", "Orivech", { rank: "boss", combatantId: undefined }) }, records: [...session.records, { kind: "check", actor: "B9", skill: "arcana", total: 10, dc: 12, success: false }] };
    const s2 = aggregateToDate([dayOne, dayTwo, withBoss]);
    expect(s2.majorAdversaries.find((m) => m.name === "Orivech").fights).toBe(2);
  });

  it("leaves out heroes who only rested outside combat", () => {
    const rest = { kind: "action", actor: "R1", round: null, actionId: "rest", tags: [], spent: {}, restored: {}, effects: [], heals: [], attacks: [] };
    const rested = aggregateToDate([dayOne, { ...session, meta: { ...session.meta, R1: hero("R1", "bella", { name: "Belladonna", combatantId: undefined }) }, records: [...session.records, rest] }]);
    expect(rested.heroes.find((h) => h.name === "Belladonna")).toBeUndefined();
  });

  it("names two actors that share a name apart", () => {
    const pregen = { id: "f3", name: "Day Three", started: 4, meta: { P1: hero("P1", "hilde-l6", { name: "Hilde", tokenName: "Hilde (L6)" }) }, records: [strike("P1", "X", 1)] };
    const both = aggregateToDate([dayOne, pregen]);
    expect(both.heroes.find((h) => h.actorId === "hilde").name).toBe("Hilde");
    expect(both.heroes.find((h) => h.actorId === "hilde-l6").name).toBe("Hilde (L6)");
    const twins = aggregateToDate([dayOne, { ...pregen, meta: { P1: hero("P1", "hilde-2", { name: "Hilde" }) } }]);
    expect(twins.heroes.map((h) => h.name).filter((n) => n.startsWith("Hilde")).sort()).toEqual(["Hilde", "Hilde (2)"]);
  });

  it("adds a real fight to the totals without changing its numbers", () => {
    const { fight } = contextFromFixture(loadFixture("day1-ring-of-valor.json"));
    fight.started = 0;
    const one = aggregate(fight.records, fight.meta);
    const total = aggregateToDate([fight, dayTwo]);
    const sum = (rows) => rows.reduce((a, h) => a + h.damageDealt, 0);
    expect(sum(total.heroes)).toBe(sum(one.heroes) + 22);
    expect(total.summary.fights).toBe(2);
  });
});
