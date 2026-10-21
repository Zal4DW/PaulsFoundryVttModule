import { describe, it, expect } from "vitest";
import { pileRemovals, clampQuantity } from "../../scripts/lib/stash-bridge.mjs";

const qty = { a: 1, b: 5 };
const quantityOf = (id) => qty[id];

describe("pileRemovals", () => {
  it("turns deletes into full-quantity removals", () => {
    expect(pileRemovals("delete", ["a", "b"], quantityOf)).toEqual([{ _id: "a", quantity: 1 }, { _id: "b", quantity: 5 }]);
  });

  it("turns a quantity drop into a partial removal, flat or nested", () => {
    expect(pileRemovals("update", [{ _id: "b", "system.quantity": 2 }], quantityOf)).toEqual([{ _id: "b", quantity: 3 }]);
    expect(pileRemovals("update", [{ _id: "b", system: { quantity: 4 } }], quantityOf)).toEqual([{ _id: "b", quantity: 1 }]);
  });

  it("refuses updates that change more than the quantity, or raise it", () => {
    expect(pileRemovals("update", [{ _id: "b", "system.quantity": 2, name: "x" }], quantityOf)).toBeNull();
    expect(pileRemovals("update", [{ _id: "b", system: { quantity: 2, price: 3 } }], quantityOf)).toBeNull();
    expect(pileRemovals("update", [{ _id: "b", "system.quantity": 6 }], quantityOf)).toBeNull();
  });

  it("refuses unknown items", () => {
    expect(pileRemovals("delete", ["zzz"], quantityOf)).toBeNull();
    expect(pileRemovals("update", [{ _id: "zzz", "system.quantity": 0 }], quantityOf)).toBeNull();
  });
});

describe("clampQuantity", () => {
  it("takes everything when no quantity is chosen", () => {
    expect(clampQuantity(NaN, 7)).toBe(7);
    expect(clampQuantity(0, 7)).toBe(7);
  });

  it("caps the choice at what is there", () => {
    expect(clampQuantity(3, 7)).toBe(3);
    expect(clampQuantity(9, 7)).toBe(7);
    expect(clampQuantity(2.6, 7)).toBe(2);
  });

  it("returns 0 for an empty pile", () => {
    expect(clampQuantity(3, 0)).toBe(0);
  });
});
