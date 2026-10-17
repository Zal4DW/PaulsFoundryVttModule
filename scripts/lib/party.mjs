// Pure helpers with no Foundry globals, so Vitest can test them in Node.

/** The default key for the Open Party keybinding, as a KeyboardEvent.code. */
export const OPEN_PARTY_KEY = "KeyP";

/**
 * Decide what pressing the Open Party key does.
 * @param {object|null|undefined} party  The party actor, or nothing when no party is set.
 * @param {boolean} canView              Whether the current user may view the party actor.
 * @returns {"missing"|"denied"|"open"}
 */
export function partyOpenDecision(party, canView) {
  if (!party) return "missing";
  if (!canView) return "denied";
  return "open";
}
