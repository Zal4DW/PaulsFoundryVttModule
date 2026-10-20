// "Dose of It'll Be Alright..." on Crucible actors. The dose's action hook clears Madness at the hero's current addiction level.
// When the GM confirms the card, the addiction from the dose goes on, so it never weakens the dose that caused it.
// When the GM confirms a Rest card, the addiction drops by 1 unless the hero dosed since the last Rest.
// A dose that breaks Insanity leaves "Fragile Calm": the next Rest restores no Madness, so the cure buys no free recovery.
// Addiction lives on an "Addicted (N)" Active Effect, so players see it on the sheet.
import { afterDose, afterRest, canTakeDose, isActionConfirm, DOSE_ACTION, doseHealing, withoutMadnessRecovery } from "./lib/dose.mjs";

/** The addiction effect's id, fixed so each actor has at most one. */
const EFFECT_ID = "pfmAddiction0000";
const ICON = "modules/pauls-foundry-module/assets/icons/alright-dose.webp";

/** The Fragile Calm effect's id: a dose broke this hero's Insanity, so their next Rest restores no Madness. */
const CALM_ID = "pfmFragileCalm00";

const isActiveGM = () => game.user.isGM && game.users.activeGM?.id === game.user.id;

/** Fragile Calm, as Active Effect data for an action event. */
const fragileCalm = (origin) => ({
  _id: CALM_ID,
  name: game.i18n.localize("PFM.Dose.FragileCalm"),
  description: game.i18n.localize("PFM.Dose.FragileCalmHint"),
  img: ICON,
  origin: origin?.uuid
});

/** An actor's addiction state, or level 0 when it has none. */
export function getAddiction(moduleId, actor) {
  return actor?.effects.get(EFFECT_ID)?.getFlag(moduleId, "addiction") ?? { level: 0, dosed: false };
}

/** Write an actor's addiction state: update the effect, create it, or remove it at level 0. */
export async function setAddiction(moduleId, actor, state) {
  const effect = actor.effects.get(EFFECT_ID);
  if (state.level <= 0 && !state.dosed) return effect?.delete();
  const data = {
    name: game.i18n.format("PFM.Dose.Addicted", { level: state.level }),
    description: game.i18n.localize("PFM.Dose.AddictedHint"),
    [`flags.${moduleId}.addiction`]: state
  };
  if (effect) return effect.update(data);
  return actor.createEmbeddedDocuments("ActiveEffect", [{ _id: EFFECT_ID, img: ICON, ...foundry.utils.expandObject(data) }], { keepId: true });
}

/** The actors a confirmed card affects: its targets, or the actor who used it when it has none. */
async function cardActors(flags) {
  const uuids = flags.targets?.length ? flags.targets.map((t) => t.actor) : [flags.actor];
  const docs = await Promise.all(uuids.filter(Boolean).map((u) => fromUuid(u)));
  return docs.filter((a) => a?.documentName === "Actor");
}

export function registerDose(moduleId) {
  const hooks = globalThis.crucible?.api?.hooks?.action;
  if (!hooks) return;
  hooks[DOSE_ACTION] = {
    // In place of Crucible's "rest" tag, which would block an Insane hero for good: they can never Rest.
    canUse() {
      if (!canTakeDose({ insane: this.actor.system.isInsane, lastActionId: this.actor.lastConfirmedAction?.id })) {
        throw new Error(game.i18n.format("PFM.Dose.AfterRestOrInsane", { action: this.name }));
      }
    },
    postActivate() {
      const bonus = this.usage.consumable?.config?.quality?.bonus ?? 0;
      for (const [target] of this.targets) {
        const delta = doseHealing(bonus, getAddiction(moduleId, target).level, target.system.resources.madness?.value);
        // A dose that breaks Insanity marks the hero, so the Rest it unlocks restores no Madness (see the rest hook below).
        const effects = delta > 0 && target.system.isInsane ? [fragileCalm(this.actor)] : [];
        if (delta > 0) this.recordEvent({ target, resources: [{ resource: "madness", delta: -delta }], effects });
      }
    }
  };

  // Wrap Crucible's own Rest hook. Its recovery is unchanged, except for a hero with Fragile Calm: that Rest restores
  // no Madness and ends the Fragile Calm. Both go in the Rest card's events, so confirming applies them and a
  // reversal undoes them.
  const rest = hooks.rest;
  if (rest?.postActivate) {
    hooks.rest = {
      ...rest,
      postActivate() {
        rest.postActivate.call(this);
        if (!this.actor.effects.has(CALM_ID)) return;
        const activation = this.selfEvents.activation;
        activation.resources = withoutMadnessRecovery(activation.resources);
        activation.effects.push({ _id: CALM_ID, _action: "delete" });
      }
    };
  }

  // updateChatMessage fires on every client; only the active GM writes the addiction, so it changes once.
  Hooks.on("updateChatMessage", async (message, changed) => {
    if (!isActiveGM()) return;
    const flags = message.flags?.crucible;
    if (isActionConfirm(flags, changed, DOSE_ACTION)) {
      const bonus = qualityBonus(message);
      for (const actor of await cardActors(flags)) await setAddiction(moduleId, actor, afterDose(getAddiction(moduleId, actor), bonus));
    } else if (isActionConfirm(flags, changed, "rest")) {
      for (const actor of await cardActors({ actor: flags.actor })) {
        if (actor.effects.has(EFFECT_ID)) await setAddiction(moduleId, actor, afterRest(getAddiction(moduleId, actor)));
      }
    }
  });
}

/** The quality bonus of the dose a confirmed card used, read back from the action on the card. */
function qualityBonus(message) {
  const action = globalThis.crucible.api.models.CrucibleAction.fromChatMessage(message);
  return action?.item?.config?.quality?.bonus ?? action?.usage?.consumable?.config?.quality?.bonus ?? 0;
}
