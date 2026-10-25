import { describe, expect, it } from "vitest";
import { checkBuy, checkSell, findUndoable, fromCrucibleShop, LOG_LIMIT, logTrade, markUndone, normaliseMerchant, priceFor, restoreCatalogue, takeFromCatalogue } from "../../scripts/lib/merchant.mjs";

describe("normaliseMerchant", () => {
  it("fills in the defaults", () => {
    expect(normaliseMerchant()).toEqual({ enabled: true, buyRate: 100, sellRate: 50, requireApproval: false, catalogue: [], log: [] });
  });

  it("keeps rates whole and in range", () => {
    const m = normaliseMerchant({ buyRate: 79.6, sellRate: -5 });
    expect(m.buyRate).toBe(80);
    expect(m.sellRate).toBe(0);
  });

  it("keeps unlimited lines unlimited and drops lines with no uuid", () => {
    const m = normaliseMerchant({ catalogue: [{ id: "a", uuid: "U", count: null }, { id: "b", uuid: "V", count: 2.7 }, { id: "c" }] });
    expect(m.catalogue).toEqual([{ id: "a", uuid: "U", count: null, price: null }, { id: "b", uuid: "V", count: 2, price: null }]);
  });
});

describe("priceFor", () => {
  it("applies the buy rate to the list price, in whole copper", () => {
    expect(priceFor(300, 50)).toBe(150); // Muskrat's Dose
    expect(priceFor(7200, 80)).toBe(5760); // Plate Mail at the Armarium
    expect(priceFor(25, 50)).toBe(13);
  });

  it("uses a line's own price over the rate", () => {
    expect(priceFor(300, 50, 999)).toBe(999);
    expect(priceFor(300, 50, 0)).toBe(0);
  });
});

describe("checkBuy", () => {
  const base = { quantity: 1, stock: 3, unitPrice: 150, purse: 287 };

  it("allows a purchase the hero can afford from stock", () => {
    expect(checkBuy(base)).toEqual({ ok: true, reason: null, total: 150 });
  });

  it("allows any quantity from unlimited stock", () => {
    expect(checkBuy({ ...base, stock: null, quantity: 1, unitPrice: 287 }).ok).toBe(true);
  });

  it("refuses a bad quantity, a sold-out line, too few in stock and too little coin", () => {
    expect(checkBuy({ ...base, quantity: 0 }).reason).toBe("quantity");
    expect(checkBuy({ ...base, quantity: 1.5 }).reason).toBe("quantity");
    expect(checkBuy({ ...base, stock: 0 }).reason).toBe("soldOut");
    expect(checkBuy({ ...base, quantity: 4 }).reason).toBe("notEnoughStock");
    expect(checkBuy({ ...base, quantity: 2 }).reason).toBe("notEnoughCoin");
  });
});

describe("takeFromCatalogue", () => {
  const cat = [{ id: "a", uuid: "U", count: 2, price: null }, { id: "b", uuid: "V", count: null, price: null }];

  it("lowers a counted line and keeps it listed at zero", () => {
    expect(takeFromCatalogue(cat, "a", 2)[0].count).toBe(0);
  });

  it("leaves an unlimited line alone", () => {
    expect(takeFromCatalogue(cat, "b", 5)[1].count).toBeNull();
  });
});

describe("logTrade", () => {
  it("keeps the last 50 trades", () => {
    let log = [];
    for (let i = 0; i < LOG_LIMIT + 5; i++) log = logTrade(log, { id: i });
    expect(log).toHaveLength(LOG_LIMIT);
    expect(log[0].id).toBe(5);
  });
});

describe("fromCrucibleShop", () => {
  it("makes an unlimited line for each item and keeps the rates and approval", () => {
    let n = 0;
    const m = fromCrucibleShop({ itemUuids: ["U", "V"], buyRate: 80, sellRate: 50, requireApproval: true }, () => `id${n++}`);
    expect(m).toMatchObject({ buyRate: 80, sellRate: 50, requireApproval: true });
    expect(m.catalogue).toEqual([{ id: "id0", uuid: "U", count: null, price: null }, { id: "id1", uuid: "V", count: null, price: null }]);
  });
});

describe("checkSell", () => {
  const base = { quantity: 2, have: 3, unitPrice: 150 };

  it("pays the sell price for each item", () => {
    expect(checkSell(base)).toEqual({ ok: true, reason: null, total: 300 });
  });

  it("refuses a bad quantity, something with no price, an equipped item and more than the hero holds", () => {
    expect(checkSell({ ...base, quantity: 0 }).reason).toBe("quantity");
    expect(checkSell({ ...base, sellable: false }).reason).toBe("cantSell");
    expect(checkSell({ ...base, equipped: true }).reason).toBe("equipped");
    expect(checkSell({ ...base, quantity: 4 }).reason).toBe("notEnoughItems");
  });
});

describe("restoreCatalogue", () => {
  const cat = [{ id: "a", uuid: "U", count: 0, price: null }, { id: "b", uuid: "V", count: null, price: null }];

  it("puts an undone purchase back on a counted line", () => {
    expect(restoreCatalogue(cat, "a", 2)[0].count).toBe(2);
  });

  it("leaves an unlimited line alone", () => {
    expect(restoreCatalogue(cat, "b", 2)[1].count).toBeNull();
  });
});

describe("undo bookkeeping", () => {
  const log = [{ id: "t1" }, { id: "t2", undone: true }];

  it("finds a trade that can be undone", () => {
    expect(findUndoable(log, "t1")).toEqual({ entry: { id: "t1" }, reason: null });
  });

  it("says why a trade can't be undone", () => {
    expect(findUndoable(log, "t2").reason).toBe("alreadyUndone");
    expect(findUndoable(log, "nope").reason).toBe("noTrade");
  });

  it("marks a trade undone once", () => {
    expect(markUndone(log, "t1")[0].undone).toBe(true);
    expect(findUndoable(markUndone(log, "t1"), "t1").reason).toBe("alreadyUndone");
  });
});
