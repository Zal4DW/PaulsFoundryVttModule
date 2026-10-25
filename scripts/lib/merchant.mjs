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

/** The catalogue after selling quantity from one line. An unlimited line is unchanged. A sold-out line stays listed. */
export function takeFromCatalogue(catalogue, lineId, quantity) {
  return catalogue.map((l) => (l.id === lineId && l.count !== null ? { ...l, count: Math.max(0, l.count - quantity) } : l));
}

/** The log with one more trade, keeping the last LOG_LIMIT. */
export function logTrade(log, entry) {
  return [...(log ?? []), entry].slice(-LOG_LIMIT);
}

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
