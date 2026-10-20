// Player-confirmed movement for Crucible (see scripts/lib/move-confirm.mjs for the why).
// - A client setting, mirrored to a User flag so the GM's client knows which players hold their moves.
// - Crucible's CrucibleAction#canAutoConfirm is wrapped: the GM leaves those players' Move cards unconfirmed.
// - The player gets a Confirm button on their own pending Move card (Crucible shows its button to GMs only).
// - A pending move is confirmed before the player's next action, and when their turn ends.
// - A new drag while a move is pending confirms the old one first and asks for the drag again, because Crucible
//   checks a move's AP before the earlier move has spent any. preMoveToken cannot wait, so the drag is stopped.
import { HOLD_FLAG, holdForPlayer, isPendingMove, MOVE_ACTION, pendingMovesFor } from "./lib/move-confirm.mjs";

const isActiveGM = () => game.user.isGM && game.users.activeGM?.id === game.user.id;
const Action = () => globalThis.crucible?.api?.models?.CrucibleAction;

/** This user's pending Move cards for an actor. */
function pendingMoves(actor) {
  if (!actor) return [];
  const rows = game.messages.contents.map((m) => ({ id: m.id, authorId: m.author?.id, actorUuid: m.flags?.crucible?.actor, flags: m.flags?.crucible }));
  return pendingMovesFor(rows, { userId: game.user.id, actorUuid: actor.uuid }).map((r) => game.messages.get(r.id));
}

/** Confirm this user's pending moves for an actor, oldest first. */
async function confirmPending(actor) {
  for (const message of pendingMoves(actor)) await Action().confirmMessage(message);
}

export function registerMoveConfirm(moduleId) {
  game.settings.register(moduleId, HOLD_FLAG, {
    name: "PFM.Settings.ConfirmOwnMoves.Name",
    hint: "PFM.Settings.ConfirmOwnMoves.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: (value) => game.user.setFlag(moduleId, HOLD_FLAG, value)
  });
  const holds = (user) => !!user?.getFlag(moduleId, HOLD_FLAG);

  const CrucibleAction = Action();
  if (!CrucibleAction) return;

  // The GM's client asks canAutoConfirm before confirming a new card. A rebuilt action carries its chat message.
  const canAutoConfirm = CrucibleAction.prototype.canAutoConfirm;
  CrucibleAction.prototype.canAutoConfirm = function () {
    const author = this.message?.author;
    if (holdForPlayer({ actionId: this.id, authorIsGM: !!author?.isGM, authorHolds: holds(author) })) return false;
    return canAutoConfirm.call(this);
  };

  // Before this player's next action (a strike, a spell, another Move card), confirm their pending move.
  const use = CrucibleAction.prototype.use;
  CrucibleAction.prototype.use = async function (...args) {
    if (holds(game.user)) await confirmPending(this.actor);
    return use.apply(this, args);
  };

  // A Confirm button on the player's own pending Move card, styled like Crucible's GM button.
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (game.user.isGM || message.author?.id !== game.user.id || !isPendingMove(message.flags?.crucible)) return;
    if (html.querySelector("button.pfm-confirm-move")) return;
    const button = foundry.utils.parseHTML(`<button class="confirm frame-brown pfm-confirm-move" type="button"><i class="fa-solid fa-hexagon-check"></i>${game.i18n.localize("PFM.MoveConfirm.Confirm")}</button>`);
    button.addEventListener("click", (event) => {
      event.currentTarget.disabled = true;
      Action().confirmMessage(message);
    });
    html.appendChild(button);
  });

  // A new drag while a move is pending: confirm the pending one, then ask for the drag again.
  Hooks.on("preMoveToken", (token, movement) => {
    if (!holds(game.user) || movement?.method !== "dragging" || !token.actor?.inCombat) return;
    if (!pendingMoves(token.actor).length) return;
    confirmPending(token.actor).then(() => ui.notifications.info(game.i18n.format("PFM.MoveConfirm.ConfirmedDragAgain", { name: token.name })));
    return false;
  });

  // When a turn ends, the active GM confirms that combatant's moves still waiting on their player.
  Hooks.on("combatTurnChange", async (combat, prior) => {
    if (!isActiveGM()) return;
    const actor = combat.combatants.get(prior?.combatantId)?.actor;
    if (!actor) return;
    for (const message of game.messages.contents) {
      const flags = message.flags?.crucible;
      if (flags?.action?.id === MOVE_ACTION && !flags.confirmed && flags.actor === actor.uuid) await Action().confirmMessage(message);
    }
  });
}

/** Mirror this user's setting onto their User flag, so the GM sees it even if it was set before this module version. */
export async function syncMoveConfirmFlag(moduleId) {
  const value = game.settings.get(moduleId, HOLD_FLAG);
  if (!!game.user.getFlag(moduleId, HOLD_FLAG) !== value) await game.user.setFlag(moduleId, HOLD_FLAG, value);
}
