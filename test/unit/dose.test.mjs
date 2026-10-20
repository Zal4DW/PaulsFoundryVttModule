import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addictionPenalty, afterDose, afterRest, DOSE_ACTION, DOSE_ADDICTION, DOSE_HEALING, doseHealing, isActionConfirm } from "../../scripts/lib/dose.mjs";

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

describe("isActionConfirm", () => {
  it("is true only when the GM confirms a card for that action", () => {
    expect(isActionConfirm({ action: { id: DOSE_ACTION } }, { flags: { crucible: { confirmed: true } } }, DOSE_ACTION)).toBe(true);
    expect(isActionConfirm({ action: { id: DOSE_ACTION } }, { flags: { crucible: { confirmed: false } } }, DOSE_ACTION)).toBe(false);
    expect(isActionConfirm({ action: { id: "rest" } }, { flags: { crucible: { confirmed: true } } }, DOSE_ACTION)).toBe(false);
  });
});

describe("Dose of It'll Be Alright... item", () => {
  it("is a standard flask at 3 gp with one rest-only consumed action", () => {
    expect(dose).toBeDefined();
    expect(dose.system).toMatchObject({ category: "flask", quality: "standard", price: 300 });
    expect(dose.system.actions[0].id).toBe(DOSE_ACTION);
    expect(dose.system.actions[0].tags).toEqual(expect.arrayContaining(["consume", "rest"]));
  });

  it("states the same amounts in its description as the code uses", () => {
    const text = dose.system.actions[0].description;
    for (const q of Object.keys(DOSE_HEALING)) expect(text).toContain(`Recover ${DOSE_HEALING[q]} <strong>Madness</strong>. Addiction +${DOSE_ADDICTION[q]}.`);
  });
});
