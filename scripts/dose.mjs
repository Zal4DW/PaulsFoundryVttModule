// "Dose of It'll Be Alright..." on Crucible actors. The dose's action hook clears Madness at the hero's current addiction level.
// When the GM confirms the card, the addiction from the dose goes on, so it never weakens the dose that caused it.
// When the GM confirms a Rest card, the addiction drops by 1 unless the hero dosed since the last Rest.
// Addiction lives on an "Addicted (N)" Active Effect, so players see it on the sheet.
import { afterDose, afterRest, isActionConfirm, DOSE_ACTION, doseHealing } from "./lib/dose.mjs";

/** The addiction effect's id, fixed so each actor has at most one. */
const EFFECT_ID = "pfmAddiction0000";
const ICON = "modules/pauls-foundry-module/assets/icons/alright-dose.webp";

const isActiveGM = () => game.user.isGM && game.users.activeGM?.id === game.user.id;

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
    postActivate() {
      const bonus = this.usage.consumable?.config?.quality?.bonus ?? 0;
      for (const [target] of this.targets) {
        const delta = doseHealing(bonus, getAddiction(moduleId, target).level, target.system.resources.madness?.value);
        if (delta > 0) this.recordEvent({ target, resources: [{ resource: "madness", delta: -delta }] });
      }
    }
  };

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
