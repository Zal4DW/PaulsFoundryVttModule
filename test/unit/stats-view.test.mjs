import { beforeAll, describe, expect, it } from "vitest";
import { aggregate, estimateMoves, extractRecords } from "../../scripts/lib/stats.mjs";
import { esc, leaderboards, num, pct, rankOf } from "../../scripts/lib/stats-view.mjs";
import { contextFromFixture, loadFixture } from "./fixture-context.mjs";

describe("formatting", () => {
  it("formats percentages and numbers, with a dash for missing values", () => {
    expect(pct(0.756)).toBe("76%");
    expect(pct(null)).toBe("–");
    expect(num(4.126, 2)).toBe("4.13");
    expect(num(undefined)).toBe("–");
  });

  it("escapes HTML", () => {
    expect(esc(`<b>"Hi" & 'bye'</b>`)).toBe("&lt;b&gt;&quot;Hi&quot; &amp; &#39;bye&#39;&lt;/b&gt;");
  });

});

describe("leaderboards and ranks on Day One", () => {
  let stats;
  const award = (id) => leaderboards(stats.heroes).find((b) => b.id === id);

  beforeAll(() => {
    const d = loadFixture("day1-ring-of-valor.json");
    const ctx = contextFromFixture(d);
    stats = aggregate(estimateMoves(extractRecords(d.messages, ctx), ctx.grid, ctx.finalPositions), ctx.meta);
  });

  it("names Kagura the setup artist and the most-hit hero the punching bag", () => {
    expect(award("assists").name).toBe("Kagura");
    expect(award("tank").name).toBe("Agnath");
  });

  it("names a kill thief, because Day One had stolen kills", () => {
    expect(award("stolen")).toBeDefined();
    expect(award("stolen").value).toMatch(/stolen/);
  });

  it("leaves out categories nobody qualifies for", () => {
    expect(award("healer")).toBeUndefined(); // no healing on Day One
  });

  it("names the most wounded hero, with how often they went down", () => {
    const heroes = [
      { key: "V", name: "Vex", woundsTaken: 20, conditions: { weakened: 2 } },
      { key: "B", name: "Brannoc", woundsTaken: 0, conditions: {} }
    ].map((h) => ({ damageTaken: 0, damageDealt: 0, woundsDealt: 0, killsSolo: 0, killsEarned: 0, killsStolen: 0, assists: 0, attacks: 0, healingDone: 0, buffs: 0, feetMoved: 0, avgPosition: null, combatRolls: { count: 0, critFailures: 0 }, checkRolls: { successes: 0, failures: 0 }, ...h }));
    expect(leaderboards(heroes).find((b) => b.id === "wounded")).toMatchObject({ name: "Vex", value: "20 wounds · down ×2" });
  });

  it("ranks a hero against the party", () => {
    const agnath = stats.heroes.find((s) => s.name === "Agnath");
    expect(rankOf(stats.heroes, agnath.key, (s) => s.damageTaken)).toEqual({ rank: 1, of: 4 });
  });
});
