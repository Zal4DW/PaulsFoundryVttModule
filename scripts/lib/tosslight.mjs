// Reveal's "tosslight" for Crucible: a ball of light, bright 20 ft and dim 40 ft, one per caster.
// Crucible 0.11 automates light for the Torch, Lantern and Luminous affix, but not for Reveal. Pure logic: no Foundry globals.

/** Crucible's action id for the Reveal spell (Rune of Illumination). */
export const REVEAL_ACTION = "reveal";

/**
 * Token light for a tosslight. Same shape as Crucible's LANTERN_LIGHT and TORCH_LIGHT, with Reveal's radii
 * and a pale, steady glow instead of a flame.
 */
export const TOSSLIGHT_LIGHT = Object.freeze({ alpha: 0.6, angle: 360, bright: 20, color: "#fff2c8", coloration: 1, dim: 40,
  attenuation: 0.5, luminosity: 0.5, saturation: 0, contrast: 0, shadows: 0, negative: false, priority: 0,
  animation: Object.freeze({ type: "pulse", speed: 1, intensity: 1, reverse: false }), darkness: Object.freeze({ min: 0, max: 1 }) });

/** True when the change to a chat message is the GM confirming a Reveal card. */
export function isRevealConfirm(crucibleFlags, changed) {
  if (crucibleFlags?.action?.id !== REVEAL_ACTION) return false;
  return changed?.flags?.crucible?.confirmed === true;
}

/**
 * Crucible action hooks that let Reveal target its caster. Crucible ships Reveal as a single-target action with
 * `target.self: false`, so its use dialog refuses the caster's own token and refuses an empty target list too.
 * The spell says the tosslight "can hover near your body", so the caster is a fair target. With `self` on, Crucible
 * accepts the caster's token as the target, and with nothing targeted it targets the caster.
 * @param {object} [existing]          Hooks already registered for Reveal; their `prepare` still runs first.
 * @param {() => boolean} [enabled]    Read at each prepare, so the setting can change without a reload.
 * @returns {object} Hooks for `crucible.api.hooks.action.reveal`.
 */
export function revealSelfTargetHooks(existing = {}, enabled = () => true) {
  const prior = existing.prepare;
  return {
    ...existing,
    prepare() {
      if (prior instanceof Function) prior.call(this);
      if (enabled()) this.target.self = true;
    }
  };
}

/** The token the tosslight goes on: the card's first target, or the caster when nothing was targeted. */
export function tosslightTokenUuid(crucibleFlags) {
  return crucibleFlags?.targets?.find((t) => t.token)?.token ?? crucibleFlags?.token ?? null;
}

/** A token has its own light when either radius is set, the same test Crucible's Torch and Lantern use. */
export const hasOwnLight = (light) => (light?.bright ?? 0) !== 0 || (light?.dim ?? 0) !== 0;

/**
 * What placing a caster's tosslight on a token needs.
 * @param {object} target
 * @param {string} target.uuid
 * @param {object} target.light          The token's current light.
 * @param {object|null} target.tosslight The token's tosslight flag, if it already carries one.
 * @param {string} casterUuid            The caster's actor uuid.
 * @param {{uuid: string, caster: string}[]} lit  Tokens that carry a tosslight now.
 * @returns {{place: boolean, clear: string[], reason?: "ownLight"|"taken"}}
 *   `clear` lists the tokens whose tosslight this caster loses, because a caster has only one at a time.
 */
export function planTosslight(target, casterUuid, lit) {
  const clear = lit.filter((t) => t.caster === casterUuid && t.uuid !== target.uuid).map((t) => t.uuid);
  if (target.tosslight) {
    // Recasting on the same token keeps its light. Another caster's tosslight is left alone.
    if (target.tosslight.caster === casterUuid) return { place: false, clear };
    return { place: false, clear, reason: "taken" };
  }
  if (hasOwnLight(target.light)) return { place: false, clear, reason: "ownLight" };
  return { place: true, clear };
}
