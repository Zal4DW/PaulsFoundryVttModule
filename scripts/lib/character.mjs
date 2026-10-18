// Pure helpers with no Foundry globals, so Vitest can test them in Node.

/** The default key for the Open Character keybinding, as a KeyboardEvent.code. */
export const OPEN_CHARACTER_KEY = "KeyC";

/** Hint order in the picker list. Lower comes first. */
const HINT_ORDER = { selected: 0, targeted: 1, assigned: 2 };

/**
 * Decide which character sheet the C key opens. All inputs are actor ids the user owns.
 * @param {object} input
 * @param {string|null} [input.activeTurn]  The actor whose turn it is in a started combat, if the user owns it.
 * @param {string[]}    [input.selected]    Actors of owned tokens the user has selected (controlled).
 * @param {string[]}    [input.targeted]    Actors of owned tokens the user has targeted.
 * @param {string|null} [input.assigned]    The user's assigned character.
 * @param {string[]}    [input.owned]       The user's other owned characters.
 * @returns {{mode: "open", id: string, reason: string}
 *   | {mode: "pick", choices: {id: string, hints: string[]}[]}
 *   | {mode: "none"}}
 */
export function chooseCharacter({ activeTurn = null, selected = [], targeted = [], assigned = null, owned = [] } = {}) {
  if (activeTurn) return { mode: "open", id: activeTurn, reason: "turn" };

  const uniqueSelected = [...new Set(selected)];
  if (uniqueSelected.length === 1) return { mode: "open", id: uniqueSelected[0], reason: "selected" };

  // Collect every candidate once, with the reasons it qualifies.
  const hints = new Map();
  const add = (id, hint) => {
    if (!id) return;
    if (!hints.has(id)) hints.set(id, []);
    if (hint && !hints.get(id).includes(hint)) hints.get(id).push(hint);
  };
  uniqueSelected.forEach((id) => add(id, "selected"));
  targeted.forEach((id) => add(id, "targeted"));
  add(assigned, "assigned");
  owned.forEach((id) => add(id, null));

  const choices = [...hints].map(([id, h]) => ({ id, hints: h }));
  if (choices.length === 0) return { mode: "none" };
  if (choices.length === 1) return { mode: "open", id: choices[0].id, reason: choices[0].hints[0] ?? "owned" };

  // Hinted choices first, by their strongest hint. Others keep their given order.
  const rank = (c) => Math.min(...c.hints.map((h) => HINT_ORDER[h]), Infinity);
  choices.sort((a, b) => rank(a) - rank(b));
  return { mode: "pick", choices };
}
