// Player-confirmed movement for Crucible. Pure logic: no Foundry globals.
//
// Crucible's "auto-confirm self actions" setting has the GM's client confirm every Move card at once. New players
// misjudge token edges and waypoints, and each mistake then needs the GM to undo it. A player who turns on
// "Confirm my own movement" gets their Move cards left unconfirmed: the token has moved but no AP is spent, so
// Ctrl+Z takes it back for free. They confirm it themselves, or it is confirmed when they act again or their turn ends.

/** Crucible's action id for a token move. */
export const MOVE_ACTION = "move";

/** The User flag that mirrors a player's "Confirm my own movement" setting, so the GM's client can read it. */
export const HOLD_FLAG = "confirmOwnMoves";

/** The chat card flag the GM's client sets on a Move card it held back for its player. */
export const HELD_FLAG = "heldForPlayer";

/** True for an unconfirmed Move card: the move has happened on the canvas, but its AP is not spent yet. */
export const isPendingMove = (crucibleFlags) => crucibleFlags?.action?.id === MOVE_ACTION && !crucibleFlags?.confirmed;

/**
 * True for a pending Move card this module held back for its player. Only these may be confirmed by the player or
 * at turn end: a card the GM left unconfirmed on purpose (auto-confirm off) has no marker and stays the GM's.
 */
export const isHeldMove = (crucibleFlags, moduleFlags) => isPendingMove(crucibleFlags) && !!moduleFlags?.[HELD_FLAG];

/**
 * Whether the GM's auto-confirm should leave this card for its player: a Move card, made by a player (not a GM)
 * who turned on "Confirm my own movement".
 * @param {{actionId: string, authorIsGM: boolean, authorHolds: boolean}} card
 */
export const holdForPlayer = ({ actionId, authorIsGM, authorHolds }) => actionId === MOVE_ACTION && !authorIsGM && !!authorHolds;

/**
 * The held Move cards to confirm before an actor acts again: held for this user, still unconfirmed, for this actor.
 * @param {{id: string, authorId: string, actorUuid: string, flags: object, moduleFlags: object}[]} messages
 */
export function pendingMovesFor(messages, { userId, actorUuid }) {
  return messages.filter((m) => m.authorId === userId && m.actorUuid === actorUuid && isHeldMove(m.flags, m.moduleFlags));
}
