// "Dose of It'll Be Alright..." on Crucible actors. The dose's action hook clears Madness at the hero's current addiction level.
// When the GM confirms the card, the addiction from the dose goes on, so it never weakens the dose that caused it.
// When the GM confirms a Rest card, the addiction drops by 1 unless the hero dosed since the last Rest.
// A dose that breaks Insanity leaves "Fragile Calm": the next Rest restores no Madness, so the cure buys no free recovery.
// If Madness fills up again before that Rest, the calm shatters and the crash adds 1 addiction.
// An addicted hero who Rests without a dose wakes with "The Shakes": 1 bane on attacks, spells and checks for 4 hours.
// Any dose ends The Shakes.
// Addiction lives on an "Addicted (N)" Active Effect, so players see it on the sheet.
import { afterDose, afterRest, afterShatter, canTakeDose, isActionConfirm, isActionReverse, DOSE_ACTION, doseHealing, getsShakes, SHAKES_HOURS,
  withoutMadnessRecovery } from "./lib/dose.mjs";

/** The addiction effect's id, fixed so each actor has at most one. */
const EFFECT_ID = "pfmAddiction0000";
const ICON = "modules/pauls-foundry-module/assets/icons/alright-dose.webp";

/** The Fragile Calm effect's id: a dose broke this hero's Insanity, so their next Rest restores no Madness. */
const CALM_ID = "pfmFragileCalm00";

/** The Shakes effect's id: withdrawal after a clean Rest while addicted. */
const SHAKES_ID = "pfmTheShakes0000";
const SHAKES_ICON = "icons/svg/daze.svg";

const isActiveGM = () => game.user.isGM && game.users.activeGM?.id === game.user.id;

/** Fragile Calm, as Active Effect data for an action event. */
const fragileCalm = (origin) => ({
  _id: CALM_ID,
  name: game.i18n.localize("PFM.Dose.FragileCalm"),
  description: game.i18n.localize("PFM.Dose.FragileCalmHint"),
  img: ICON,
  origin: origin?.uuid
});

/**
 * Withdrawal: The Shakes, 1 bane on attacks, spells and checks for 4 hours of game time. Crucible reads banes from
 * system.rollBonuses.banes, the same way its own Hexed condition applies one. Recreated fresh on each clean Rest.
 */
async function addShakes(actor) {
  const name = game.i18n.localize("PFM.Dose.Shakes");
  await actor.effects.get(SHAKES_ID)?.delete();
  return actor.createEmbeddedDocuments("ActiveEffect", [{
    _id: SHAKES_ID, name, img: SHAKES_ICON,
    description: game.i18n.localize("PFM.Dose.ShakesHint"),
    start: { time: game.time.worldTime },
    duration: { value: SHAKES_HOURS, units: "hours" },
    system: {
      changes: [
        { key: "system.rollBonuses.banes.pfmShakes.number", type: "override", value: 1, phase: "initial" },
        { key: "system.rollBonuses.banes.pfmShakes.label", type: "override", value: name, phase: "initial" }
      ]
    }
  }], { keepId: true });
}

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

/**
 * An actor's addiction before a card changes it (null when they have none), and for a Rest card their Shakes too.
 * A dose card ends The Shakes through its own events, which Crucible reverses, so its snapshot leaves them out.
 */
function takeSnapshot(moduleId, actor, { shakes = false } = {}) {
  const snap = { addiction: actor.effects.has(EFFECT_ID) ? getAddiction(moduleId, actor) : null };
  if (shakes) snap.shakes = actor.effects.get(SHAKES_ID)?.toObject() ?? null;
  return snap;
}

/** Put back each actor's addiction and Shakes from a reversed card's snapshot, then clear it so a re-confirm applies again. */
async function restoreSnapshot(moduleId, message, snapshot) {
  for (const saved of snapshot) {
    const actor = await fromUuid(saved.uuid);
    if (!actor) continue;
    await setAddiction(moduleId, actor, saved.addiction ?? { level: 0, dosed: false });
    if (!("shakes" in saved)) continue;
    await actor.effects.get(SHAKES_ID)?.delete();
    if (saved.shakes) await actor.createEmbeddedDocuments("ActiveEffect", [saved.shakes], { keepId: true });
  }
  await message.unsetFlag(moduleId, "undo");
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
        const effects = [];
        // A dose that breaks Insanity marks the hero, so the Rest it unlocks restores no Madness (see the rest hook below).
        if (delta > 0 && target.system.isInsane) effects.push(fragileCalm(this.actor));
        // Any dose ends The Shakes, even one too weak to clear Madness: it feeds the craving.
        if (target.effects.has(SHAKES_ID)) effects.push({ _id: SHAKES_ID, _action: "delete" });
        const resources = delta > 0 ? [{ resource: "madness", delta: -delta }] : [];
        if (resources.length || effects.length) this.recordEvent({ target, resources, effects });
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
  // Before a confirmed dose or Rest card changes anything, the GM saves each actor's addiction and Shakes on the card.
  // Reversing the card puts them back. A card that already holds a snapshot is not applied twice.
  Hooks.on("updateChatMessage", async (message, changed) => {
    if (!isActiveGM()) return;
    const flags = message.flags?.crucible;
    const id = [DOSE_ACTION, "rest"].find((a) => flags?.action?.id === a);
    if (!id) return;
    const snapshot = message.getFlag(moduleId, "undo");
    if (isActionReverse(flags, changed, id)) {
      if (snapshot) await restoreSnapshot(moduleId, message, snapshot);
      return;
    }
    if (!isActionConfirm(flags, changed, id) || snapshot) return;
    const actors = await cardActors(id === "rest" ? { actor: flags.actor } : flags);
    // A list, not an object keyed by uuid: setFlag would split the dots in "Actor.abc" into nested keys.
    await message.setFlag(moduleId, "undo", actors.map((a) => ({ uuid: a.uuid, ...takeSnapshot(moduleId, a, { shakes: id === "rest" }) })));
    if (id === DOSE_ACTION) {
      const bonus = qualityBonus(message);
      for (const actor of actors) await setAddiction(moduleId, actor, afterDose(getAddiction(moduleId, actor), bonus));
    } else {
      for (const actor of actors) {
        if (!actor.effects.has(EFFECT_ID)) continue;
        const before = getAddiction(moduleId, actor);
        await setAddiction(moduleId, actor, afterRest(before));
        if (getsShakes(before)) await addShakes(actor);
      }
    }
  });

  // A party Rest advances the clock by 10 hours after the Rest cards, so The Shakes would start before the hero woke.
  // Restart them at the new world time once the Rest is over.
  Hooks.on("crucible.groupRest", async (_group, _config, participants) => {
    if (!isActiveGM()) return;
    for (const actor of participants ?? []) await actor.effects.get(SHAKES_ID)?.update({ "start.time": game.time.worldTime });
  });

  // Fragile Calm shatters when Madness fills up again before the Rest: the calm goes, and the crash adds 1 addiction.
  // The hero is Insane again, so they may take another dose, at worse tolerance.
  Hooks.on("updateActor", async (actor, changed) => {
    if (!isActiveGM() || changed.system?.resources?.madness === undefined) return;
    if (!actor.system.isInsane || !actor.effects.has(CALM_ID)) return;
    await actor.effects.get(CALM_ID).delete();
    const state = afterShatter(getAddiction(moduleId, actor));
    await setAddiction(moduleId, actor, state);
    await ChatMessage.implementation.create({
      speaker: ChatMessage.implementation.getSpeaker({ actor }),
      content: `<p>${game.i18n.format("PFM.Dose.Shattered", { actor: actor.name, level: state.level })}</p>`
    });
  });
}

/** The quality bonus of the dose a confirmed card used, read back from the action on the card. */
function qualityBonus(message) {
  const action = globalThis.crucible.api.models.CrucibleAction.fromChatMessage(message);
  return action?.item?.config?.quality?.bonus ?? action?.usage?.consumable?.config?.quality?.bonus ?? 0;
}
