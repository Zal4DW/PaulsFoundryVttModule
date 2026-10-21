// Crucible Party Stash and Item Piles together: loot goes from a pile window into the party stash.
//
// Two problems, both because a player does not own the pile:
// - Dragging a pile item onto the stash adds it, then the stash module's delete of the source fails with a permission
//   error, leaving a duplicate. Item Piles' own removeItems runs on the GM's client, so pile removals go through it.
// - The pile window has Take, which gives the item to the player's character, but no way to put loot or coin straight
//   into the stash. Each row gets a "to stash" button.
import { pileRemovals, clampQuantity } from "./lib/stash-bridge.mjs";

const STASH_ID = "crucible-party-stash";
let stash = null; // The stash module's data helpers, imported from its own file so its write lock is shared.

export function registerStashBridge() {
  Hooks.once("ready", async () => {
    if (!game.modules.get(STASH_ID)?.active || !game.modules.get("item-piles")?.active) return;
    try {
      stash = await import(foundry.utils.getRoute(`modules/${STASH_ID}/scripts/stash-data.mjs`));
    } catch (err) {
      console.warn("pauls-foundry-module | Crucible Party Stash helpers not found, stash bridge is off", err);
      return;
    }
    if (!game.user.isGM) routePileRemovals();
    Hooks.on("renderItemPileInventoryApp", (app) => watchPileWindow(app));
  });
}

const isPileNotOwned = (actor) => !actor.isOwner && !!game.itempiles?.API?.isValidItemPile(actor);

/** On player clients, item deletes and quantity drops on a pile they don't own go through Item Piles as the GM. */
function routePileRemovals() {
  const proto = CONFIG.Actor.documentClass.prototype;
  for (const [method, kind] of [["deleteEmbeddedDocuments", "delete"], ["updateEmbeddedDocuments", "update"]]) {
    const original = proto[method];
    proto[method] = async function (embeddedName, changes = [], operation = {}) {
      if (embeddedName === "Item" && isPileNotOwned(this)) {
        const quantityOf = (id) => {
          const item = this.items.get(id);
          return item ? (item.system.quantity ?? 1) : undefined;
        };
        const removals = pileRemovals(kind, changes, quantityOf);
        if (removals) {
          const items = removals.map((r) => this.items.get(r._id));
          await game.itempiles.API.removeItems(this, removals);
          return items;
        }
      }
      return original.call(this, embeddedName, changes, operation);
    };
  }
}

/** Add a "to stash" button beside every Take button, including rows Item Piles draws later. */
function watchPileWindow(app) {
  const el = app.element?.[0] ?? app.element;
  if (!el || el.dataset.pfmStash) return;
  el.dataset.pfmStash = "1";
  const decorate = () => {
    for (const row of el.querySelectorAll(".item-piles-item-row")) {
      const take = row.querySelector(".item-piles-item-take-button:not(.pfm-to-stash)");
      if (!take || row.querySelector(".pfm-to-stash")) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "item-piles-item-take-button pfm-to-stash";
      button.dataset.tooltip = game.i18n.localize("PFM.Stash.Send");
      button.innerHTML = `<i class="fas fa-box-open"></i>`;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        sendRow(app, row).catch((err) => {
          console.error("pauls-foundry-module | Send to stash failed", err);
          ui.notifications.error(game.i18n.localize("PFM.Stash.Failed"));
        });
      });
      take.after(button);
    }
  };
  decorate();
  new MutationObserver(decorate).observe(el, { childList: true, subtree: true });
}

/** An item row's own dragstart handler puts the item's uuid on the drag data. A currency row is not draggable. */
function rowItemUuid(row) {
  if (!row.draggable) return null;
  const dataTransfer = new DataTransfer();
  row.dispatchEvent(new DragEvent("dragstart", { dataTransfer }));
  try {
    return JSON.parse(dataTransfer.getData("text/plain")).uuid ?? null;
  } catch {
    return null;
  }
}

async function sendRow(app, row) {
  const party = globalThis.crucible?.party;
  if (!party) return ui.notifications.warn(game.i18n.localize("PFM.Stash.NoParty"));
  const pile = app.actor;
  const wanted = Number(row.querySelector("input.item-piles-quantity")?.value);
  const uuid = rowItemUuid(row);
  if (uuid) return sendItem(pile, party, await fromUuid(uuid), wanted);
  return sendCopper(pile, party, wanted);
}

async function sendItem(pile, party, item, wanted) {
  if (!item) return;
  const quantity = clampQuantity(wanted, item.system.quantity ?? 1);
  if (!quantity) return;
  const data = item.toObject();
  delete data._id;
  data.system.quantity = quantity;

  // Check room first, so nothing leaves the pile that the stash cannot hold.
  const entries = stash._getStash(party);
  const merges = stash._isStackable(data) && entries.some((e) => stash._stashEntryMatches(e, data));
  const cap = stash._checkStashCapacity(entries);
  if (!merges && !cap.ok) return ui.notifications.warn(game.i18n.format("CRUCIBLE_PARTY_STASH.StashFull", { capacity: cap.max }));

  await game.itempiles.API.removeItems(pile, [{ _id: item.id, quantity }]);
  await stash._withStashLock(party.id, async () => {
    const s = stash._getStash(party);
    const i = stash._isStackable(data) ? s.findIndex((e) => stash._stashEntryMatches(e, data)) : -1;
    if (i !== -1) s[i].system.quantity = (s[i].system.quantity ?? 1) + quantity;
    else s.push({ ...data, _stashId: foundry.utils.randomID() });
    await stash._setStash(party, s);
  });
  ui.notifications.info(game.i18n.format("PFM.Stash.Sent", { name: quantity > 1 ? `${item.name} ×${quantity}` : item.name }));
}

/** Crucible keeps all coin as copper in system.currency, which the module's Item Piles setup shows as one Copper row. */
async function sendCopper(pile, party, wanted) {
  const amount = clampQuantity(wanted, pile.system.currency ?? 0);
  if (!amount) return;
  await game.itempiles.API.removeCurrencies(pile, `${amount}cp`);
  await stash._addCurrency(party, { cp: amount });
  ui.notifications.info(game.i18n.format("PFM.Stash.Sent", { name: `${amount} cp` }));
}
