// A "Change Grip" button for Versatile weapons on Crucible actor sheets.
// Crucible 0.11 gives a Versatile weapon its sibling category's stats in the two-hand slot
// (CrucibleWeaponData#activeCategory), but its sheet's Equip button never passes a slot, so a
// Bastard Sword always equips one-handed. Changing grip is free (0 AP), so this sets the slot directly.
import { gripChange, SLOTS } from "./lib/grip.mjs";

/** The facts gripChange needs about a weapon on this actor. */
function weaponState(actor, item) {
  const category = item.config?.category ?? {};
  const { mainhand, offhand } = actor.equipment?.weapons ?? {};
  // The other hand is free when its slot holds no real item (Crucible fills an empty main hand with an unarmed stub).
  const other = item.system.slot === SLOTS.OFFHAND ? mainhand : offhand;
  const otherHandFree = !other?.id || other.id === item.id;
  return {
    weapon: {
      versatile: item.system.properties.has("versatile"),
      natural: item.system.properties.has("natural"),
      hasSibling: !!globalThis.SYSTEM?.WEAPON?.CATEGORIES?.[category.sibling],
      equipped: item.system.equipped,
      slot: item.system.slot
    },
    otherHandFree
  };
}

/** Switch a Versatile weapon between one hand and two. */
export async function toggleGrip(item) {
  const actor = item.parent;
  const { weapon, otherHandFree } = weaponState(actor, item);
  const result = gripChange(weapon, otherHandFree);
  if (result.error) {
    ui.notifications.warn(game.i18n.format(`PFM.Grip.Error.${result.error}`, { item: item.name }));
    return null;
  }
  await item.update({ "system.slot": result.slot });
  ui.notifications.info(game.i18n.format(`PFM.Grip.Changed${result.hands}`, { actor: actor.name, item: item.name }));
  return result;
}

/** Add the button to each equipped Versatile weapon's row whenever a Crucible actor sheet renders. */
export function registerGripToggle() {
  // ApplicationV2 fires render{ClassName} for each class in the chain; CrucibleBaseActorSheet covers heroes and adversaries.
  Hooks.on("renderCrucibleBaseActorSheet", (app, element) => {
    if (!app.isEditable) return;
    const actor = app.document;
    for (const item of actor.items) {
      if (item.type !== "weapon" || !item.system.equipped || !item.system.properties?.has("versatile")) continue;
      const controls = element.querySelector(`.line-item[data-item-id="${item.id}"] .controls`);
      if (!controls || controls.querySelector(".pfm-grip")) continue;
      const twoHanded = item.system.slot === SLOTS.TWOHAND;
      const label = game.i18n.localize(twoHanded ? "PFM.Grip.ToOne" : "PFM.Grip.ToTwo");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `icon fa-solid ${twoHanded ? "fa-hand" : "fa-hands"} pfm-grip`;
      button.setAttribute("aria-label", label);
      button.dataset.tooltip = "";
      button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); toggleGrip(item); });
      controls.prepend(button);
    }
  });
}
