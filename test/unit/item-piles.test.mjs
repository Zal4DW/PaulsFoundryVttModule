import { describe, expect, it } from "vitest";
import { crucibleItemPilesConfig, INTEGRATION_VERSION, NON_LOOT_ITEM_TYPES } from "../../scripts/lib/item-piles.mjs";

describe("crucibleItemPilesConfig", () => {
  const config = crucibleItemPilesConfig();

  it("carries the integration version, so Item Piles knows when to re-apply it", () => {
    expect(config.VERSION).toBe(INTEGRATION_VERSION);
    expect(INTEGRATION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("points at Crucible's item quantity and price fields", () => {
    expect(config.ITEM_QUANTITY_ATTRIBUTE).toBe("system.quantity");
    expect(config.ITEM_PRICE_ATTRIBUTE).toBe("system.price");
  });

  it("uses one primary copper currency on system.currency", () => {
    expect(config.CURRENCIES).toEqual([expect.objectContaining({
      type: "attribute", primary: true, exchangeRate: 1, data: { path: "system.currency" }
    })]);
    expect(config.CURRENCIES[0].abbreviation).toContain("{#}");
  });

  it("keeps character items out of loot but lets gear through", () => {
    const filtered = config.ITEM_FILTERS.find((f) => f.path === "type").filters.split(",");
    expect(filtered).toEqual(NON_LOOT_ITEM_TYPES);
    for (const gear of ["weapon", "armor", "accessory", "consumable", "loot", "tool"]) expect(filtered).not.toContain(gear);
  });

  it("builds piles from adversary actors, which need no ancestry or background", () => {
    expect(config.ACTOR_CLASS_TYPE).toBe("adversary");
  });
});
