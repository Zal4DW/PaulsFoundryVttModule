import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addictionPenalty, afterDose, afterRest, afterShatter, canTakeDose, DOSE_ACTION, DOSE_ADDICTION, DOSE_HEALING, doseHealing, getsShakes,
  isActionConfirm, SHAKES_HOURS, withoutMadnessRecovery } from "../../scripts/lib/dose.mjs";

const SHODDY = -2, STANDARD = 0, FINE = 1, SUPERIOR = 2, MASTERWORK = 3;
const source = new URL("../../packs/_source/items/", import.meta.url);
const dose = readdirSync(source).map((f) => JSON.parse(readFileSync(new URL(f, source), "utf8"))).find((d) => d.system?.identifier === "pfmAlrightDose");

describe("addiction penalty", () => {
  it("grows by one more each level: 0, 1, 3, 6, 10, 15, 21, 28, 36", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(addictionPenalty)).toEqual([0, 1, 3, 6, 10, 15, 21, 28, 36]);
  });
});

describe("doseHealing", () => {
  it("clears 1/5/10/20/40 Madness by quality when not addicted", () => {
    expect([SHODDY, STANDARD, FINE, SUPERIOR, MASTERWORK].map((q) => doseHealing(q, 0, 100))).toEqual([1, 5, 10, 20, 40]);
  });

  it("takes the penalty off as a flat amount, so stronger doses still work at high addiction", () => {
    expect(doseHealing(STANDARD, 2, 100)).toBe(2);
    expect(doseHealing(FINE, 2, 100)).toBe(7);
    expect(doseHealing(MASTERWORK, 6, 100)).toBe(19);
    expect(doseHealing(SHODDY, 1, 100)).toBe(0);
  });

  it("never goes below 0 or above the Madness the hero has", () => {
    expect(doseHealing(STANDARD, 9, 100)).toBe(0);
    expect(doseHealing(MASTERWORK, 0, 7)).toBe(7);
  });
});

describe("addiction over nights", () => {
  /** Rest, then dose, each night. Returns what each dose cleared. */
  function nights(qualities) {
    let state = { level: 0, dosed: false };
    return qualities.map((q) => {
      state = afterRest(state);
      const healed = doseHealing(q, state.level, 100);
      state = afterDose(state, q);
      return { healed, level: state.level };
    });
  }

  it("lets one Shoddy dose work, then does nothing on a second night in a row", () => {
    expect(nights([SHODDY, SHODDY, SHODDY])).toEqual([{ healed: 1, level: 1 }, { healed: 0, level: 2 }, { healed: 0, level: 3 }]);
  });

  it("crashes a nightly user who steps up: Standard, Standard, Fine, Superior, Masterwork", () => {
    // No clean nights, so the level never drops: 0, 2, 4, 7, 11 at each dose.
    expect(nights([STANDARD, STANDARD, FINE, SUPERIOR, MASTERWORK]).map((n) => n.healed)).toEqual([5, 2, 0, 0, 0]);
  });

  it("takes 1 level off for each clean night, and none for a night on the stuff", () => {
    expect(afterRest({ level: 3, dosed: false })).toEqual({ level: 2, dosed: false });
    expect(afterRest({ level: 3, dosed: true })).toEqual({ level: 3, dosed: false });
    expect(afterRest({ level: 0, dosed: false })).toEqual({ level: 0, dosed: false });
  });

  it("adds more addiction for stronger doses", () => {
    expect(Object.values(DOSE_ADDICTION).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(afterDose({ level: 1, dosed: false }, MASTERWORK)).toEqual({ level: 6, dosed: true });
  });
});

describe("canTakeDose", () => {
  it("allows a dose straight after a Rest", () => {
    expect(canTakeDose({ insane: false, lastActionId: "rest" })).toBe(true);
  });

  it("refuses a sane hero whose last action was not a Rest, such as a second dose", () => {
    expect(canTakeDose({ insane: false, lastActionId: "pfmAlrightDose" })).toBe(false);
    expect(canTakeDose({ insane: false, lastActionId: undefined })).toBe(false);
  });

  it("lets an Insane hero take one at any time, since they cannot Rest", () => {
    expect(canTakeDose({ insane: true, lastActionId: "strike" })).toBe(true);
  });
});

describe("isActionConfirm", () => {
  it("is true only when the GM confirms a card for that action", () => {
    expect(isActionConfirm({ action: { id: DOSE_ACTION } }, { flags: { crucible: { confirmed: true } } }, DOSE_ACTION)).toBe(true);
    expect(isActionConfirm({ action: { id: DOSE_ACTION } }, { flags: { crucible: { confirmed: false } } }, DOSE_ACTION)).toBe(false);
    expect(isActionConfirm({ action: { id: "rest" } }, { flags: { crucible: { confirmed: true } } }, DOSE_ACTION)).toBe(false);
  });
});

describe("Dose of It'll Be Alright... item", () => {
  it("is a standard flask at 3 gp with one consumed, out-of-combat action", () => {
    expect(dose).toBeDefined();
    expect(dose.system).toMatchObject({ category: "flask", quality: "standard", price: 300 });
    expect(dose.system.actions[0].id).toBe(DOSE_ACTION);
    // No Crucible "rest" tag: it would lock out Insane heroes, who cannot Rest. The hook checks it instead.
    expect(dose.system.actions[0].tags).toEqual(["consume", "noncombat"]);
  });

  it("states the same amounts in its description as the code uses", () => {
    const text = dose.system.actions[0].description;
    for (const q of Object.keys(DOSE_HEALING)) expect(text).toContain(`Recover ${DOSE_HEALING[q]} <strong>Madness</strong>. Addiction +${DOSE_ADDICTION[q]}.`);
  });
});

describe("withoutMadnessRecovery", () => {
  it("drops only the Rest's Madness reduction after a dose broke Insanity", () => {
    const rest = [{ resource: "health", delta: 20 }, { resource: "morale", delta: 15 }, { resource: "wounds", delta: -2 }, { resource: "madness", delta: -2 }];
    expect(withoutMadnessRecovery(rest)).toEqual(rest.slice(0, 3));
  });
});

describe("afterShatter", () => {
  it("adds 1 addiction when Fragile Calm shatters, and keeps the night's dose on record", () => {
    expect(afterShatter({ level: 2, dosed: true })).toEqual({ level: 3, dosed: true });
    expect(afterShatter(undefined)).toEqual({ level: 1, dosed: false });
  });
});

describe("getsShakes", () => {
  it("gives The Shakes after a clean Rest while addicted", () => {
    expect(getsShakes({ level: 1, dosed: false })).toBe(true);
  });

  it("gives none after a night on the stuff, or to a hero who is not addicted", () => {
    expect(getsShakes({ level: 4, dosed: true })).toBe(false);
    expect(getsShakes({ level: 0, dosed: false })).toBe(false);
    expect(getsShakes(undefined)).toBe(false);
  });

  it("lasts 4 hours", () => {
    expect(SHAKES_HOURS).toBe(4);
  });
});

describe("GM notes on the dose", () => {
  const notes = dose.system.description.private;

  it("are in the GM-only Secret Description, not the public one", () => {
    expect(notes).toContain("GM notes");
    expect(dose.system.description.public).not.toContain("GM notes");
  });

  it("give the same tolerance penalties and Shakes length as the code", () => {
    for (const level of [1, 2, 3, 4, 5, 6, 7, 8]) expect(notes).toContain(`<td>${level}</td><td>${addictionPenalty(level)}</td>`);
    expect(notes).toContain(`${SHAKES_HOURS} hours`);
  });

  it("name the macro API the GM can use to fix an addiction", () => {
    expect(notes).toContain("api.setAddiction(actor, level)");
  });
});
