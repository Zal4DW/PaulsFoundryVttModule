// The merchant window: the stock with prices in Crucible coin, the hero's purse, a Buy button per line, and a drop
// zone to sell an item from a hero's sheet.
import { priceFor } from "../lib/merchant.mjs";
import { isStackable, merchantData, requestTrade } from "./trade.mjs";

const { ApplicationV2, DialogV2 } = foundry.applications.api;
const L = (key, data) => (data ? game.i18n.format(`PFM.Merchant.${key}`, data) : game.i18n.localize(`PFM.Merchant.${key}`));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
/** Copper as "7GP 2SP 5CP", with Crucible's own formatter. */
export const coin = (cp) => globalThis.crucible?.api?.documents?.CrucibleItem?.formatCurrency?.(cp) ?? `${cp}cp`;

export class MerchantWindow extends ApplicationV2 {
  constructor(moduleId, merchant, options = {}) {
    super({ ...options, id: `pfm-merchant-${merchant.id}` });
    this.moduleId = moduleId;
    this.merchant = merchant;
    this.heroId = options.heroId ?? null;
    this.typeFilter = "";
    this.busy = false;
    this.hookIds = [];
  }

  static DEFAULT_OPTIONS = {
    classes: ["pfm-merchant"],
    window: { icon: "fa-solid fa-scale-balanced", resizable: true },
    position: { width: 560, height: 640 },
    actions: { buy: MerchantWindow.#onBuy }
  };

  get title() { return this.merchant.name; }

  /** Heroes this user can trade for: their assigned character first, then the other heroes they own. */
  #heroes() {
    const owned = game.actors.filter((a) => a.type === "hero" && a.isOwner);
    const mine = game.user.character;
    return mine && owned.includes(mine) ? [mine, ...owned.filter((a) => a !== mine)] : owned;
  }

  async _prepareContext() {
    const data = merchantData(this.moduleId, this.merchant);
    const heroes = this.#heroes();
    const hero = heroes.find((h) => h.id === this.heroId) ?? heroes[0] ?? null;
    this.heroId = hero?.id ?? null;
    const rows = [];
    for (const line of data?.catalogue ?? []) {
      const item = await fromUuid(line.uuid);
      if (item) rows.push({ source: "catalogue", id: line.id, item, stock: line.count, price: priceFor(item.system.price, data.buyRate, line.price) });
    }
    // Held items include what heroes sold here: the merchant resells them at the buy rate.
    for (const item of this.merchant.items) rows.push({ source: "held", id: item.id, item, stock: item.system.quantity ?? 1, price: priceFor(item.system.price, data.buyRate) });
    rows.sort((a, b) => a.item.type.localeCompare(b.item.type) || a.item.name.localeCompare(b.item.name));
    return { data, heroes, hero, rows };
  }

  async _renderHTML({ data, heroes, hero, rows }) {
    if (!data?.enabled) return `<p class="pfm-empty">${esc(L("Closed"))}</p>`;
    const types = [...new Set(rows.map((r) => r.item.type))];
    const typeLabel = (t) => game.i18n.localize(CONFIG.Item.typeLabels?.[t] ?? t);
    const typePick = `<select class="pfm-merchant-type"><option value="">${esc(L("AllTypes"))}</option>${types.map((t) => `<option value="${esc(t)}" ${t === this.typeFilter ? "selected" : ""}>${esc(typeLabel(t))}</option>`).join("")}</select>`;
    const heroPick = heroes.length
      ? `<select class="pfm-merchant-hero">${heroes.map((h) => `<option value="${h.id}" ${h === hero ? "selected" : ""}>${esc(h.name)}</option>`).join("")}</select>`
      : `<span>${esc(L("NoHero"))}</span>`;
    const purse = hero ? `<span class="pfm-merchant-purse">${esc(L("Purse", { coin: coin(hero.system.currency ?? 0) }))}</span>` : "";
    const shown = rows.filter((r) => !this.typeFilter || r.item.type === this.typeFilter);
    const body = shown.map((r) => {
      const soldOut = r.stock !== null && r.stock < 1;
      const one = r.source === "held" && !isStackable(r.item);
      const max = r.stock === null ? "" : `max="${r.stock}"`;
      const qty = one || soldOut ? "" : `<input type="number" class="pfm-merchant-qty" min="1" ${max} value="1">`;
      const afford = hero && r.price <= (hero.system.currency ?? 0);
      const button = soldOut
        ? `<span class="pfm-merchant-soldout">${esc(L("SoldOut"))}</span>`
        : `<button type="button" data-action="buy" data-source="${r.source}" data-id="${r.id}" ${hero && !this.busy ? "" : "disabled"}>${esc(L("Buy"))}</button>`;
      return `<li class="pfm-merchant-row ${soldOut ? "soldout" : ""} ${afford ? "" : "dear"}">
        <img src="${esc(r.item.img)}" alt=""><span class="pfm-merchant-name" data-tooltip="${esc(typeLabel(r.item.type))}">${esc(r.item.name)}</span>
        <span class="pfm-merchant-stock">${esc(r.stock === null ? L("Unlimited") : L("InStock", { count: r.stock }))}</span>
        <span class="pfm-merchant-price">${esc(coin(r.price))}</span>${qty}${button}</li>`;
    }).join("");
    return `<header class="pfm-merchant-head">${heroPick}${purse}${typePick}</header>
      <ul class="pfm-merchant-stock-list">${body || `<li class="pfm-empty">${esc(L("Empty"))}</li>`}</ul>
      <footer class="pfm-merchant-drop"><i class="fa-solid fa-hand-holding-dollar"></i> ${esc(L("DropToSell", { rate: data.sellRate }))}</footer>`;
  }

  _replaceHTML(result, content) { content.innerHTML = result; }

  async _onRender() {
    this.element.querySelector(".pfm-merchant-hero")?.addEventListener("change", (e) => { this.heroId = e.target.value; this.render(); });
    this.element.querySelector(".pfm-merchant-type")?.addEventListener("change", (e) => { this.typeFilter = e.target.value; this.render(); });
  }

  /** Re-render when the merchant's stock or the hero's purse changes, from this client or the GM's. */
  async _onFirstRender() {
    // The whole window is the drop zone for selling. The frame survives re-renders, so bind it once.
    this.element.addEventListener("dragover", (e) => e.preventDefault());
    this.element.addEventListener("drop", (e) => this.#onDrop(e));
    const watch = (doc) => doc === this.merchant || doc.id === this.heroId || doc.parent === this.merchant || doc.parent?.id === this.heroId;
    const rerender = (doc) => { if (watch(doc)) this.render(); };
    for (const hook of ["updateActor", "createItem", "updateItem", "deleteItem"]) this.hookIds.push([hook, Hooks.on(hook, rerender)]);
  }

  _onClose(options) {
    for (const [hook, id] of this.hookIds.splice(0)) Hooks.off(hook, id);
    super._onClose(options);
  }

  /** Send a trade to the GM: a warning if it fails, a note while the GM decides. */
  async #trade(request) {
    this.busy = true;
    this.render();
    const result = await requestTrade(this.moduleId, request, { onPending: () => ui.notifications.info(L("Waiting")) });
    this.busy = false;
    if (!result.ok) ui.notifications.warn(L(`Reason.${result.reason}`));
    this.render();
    return result;
  }

  /** Drop an item from a hero's sheet to sell it. A stack asks how many; a single item asks to confirm. */
  async #onDrop(event) {
    event.preventDefault();
    const drop = foundry.applications.ux.TextEditor.getDragEventData(event);
    if (drop?.type !== "Item") return;
    const item = await fromUuid(drop.uuid);
    const hero = item?.parent;
    if (hero?.type !== "hero" || !hero.isOwner) { ui.notifications.warn(L("Reason.notYours")); return; }
    const data = merchantData(this.moduleId, this.merchant);
    const unit = priceFor(item.system.price, data.sellRate);
    const have = item.system.quantity ?? 1;
    const title = L("SellTitle", { item: item.name });
    let quantity = 1;
    if (isStackable(item) && have > 1) {
      // DialogV2.input resolves to the form data, or null when closed (v14 docs).
      const answer = await DialogV2.input({
        window: { title },
        content: `<p>${esc(L("SellEach", { price: coin(unit) }))}</p><input type="number" name="quantity" min="1" max="${have}" value="${have}" autofocus>`,
        rejectClose: false
      });
      if (!answer) return;
      quantity = Math.floor(Number(answer.quantity));
    } else if (!(await DialogV2.confirm({ window: { title }, content: `<p>${esc(L("SellConfirm", { item: item.name, price: coin(unit) }))}</p>`, rejectClose: false }))) {
      return;
    }
    await this.#trade({ action: "sell", merchantId: this.merchant.id, actorId: hero.id, itemId: item.id, quantity });
  }

  static async #onBuy(_event, target) {
    const quantity = Number(target.closest(".pfm-merchant-row")?.querySelector(".pfm-merchant-qty")?.value ?? 1);
    await this.#trade({ action: "buy", merchantId: this.merchant.id, actorId: this.heroId, source: target.dataset.source, id: target.dataset.id, quantity });
  }
}
