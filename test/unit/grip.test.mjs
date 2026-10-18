import { describe, expect, it } from "vitest";
import { gripChange, SLOTS } from "../../scripts/lib/grip.mjs";

const sword = (extra = {}) => ({ versatile: true, hasSibling: true, equipped: true, slot: SLOTS.MAINHAND, ...extra });

describe("grip changes for Versatile weapons", () => {
  it("takes a one-handed Bastard Sword into both hands when the off hand is free", () => {
    expect(gripChange(sword(), true)).toEqual({ slot: SLOTS.TWOHAND, hands: 2 });
  });

  it("refuses two hands while the off hand holds a shield or weapon", () => {
    expect(gripChange(sword(), false)).toEqual({ error: "handInUse" });
  });

  it("goes back to one hand from two, whatever the other hand holds", () => {
    expect(gripChange(sword({ slot: SLOTS.TWOHAND }), false)).toEqual({ slot: SLOTS.MAINHAND, hands: 1 });
  });

  it("works from the off hand too, if the main hand is free", () => {
    expect(gripChange(sword({ slot: SLOTS.OFFHAND }), true)).toEqual({ slot: SLOTS.TWOHAND, hands: 2 });
  });

  it("does nothing for weapons that are not Versatile, are natural, or are not equipped", () => {
    expect(gripChange(sword({ versatile: false }), true)).toEqual({ error: "notVersatile" });
    expect(gripChange(sword({ natural: true }), true)).toEqual({ error: "notVersatile" });
    expect(gripChange(sword({ hasSibling: false }), true)).toEqual({ error: "notVersatile" });
    expect(gripChange(sword({ equipped: false }), true)).toEqual({ error: "notEquipped" });
  });
});
