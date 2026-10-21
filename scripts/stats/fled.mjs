// Mark an adversary as fled from the combat tracker. A fled adversary counts as out of the fight (lib/stats.mjs isOut),
// so a fight where every foe is dead or fled ends as a victory. The recorder copies the flag into the fight's meta.

export const FLED_FLAG = "fled";

/** The combatant a tracker row belongs to. */
const combatantOf = (app, li) => app.viewed?.combatants.get(li?.dataset?.combatantId) ?? null;

/**
 * Only adversaries can flee: not heroes, and not companions (party members, Friendly tokens, or actors flagged as a
 * hero's companion), matching the recorder's ally test. Marking heroes would turn the result into a false Defeat.
 */
function canFlee(moduleId, combatant) {
  const actor = combatant?.actor;
  if (!actor || actor.type === "hero") return false;
  const base = game.actors.get(actor.id) ?? actor;
  if (globalThis.crucible?.party?.system?.members?.ids?.has(base.id)) return false;
  if (combatant.token?.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY) return false;
  return !base.getFlag?.(moduleId, "companionOf");
}

export function registerFled(moduleId) {
  // The tracker builds its row menu with _createContextMenu(this._getEntryContextOptions, ".combatant") and the default
  // hook name "get{}ContextOptions", so it fires getCombatTrackerContextOptions(application, menuItems), and the same for
  // each parent class. The v14 docs only describe the general getDocumentContextOptions(application, menuItems) pattern,
  // so the Quench batch checks that this entry really appears in the tracker's menu.
  Hooks.on("getCombatTrackerContextOptions", (app, menuItems) => {
    const fled = (li) => !!combatantOf(app, li)?.getFlag(moduleId, FLED_FLAG);
    menuItems.push(
      {
        label: "PFM.Stats.Fled.Mark",
        icon: "fa-solid fa-person-running",
        visible: (li) => game.user.isGM && canFlee(moduleId, combatantOf(app, li)) && !fled(li),
        onClick: (_event, li) => combatantOf(app, li)?.setFlag(moduleId, FLED_FLAG, true)
      },
      {
        label: "PFM.Stats.Fled.Clear",
        icon: "fa-solid fa-person-walking-arrow-loop-left",
        visible: (li) => game.user.isGM && fled(li),
        onClick: (_event, li) => combatantOf(app, li)?.unsetFlag(moduleId, FLED_FLAG)
      }
    );
  });
}
