// Item Piles setup for Crucible. Pure data: no Foundry globals.
//
// Item Piles ships settings for the big systems, but not Crucible, so on a Crucible world it warns "System Not
// Recognized" and loot piles do not know where quantity, price or coin live. This is the integration Item Piles asks
// a module to register (game.itempiles.API.addSystemIntegration, from the item-piles-ready hook).
// Docs: https://github.com/fantasycalendar/FoundryVTT-ItemPiles/blob/master/docs/api.md#addsystemintegration

/**
 * Bump this when the config changes. Item Piles applies the config only when this is newer than the version the
 * world already stored, so a GM's own edits in Item Piles' settings survive until we ship a new version.
 */
export const INTEGRATION_VERSION = "1.0.0";

/** Item types that are part of a character, not things you can pick up, trade or drop. */
export const NON_LOOT_ITEM_TYPES = ["ancestry", "archetype", "background", "spell", "talent", "taxonomy"];

/**
 * The Item Piles system integration for Crucible.
 *
 * Crucible keeps coin as one integer in copper at system.currency (sp = 10, gp = 100, pp = 1000; see Crucible's
 * CURRENCY_DENOMINATIONS). Item Piles maps each currency to its own data field and cannot split one integer, so the
 * pile shows a single Copper currency.
 * @param {string} [img]  The copper coin icon.
 */
export function crucibleItemPilesConfig(img = "systems/crucible/icons/currency/cp.webp") {
  return {
    VERSION: INTEGRATION_VERSION,
    // Hero actors need an ancestry and background; an adversary is the plainest actor to hold a pile.
    ACTOR_CLASS_TYPE: "adversary",
    ITEM_CLASS_LOOT_TYPE: "loot",
    ITEM_CLASS_WEAPON_TYPE: "weapon",
    ITEM_CLASS_EQUIPMENT_TYPE: "armor",
    ITEM_QUANTITY_ATTRIBUTE: "system.quantity",
    ITEM_PRICE_ATTRIBUTE: "system.price",
    QUANTITY_FOR_PRICE_ATTRIBUTE: "",
    ITEM_FILTERS: [{ path: "type", filters: NON_LOOT_ITEM_TYPES.join(",") }],
    ITEM_SIMILARITIES: ["name", "type"],
    UNSTACKABLE_ITEM_TYPES: [],
    CURRENCIES: [{
      type: "attribute",
      name: "Copper",
      img,
      abbreviation: "{#}cp",
      data: { path: "system.currency" },
      primary: true,
      exchangeRate: 1
    }],
    SECONDARY_CURRENCIES: [],
    CURRENCY_DECIMAL_DIGITS: 0
  };
}
