// Grip changes for Versatile weapons (a Bastard Sword in one hand or two). Pure logic: no Foundry globals.

/** Crucible's weapon slots (SYSTEM.WEAPON.SLOTS in Crucible 0.11). */
export const SLOTS = Object.freeze({ MAINHAND: 1, OFFHAND: 2, TWOHAND: 3 });

/**
 * Decide the grip a weapon switches to.
 * @param {object} weapon
 * @param {boolean} weapon.versatile     Has the Versatile property.
 * @param {boolean} [weapon.natural]     A natural weapon, which takes no slot.
 * @param {boolean} weapon.hasSibling    Its category names a sibling for the other grip.
 * @param {boolean} weapon.equipped
 * @param {number} weapon.slot           Its current slot in SLOTS.
 * @param {boolean} otherHandFree        The hand this weapon is not in holds nothing.
 * @returns {{slot: number, hands: 1|2}|{error: "notVersatile"|"notEquipped"|"handInUse"}}
 */
export function gripChange({ versatile, natural = false, hasSibling, equipped, slot }, otherHandFree) {
  if (!versatile || natural || !hasSibling) return { error: "notVersatile" };
  if (!equipped) return { error: "notEquipped" };
  if (slot === SLOTS.TWOHAND) return { slot: SLOTS.MAINHAND, hands: 1 };
  if (!otherHandFree) return { error: "handInUse" };
  return { slot: SLOTS.TWOHAND, hands: 2 };
}
