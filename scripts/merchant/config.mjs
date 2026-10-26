// The GM's merchant setup window: rates, approval, and the catalogue. Items dropped on it become catalogue lines.
// Held items are the merchant actor's own items: drop them on its sheet, and they list here.
import { normaliseMerchant } from "../lib/merchant.mjs";
import { merchantData } from "./trade.mjs";

const { ApplicationV2 } = foundry.applications.api;
const L = (key, data) => (data ? game.i18n.format(`PFM.Merchant.${key}`, data) : game.i18n.localize(`PFM.Merchant.${key}`));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const coin = (cp) => globalThis.crucible?.api?.documents?.CrucibleItem?.formatCurrency?.(cp) ?? `${cp}cp`;

export class MerchantConfig extends ApplicationV2 {
  constructor(moduleId, actor, options = {}) {
    super({ ...options, id: `pfm-merchant-config-${actor.id}` });
    this.moduleId = moduleId;
    this.actor = actor;
    // Edits stay here until Save, so a half-typed count doesn't trade. To tell the GM's edits from changes trades made
    // while the window was open, #sync compares the form with `base`: the stored data as it was when the form was last
    // drawn. `stored` is the newest stored data, which becomes `base` once a render has put it in the form. `known` is
    // the stored catalogue line ids at the last sync, to tell a line deleted elsewhere from one added here.
    this.data = foundry.utils.deepClone(merchantData(moduleId, actor) ?? normaliseMerchant({ sellRate: 50 }));
    this.base = foundry.utils.deepClone(this.data);
    this.stored = foundry.utils.deepClone(this.data);
    this.known = new Set(this.data.catalogue.map((l) => l.id));
  }

  static DEFAULT_OPTIONS = {
    classes: ["pfm-merchant", "pfm-merchant-config"],
    tag: "form",
    window: { icon: "fa-solid fa-store", resizable: true },
    position: { width: 600, height: 680 },
    form: { handler: MerchantConfig.#onSubmit, closeOnSubmit: false, submitOnChange: false },
    actions: { remove: MerchantConfig.#onRemove, removeHeld: MerchantConfig.#onRemoveHeld, invite: MerchantConfig.#onInvite, open: MerchantConfig.#onOpen }
  };

  get title() { return L("SetupTitle", { name: this.actor.name }); }

  async _prepareContext() {
    const lines = [];
    for (const line of this.data.catalogue) lines.push({ line, item: await fromUuid(line.uuid) });
    return { data: this.data, lines, held: [...this.actor.items], base: foundry.utils.deepClone(this.stored) };
  }

  // The form now shows what this render prepared. Until then, #sync compares with the previous render's stored data.
  _onRender(context, options) {
    super._onRender(context, options);
    this.base = context.base;
  }

  async _renderHTML({ data, lines, held }) {
    const row = ({ line, item }) => `<li class="pfm-merchant-config-row">
      <img src="${esc(item?.img ?? "icons/svg/hazard.svg")}" alt=""><span class="pfm-merchant-name">${esc(item?.name ?? L("MissingItem"))}</span>
      <span class="pfm-merchant-price" data-tooltip="${esc(L("ListPrice"))}">${esc(coin(item?.system?.price ?? 0))}</span>
      <input type="number" name="count.${line.id}" min="0" value="${line.count ?? ""}" placeholder="∞" data-tooltip="${esc(L("CountHint"))}">
      <input type="number" name="price.${line.id}" min="0" value="${line.price ?? ""}" placeholder="${esc(L("RatePrice"))}" data-tooltip="${esc(L("PriceHint"))}">
      <button type="button" data-action="remove" data-id="${line.id}" data-tooltip="${esc(L("Remove"))}"><i class="fa-solid fa-trash"></i></button></li>`;
    const heldRow = (item) => `<li class="pfm-merchant-config-row held">
      <img src="${esc(item.img)}" alt=""><span class="pfm-merchant-name">${esc(item.name)}</span>
      <span class="pfm-merchant-price">${esc(coin(item.system.price ?? 0))}</span><span>×${item.system.quantity ?? 1}</span><span></span>
      <button type="button" data-action="removeHeld" data-id="${item.id}" data-tooltip="${esc(L("Remove"))}"><i class="fa-solid fa-trash"></i></button></li>`;
    return `<fieldset class="pfm-merchant-settings">
        <label><input type="checkbox" name="enabled" ${data.enabled ? "checked" : ""}> ${esc(L("Enabled"))}</label>
        <label>${esc(L("BuyRate"))} <input type="number" name="buyRate" min="0" max="1000" value="${data.buyRate}">%</label>
        <label>${esc(L("SellRate"))} <input type="number" name="sellRate" min="0" max="1000" value="${data.sellRate}">%</label>
        <label><input type="checkbox" name="requireApproval" ${data.requireApproval ? "checked" : ""}> ${esc(L("RequireApproval"))}</label>
      </fieldset>
      <h4>${esc(L("Catalogue"))}</h4>
      <ul class="pfm-merchant-config-list">${lines.map(row).join("") || `<li class="pfm-empty">${esc(L("CatalogueEmpty"))}</li>`}</ul>
      <p class="pfm-merchant-drop"><i class="fa-solid fa-box-open"></i> ${esc(L("DropToList"))}</p>
      <h4>${esc(L("Held"))}</h4>
      <ul class="pfm-merchant-config-list">${held.map(heldRow).join("") || `<li class="pfm-empty">${esc(L("HeldEmpty"))}</li>`}</ul>
      <footer class="pfm-merchant-config-buttons">
        <button type="button" data-action="open"><i class="fa-solid fa-scale-balanced"></i> ${esc(L("Open"))}</button>
        <button type="button" data-action="invite"><i class="fa-solid fa-bullhorn"></i> ${esc(L("InviteAll"))}</button>
        <button type="submit"><i class="fa-solid fa-floppy-disk"></i> ${esc(L("Save"))}</button>
      </footer>`;
  }

  _replaceHTML(result, content) { content.innerHTML = result; }

  async _onFirstRender() {
    this.element.addEventListener("dragover", (e) => e.preventDefault());
    this.element.addEventListener("drop", (e) => this.#onDrop(e));
    this.hookId = Hooks.on("updateActor", (doc) => { if (doc === this.actor) { this.#sync(); this.render(); } });
    for (const hook of ["createItem", "updateItem", "deleteItem"]) (this.itemHooks ??= []).push([hook, Hooks.on(hook, (doc) => { if (doc.parent === this.actor) this.render(); })]);
  }

  _onClose(options) {
    Hooks.off("updateActor", this.hookId);
    for (const [hook, id] of this.itemHooks ?? []) Hooks.off(hook, id);
    super._onClose(options);
  }

  /** Copy what the form shows into this.data, so a re-render (after a drop or a removal) keeps typed values. */
  #readForm() {
    const form = this.element;
    if (!form?.elements) return;
    const num = (name) => form.elements[name]?.value;
    this.data.enabled = !!form.elements.enabled?.checked;
    this.data.requireApproval = !!form.elements.requireApproval?.checked;
    this.data.buyRate = Number(num("buyRate"));
    this.data.sellRate = Number(num("sellRate"));
    for (const line of this.data.catalogue) {
      // A line the form doesn't show yet keeps its values.
      if (!form.elements[`count.${line.id}`]) continue;
      const count = num(`count.${line.id}`);
      const price = num(`price.${line.id}`);
      line.count = count === "" || count === undefined ? null : Number(count);
      line.price = price === "" || price === undefined ? null : Number(price);
    }
    this.data = normaliseMerchant(this.data);
  }

  /**
   * Start again from the stored data and reapply only what the GM changed in the form. A trade made while the window
   * is open changes stock counts and the log, and Save must not put back the counts or drop the log entries.
   */
  #sync() {
    this.#readForm();
    this.stored = foundry.utils.deepClone(merchantData(this.moduleId, this.actor) ?? this.stored);
    const fresh = foundry.utils.deepClone(this.stored);
    // A value the form never showed can't have been edited, so the stored value wins.
    const edited = (now, was, key) => !!was && now[key] !== was[key];
    for (const key of ["enabled", "requireApproval", "buyRate", "sellRate"]) if (edited(this.data, this.base, key)) fresh[key] = this.data[key];
    const shownLine = (id) => this.base.catalogue.find((l) => l.id === id);
    const catalogue = this.data.catalogue.flatMap((line) => {
      const stored = fresh.catalogue.find((l) => l.id === line.id);
      // Not stored: keep a line the GM added here, drop one deleted elsewhere.
      if (!stored) return this.known.has(line.id) ? [] : [line];
      const was = shownLine(line.id);
      return [{ ...stored, count: edited(line, was, "count") ? line.count : stored.count, price: edited(line, was, "price") ? line.price : stored.price }];
    });
    // Lines listed elsewhere since the last sync stay, unless the GM removed them here.
    for (const line of fresh.catalogue) if (!this.known.has(line.id) && !catalogue.some((l) => l.id === line.id)) catalogue.push(line);
    this.data = { ...fresh, catalogue };
    this.known = new Set(fresh.catalogue.map((l) => l.id));
  }

  /** Drop an item from a compendium or the Items sidebar to list it. An item already listed isn't added twice. */
  async #onDrop(event) {
    event.preventDefault();
    const drop = foundry.applications.ux.TextEditor.getDragEventData(event);
    if (drop?.type !== "Item" || !drop.uuid) return;
    const item = await fromUuid(drop.uuid);
    if (!item || item.parent) { ui.notifications.warn(L("DropFromCompendium")); return; }
    this.#readForm();
    if (!this.data.catalogue.some((l) => l.uuid === item.uuid)) this.data.catalogue.push({ id: foundry.utils.randomID(), uuid: item.uuid, count: null, price: null });
    this.render();
  }

  static #onRemove(_event, target) {
    this.#readForm();
    this.data.catalogue = this.data.catalogue.filter((l) => l.id !== target.dataset.id);
    this.render();
  }

  static async #onRemoveHeld(_event, target) {
    this.#readForm();
    await this.actor.items.get(target.dataset.id)?.delete();
  }

  static async #onSubmit() {
    this.#sync();
    await game.modules.get(this.moduleId).api.setMerchant(this.actor, this.data);
    ui.notifications.info(L("Saved", { name: this.actor.name }));
  }

  static async #onInvite() {
    if (!merchantData(this.moduleId, this.actor)) { ui.notifications.warn(L("SaveFirst")); return; }
    await game.modules.get(this.moduleId).api.inviteToMerchant(this.actor);
  }

  static #onOpen() {
    if (!merchantData(this.moduleId, this.actor)) { ui.notifications.warn(L("SaveFirst")); return; }
    game.modules.get(this.moduleId).api.openMerchant(this.actor);
  }
}
