// "Dose of It'll Be Alright..." for Crucible: a drug that clears Madness and builds an addiction. Pure logic: no Foundry globals.
//
// A dose heals at the hero's current addiction level, then adds its own addiction. The penalty grows by one more
// each level (1, 3, 6, 10, 15 ...), so cheap doses stop working fast and only stronger ones get through.
// A Rest takes 1 level off only if the hero took no dose since the last Rest: a night on the stuff holds the level.
// Like the Wound Medical Kit, the dose has Crucible's "rest" tag, so a hero takes at most one per Rest.

/** The dose's action id. Crucible looks up action hooks by this id in crucible.api.hooks.action. */
export const DOSE_ACTION = "pfmAlrightDose";

/** Madness a dose clears at addiction 0, by Crucible quality bonus (shoddy -2, standard 0, fine 1, superior 2, masterwork 3). */
export const DOSE_HEALING = Object.freeze({ "-2": 1, 0: 5, 1: 10, 2: 20, 3: 40 });

/** Addiction levels a dose adds, by quality bonus. Stronger stuff packs more. */
export const DOSE_ADDICTION = Object.freeze({ "-2": 1, 0: 2, 1: 3, 2: 4, 3: 5 });

/** Madness taken off a dose at this addiction level: the triangular number L(L+1)/2. */
export const addictionPenalty = (level) => (level > 0 ? (level * (level + 1)) / 2 : 0);

/** Madness a dose clears: its strength less the addiction penalty, never below 0 and never more than the hero has. */
export function doseHealing(qualityBonus, level, currentMadness) {
  const base = DOSE_HEALING[qualityBonus] ?? DOSE_HEALING[0];
  return Math.max(0, Math.min(base - addictionPenalty(level ?? 0), currentMadness ?? 0));
}

/** Addiction after a dose of this quality bonus. */
export function afterDose(state, qualityBonus) {
  const add = DOSE_ADDICTION[qualityBonus] ?? DOSE_ADDICTION[0];
  return { level: (state?.level ?? 0) + add, dosed: true };
}

/** Addiction after a Rest: 1 level off for a clean night, none if the hero dosed since the last Rest. */
export function afterRest(state) {
  const level = state?.level ?? 0;
  return { level: state?.dosed ? level : Math.max(0, level - 1), dosed: false };
}

/** True when the change to a chat message is the GM confirming a card for this action id. */
export function isActionConfirm(crucibleFlags, changed, actionId) {
  return crucibleFlags?.action?.id === actionId && changed?.flags?.crucible?.confirmed === true;
}
