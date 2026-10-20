// Wound Medical Kit for Crucible: treat Wounds during a long rest. Pure logic: no Foundry globals.
// Crucible's own Rest removes only level-many Wounds, so heroes carry Wounds from fight to fight.
// The kit's action has Crucible's "rest" tag, so it can only follow the hero's Rest action, which is once per 10 hour rest.

/** The kit's action id. Crucible looks up action hooks by this id in crucible.api.hooks.action. */
export const WOUND_KIT_ACTION = "pfmWoundKit";

/**
 * Wounds healed by quality bonus (Crucible's QUALITY_TIERS: shoddy -2, standard 0, fine 1, superior 2, masterwork 3).
 * Standard matches Briannon's temple service in Ember (5 Wounds for 1 gp). Like Crucible's elixirs, shoddy is half
 * (rounded up) and each tier above standard doubles.
 */
export const WOUND_KIT_HEALING = Object.freeze({ "-2": 3, 0: 5, 1: 10, 2: 20, 3: 40 });

/** Wounds a kit of this quality bonus removes, capped at the Wounds the target has, so a reversal restores exactly. */
export function woundsHealed(qualityBonus, currentWounds) {
  const amount = WOUND_KIT_HEALING[qualityBonus] ?? WOUND_KIT_HEALING[0];
  return Math.max(0, Math.min(amount, currentWounds ?? 0));
}
