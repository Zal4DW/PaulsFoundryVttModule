// Merchant rules: prices, stock and the trade log. No Foundry globals, so Vitest can test them in Node.
// The GM's client applies trades with these (scripts/merchant/trade.mjs); see docs/merchant-plan.md.

/** The actor flag that makes an adversary actor a merchant. */
export const MERCHANT_FLAG = "merchant";
/** How many trades a merchant keeps for undo. */
export const LOG_LIMIT = 50;

/** A merchant's data with every field filled in, and rates as whole percentages from 0 to 1000. */
export function normaliseMerchant(data = {}) {
  const rate = (v, d) => (Number.isFinite(Number(v)) ? Math.min(1000, Math.max(0, Math.round(Number(v)))) : d);
  return {
    enabled: data.enabled !== false,
    buyRate: rate(data.buyRate, 100),
    sellRate: rate(data.sellRate, 50),
    requireApproval: !!data.requireApproval,
    catalogue: (data.catalogue ?? []).filter((l) => l?.id && l?.uuid).map((l) => ({
      id: l.id, uuid: l.uuid,
      count: l.count === null || l.count === undefined ? null : Math.max(0, Math.floor(Number(l.count) || 0)),
      price: l.price === null || l.price === undefined || l.price === "" ? null : Math.max(0, Math.round(Number(l.price) || 0))
    })),
    log: Array.isArray(data.log) ? data.log.slice(-LOG_LIMIT) : []
  };
}

/**
 * What a hero pays for one item, in copper. A line's own price wins over the rate.
 * @param {number} listPrice  The item's system.price, in copper.
 * @param {number} rate  The merchant's buy rate, in percent.
 * @param {number|null} [override]  The catalogue line's price, in copper.
 */
export function priceFor(listPrice, rate, override = null) {
  if (override !== null && override !== undefined) return Math.max(0, Math.round(override));
  return Math.max(0, Math.round(((Number(listPrice) || 0) * rate) / 100));
}

/**
 * Can this purchase go through? Checks the quantity, the stock and the hero's coin.
 * @param {{quantity: number, stock: number|null, unitPrice: number, purse: number}} trade  stock null means unlimited.
 * @returns {{ok: boolean, reason: string|null, total: number}}  reason: "quantity", "soldOut", "notEnoughStock" or "notEnoughCoin".
 */
export function checkBuy({ quantity, stock, unitPrice, purse }) {
  const total = unitPrice * quantity;
  if (!Number.isInteger(quantity) || quantity < 1) return { ok: false, reason: "quantity", total: 0 };
  if (stock !== null && stock < 1) return { ok: false, reason: "soldOut", total };
  if (stock !== null && quantity > stock) return { ok: false, reason: "notEnoughStock", total };
  if (total > (Number(purse) || 0)) return { ok: false, reason: "notEnoughCoin", total };
  return { ok: true, reason: null, total };
}

/**
 * Can a hero sell this item to the merchant? The merchant has coin without limit.
 * @param {{quantity: number, have: number, unitPrice: number, equipped?: boolean, sellable?: boolean}} trade
 *   have: how many the hero holds. sellable: false for things with no price, such as talents and spells.
 * @returns {{ok: boolean, reason: string|null, total: number}}  reason: "quantity", "cantSell", "equipped" or "notEnoughItems".
 */
export function checkSell({ quantity, have, unitPrice, equipped = false, sellable = true }) {
  if (!Number.isInteger(quantity) || quantity < 1) return { ok: false, reason: "quantity", total: 0 };
  if (!sellable) return { ok: false, reason: "cantSell", total: 0 };
  if (equipped) return { ok: false, reason: "equipped", total: 0 };
  if (quantity > have) return { ok: false, reason: "notEnoughItems", total: 0 };
  return { ok: true, reason: null, total: unitPrice * quantity };
}

/** The catalogue with an undone purchase put back on its line. An unlimited or removed line is unchanged. */
export function restoreCatalogue(catalogue, lineId, quantity) {
  return catalogue.map((l) => (l.id === lineId && l.count !== null ? { ...l, count: l.count + quantity } : l));
}

/**
 * The trade to undo, or why it can't be undone.
 * @returns {{entry: object|null, reason: string|null}}  reason: "noTrade" or "alreadyUndone".
 */
export function findUndoable(log, tradeId) {
  const entry = (log ?? []).find((e) => e.id === tradeId) ?? null;
  if (!entry) return { entry: null, reason: "noTrade" };
  if (entry.undone) return { entry: null, reason: "alreadyUndone" };
  return { entry, reason: null };
}

/** The log with one trade marked as undone. */
export function markUndone(log, tradeId) {
  return (log ?? []).map((e) => (e.id === tradeId ? { ...e, undone: true } : e));
}

/** The catalogue after selling quantity from one line. An unlimited line is unchanged. A sold-out line stays listed. */
export function takeFromCatalogue(catalogue, lineId, quantity) {
  return catalogue.map((l) => (l.id === lineId && l.count !== null ? { ...l, count: Math.max(0, l.count - quantity) } : l));
}

/** The log with one more trade, keeping the last LOG_LIMIT. */
export function logTrade(log, entry) {
  return [...(log ?? []), entry].slice(-LOG_LIMIT);
}

/** True for an actor's Item Piles flag data that makes it an enabled Item Piles merchant. */
export const isItemPilesMerchant = (data) => !!data && data.enabled !== false && data.type === "merchant";

/**
 * Turn an Item Piles merchant's settings into merchant data. Its stock is the actor's own items, which stay where
 * they are as held items, so the catalogue starts empty.
 * @param {{buyPriceModifier?: number, sellPriceModifier?: number}} data  The actor's flags["item-piles"].data.
 */
export function fromItemPilesMerchant(data = {}) {
  const pct = (v, d) => (Number.isFinite(Number(v)) ? Number(v) * 100 : d);
  return normaliseMerchant({ buyRate: pct(data.buyPriceModifier, 100), sellRate: pct(data.sellPriceModifier, 50) });
}

/**
 * Crucible Shop shops that can be imported: those with their own item list. A "default" shop sells from
 * Crucible's whole equipment list, which has no list to copy.
 * @param {Record<string, {id: string, name: string, mode?: string, itemUuids?: string[]}>} shops
 */
export const importableShops = (shops = {}) => Object.values(shops).filter((s) => s?.mode !== "default" && (s?.itemUuids?.length ?? 0) > 0);

/**
 * Turn a Crucible Shop shop into merchant data. Crucible Shop lists items by uuid with no stock, so each line is unlimited.
 * @param {{itemUuids?: string[], buyRate?: number, sellRate?: number, requireApproval?: boolean}} shop
 * @param {() => string} makeId  Makes a line id (foundry.utils.randomID in Foundry).
 */
export function fromCrucibleShop(shop, makeId) {
  return normaliseMerchant({
    buyRate: shop.buyRate, sellRate: shop.sellRate, requireApproval: shop.requireApproval,
    catalogue: (shop.itemUuids ?? []).map((uuid) => ({ id: makeId(), uuid, count: null, price: null }))
  });
}
