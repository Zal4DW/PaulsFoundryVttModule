// Move shops over from Crucible Shop and merchants over from Item Piles, so Crucible Shop can be turned off.
import { fromCrucibleShop, fromItemPilesMerchant, importableShops, isItemPilesMerchant } from "../lib/merchant.mjs";
import { merchantData } from "./trade.mjs";

const { ApplicationV2 } = foundry.applications.api;
const L = (key, data) => (data ? game.i18n.format(`PFM.Merchant.${key}`, data) : game.i18n.localize(`PFM.Merchant.${key}`));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** Crucible Shop's shops, or {} when it isn't installed and active. */
function crucibleShops() {
  if (!game.modules.get("crucible-shop")?.active || !game.settings.settings.has("crucible-shop.shops")) return {};
  return game.settings.get("crucible-shop", "shops") ?? {};
}

/** The merchant actor made from a Crucible Shop shop, found by flag so a renamed actor still counts. */
const actorForShop = (moduleId, shopId) => game.actors.find((a) => a.getFlag(moduleId, "importedFrom") === `crucible-shop.${shopId}`) ?? null;

/**
 * Make (or update) an adversary actor that sells a Crucible Shop shop's items, at the shop's rates.
 * Running it again updates the same actor and keeps its trade log.
 */
export async function importCrucibleShop(moduleId, shopId) {
  const shop = crucibleShops()[shopId];
  if (!shop) throw new Error(`No Crucible Shop shop "${shopId}"`);
  let actor = actorForShop(moduleId, shopId);
  actor ??= await Actor.create({ name: shop.name, type: "adversary", img: "icons/environment/settlement/market-stall.webp", flags: { [moduleId]: { importedFrom: `crucible-shop.${shopId}` } } });
  const data = fromCrucibleShop(shop, () => foundry.utils.randomID());
  await game.modules.get(moduleId).api.setMerchant(actor, { ...data, log: merchantData(moduleId, actor)?.log ?? [] });
  return actor;
}

// Read the flag directly: getFlag throws while Item Piles is turned off, and a GM may turn it off before importing.
const pilesData = (doc) => doc.flags?.["item-piles"]?.data ?? null;

/**
 * Make an Item Piles merchant one of ours. Its items stay as held items, and Item Piles is turned off on the actor,
 * so a double-click on its token opens our window, not Item Piles'.
 */
export async function importItemPilesMerchant(moduleId, actor) {
  const piles = pilesData(actor);
  if (!piles) throw new Error(`${actor.name} has no Item Piles data to import`);
  await game.modules.get(moduleId).api.setMerchant(actor, { ...fromItemPilesMerchant(piles), log: merchantData(moduleId, actor)?.log ?? [] });
  await actor.update({ "flags.item-piles.data.enabled": false });
  // Its placed tokens carry their own copy of the flag.
  for (const scene of game.scenes) {
    const updates = scene.tokens.filter((t) => t.actorId === actor.id && pilesData(t)).map((t) => ({ _id: t.id, "flags.item-piles.data.enabled": false }));
    if (updates.length) await scene.updateEmbeddedDocuments("Token", updates);
  }
  return actor;
}

/** GM window: each shop or Item Piles merchant that can be moved over, with an Import button. */
export class MerchantImport extends ApplicationV2 {
  static moduleId = "pauls-foundry-module";

  static DEFAULT_OPTIONS = {
    id: "pfm-merchant-import",
    classes: ["pfm-merchant", "pfm-merchant-import"],
    window: { title: "PFM.Merchant.ImportTitle", icon: "fa-solid fa-file-import" },
    position: { width: 520, height: "auto" },
    actions: { shop: MerchantImport.#onShop, piles: MerchantImport.#onPiles }
  };

  async _prepareContext() {
    const id = MerchantImport.moduleId;
    const shops = importableShops(crucibleShops()).map((s) => ({ id: s.id, name: s.name, count: s.itemUuids.length, done: !!actorForShop(id, s.id) }));
    const piles = game.actors.filter((a) => isItemPilesMerchant(pilesData(a))).map((a) => ({ id: a.id, name: a.name, count: a.items.size }));
    return { shops, piles };
  }

  async _renderHTML({ shops, piles }) {
    const row = (action, r, done = false) => `<li class="pfm-merchant-config-row import"><span class="pfm-merchant-name">${esc(r.name)}</span>
      <span>${esc(L("ItemCount", { count: r.count }))}</span>
      <button type="button" data-action="${action}" data-id="${r.id}">${esc(done ? L("Reimport") : L("Import"))}</button></li>`;
    return `<p>${esc(L("ImportHint"))}</p>
      <h4>${esc(L("FromCrucibleShop"))}</h4><ul class="pfm-merchant-config-list">${shops.map((s) => row("shop", s, s.done)).join("") || `<li class="pfm-empty">${esc(L("NothingToImport"))}</li>`}</ul>
      <h4>${esc(L("FromItemPiles"))}</h4><ul class="pfm-merchant-config-list">${piles.map((p) => row("piles", p)).join("") || `<li class="pfm-empty">${esc(L("NothingToImport"))}</li>`}</ul>`;
  }

  _replaceHTML(result, content) { content.innerHTML = result; }

  static async #onShop(_event, target) {
    const actor = await importCrucibleShop(MerchantImport.moduleId, target.dataset.id);
    ui.notifications.info(L("Imported", { name: actor.name }));
    this.render();
  }

  static async #onPiles(_event, target) {
    const actor = await importItemPilesMerchant(MerchantImport.moduleId, game.actors.get(target.dataset.id));
    ui.notifications.info(L("Imported", { name: actor.name }));
    this.render();
  }
}
