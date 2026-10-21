// Pure helpers for moving Item Piles loot into the Crucible Party Stash. No Foundry globals, so Vitest can test them.

/** Read an item quantity from update data that may use a flat "system.quantity" key or a nested object. */
function quantityIn(update) {
  if (Object.hasOwn(update, "system.quantity")) return update["system.quantity"];
  return update.system?.quantity;
}

/**
 * Turn the item deletes and quantity updates a caller wants on a pile into Item Piles removals.
 * Item Piles' removeItems takes {_id, quantity} and runs on the GM's client, so a player can empty a pile they don't own.
 * @param {"delete"|"update"} kind
 * @param {string[]|object[]} changes  Ids to delete, or update objects with an _id and a new quantity.
 * @param {(id: string) => number|undefined} quantityOf  The item's current quantity on the pile.
 * @returns {{_id: string, quantity: number}[]|null}  The removals, or null when a change is not a pure removal.
 */
export function pileRemovals(kind, changes, quantityOf) {
  const out = [];
  for (const change of changes) {
    if (kind === "delete") {
      const id = typeof change === "string" ? change : change?._id;
      const qty = quantityOf(id);
      if (!id || qty === undefined) return null;
      out.push({ _id: id, quantity: Math.max(1, qty) });
      continue;
    }
    // An update counts only if it lowers the quantity and changes nothing else.
    const keys = Object.keys(change ?? {}).filter((k) => k !== "_id");
    const onlyQuantity = keys.length > 0 && keys.every((k) => k === "system.quantity" || (k === "system" && Object.keys(change.system).length === 1));
    const next = quantityIn(change ?? {});
    const current = quantityOf(change?._id);
    if (!onlyQuantity || typeof next !== "number" || current === undefined || next >= current) return null;
    out.push({ _id: change._id, quantity: current - next });
  }
  return out;
}

/**
 * Clamp a chosen quantity to what the pile holds.
 * @param {number} wanted  The number in the pile window's quantity box, or NaN when there is none.
 * @param {number} available
 */
export function clampQuantity(wanted, available) {
  if (!Number.isFinite(available) || available <= 0) return 0;
  if (!Number.isFinite(wanted) || wanted <= 0) return available;
  return Math.min(Math.floor(wanted), available);
}
