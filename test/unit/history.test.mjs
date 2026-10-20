import { describe, expect, it } from "vitest";
import { COMBAT_TAIL_MS, groupHistory, isSessionId, isStatsCard, journalTargets, reportRows, sessionIdFor } from "../../scripts/lib/history.mjs";
import { loadFixture } from "./fixture-context.mjs";

const report = (id, ts, combatId, round = 1) => ({ _id: id, timestamp: ts, speaker: { alias: `Initiative - Round ${round}` }, flags: { crucible: { isInitiativeReport: true } },
  content: `<table data-combat-id="${combatId}"><tr class="combatant" data-combatant-id="c1"><td class="report-label initiative-name">Maren</td></tr></table>` });
const action = (id, ts, tags = []) => ({ _id: id, timestamp: ts, flags: { crucible: { action: { id: "strike", tags } } } });
const check = (id, ts) => ({ _id: id, timestamp: ts, flags: { crucible: { skill: "arcana" } } });
const T0 = Date.UTC(2026, 9, 18, 15, 0, 0);
const MIN = 60 * 1000;

describe("reading past chat history", () => {
  it("keeps only the cards the stats read", () => {
    expect(isStatsCard(action("a", 0))).toBe(true);
    expect(isStatsCard({ flags: { ember: { attunementAward: true } } })).toBe(true);
    expect(isStatsCard({ content: "<p>Hello</p>", flags: {} })).toBe(false);
  });

  it("reads each combatant's name from an initiative report", () => {
    expect(reportRows(report("r", 0, "C").content)).toEqual([{ combatantId: "c1", name: "Maren" }]);
  });

  it("groups a combat by its initiative reports, and puts the rest in day sessions", () => {
    const g = groupHistory([
      check("before", T0 - 30 * MIN),
      report("r1", T0, "COMBAT1"), action("a1", T0 + MIN), check("mid", T0 + 2 * MIN), report("r2", T0 + 3 * MIN, "COMBAT1", 2), action("a2", T0 + 4 * MIN),
      action("rest", T0 + 5 * MIN, ["noncombat"]),
      action("later", T0 + 4 * MIN + COMBAT_TAIL_MS + 1)
    ]);
    expect(g.fights.map((f) => [f.id, f.messages.map((m) => m._id)])).toEqual([["COMBAT1", ["r1", "a1", "mid", "r2", "a2"]]]);
    expect(g.sessions.map((s) => [s.id, s.messages.map((m) => m._id)])).toEqual([[sessionIdFor(T0), ["before", "rest", "later"]]]);
  });

  it("starts a new fight at a report for another combat", () => {
    const g = groupHistory([report("r1", T0, "A"), action("a1", T0 + MIN), report("r2", T0 + 2 * MIN, "B"), action("b1", T0 + 3 * MIN)]);
    expect(g.fights.map((f) => [f.id, f.messages.length])).toEqual([["A", 2], ["B", 2]]);
  });

  it("skips messages already in the log, so importing twice adds nothing", () => {
    const msgs = [report("r1", T0, "A"), action("a1", T0 + MIN), check("c", T0 + 60 * MIN)];
    const g = groupHistory(msgs, { knownIds: new Set(["r1", "a1", "c"]) });
    expect([g.fights.length, g.sessions.length, g.skipped]).toEqual([0, 0, 3]);
  });

  it("puts Day One's combat cards in one fight, and the Recovers after it in the session", () => {
    const d = loadFixture("day1-ring-of-valor.json");
    const g = groupHistory(d.messages);
    expect(g.fights.map((f) => f.id)).toEqual([d.combat._id]);
    expect(g.fights[0].messages.length).toBe(47);
    expect(g.sessions[0].messages.every((m) => m.flags.crucible.action?.tags?.includes("noncombat"))).toBe(true);
  });
});

describe("journalTargets", () => {
  it("rewrites every combat just imported, even one that already has a page", () => {
    expect(journalTargets({ imported: ["c1", "c2"], stored: ["c1", "c2"], withPages: ["c1"] })).toEqual(["c1", "c2"]);
  });

  it("backfills stored combats with no page, so an earlier import gets its journal", () => {
    expect(journalTargets({ imported: [], stored: ["c1", "c2", "c3"], withPages: ["c2"] })).toEqual(["c1", "c3"]);
  });

  it("writes nothing twice and nothing when every combat already has a page", () => {
    expect(journalTargets({ imported: [], stored: ["c1"], withPages: ["c1"] })).toEqual([]);
    expect(journalTargets({ imported: ["c1"], stored: ["c1"], withPages: [] })).toEqual(["c1"]);
  });

  it("never gives an out-of-combat session a page", () => {
    const s = sessionIdFor(Date.UTC(2026, 9, 18));
    expect(isSessionId(s)).toBe(true);
    expect(journalTargets({ imported: [s], stored: [s, "c1"], withPages: [] })).toEqual(["c1"]);
  });
});
