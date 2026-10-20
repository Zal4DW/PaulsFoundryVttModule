// Player-confirmed movement for Crucible (see scripts/lib/move-confirm.mjs for the why).
// - A client setting, mirrored to a User flag so the GM's client knows which players hold their moves.
// - Crucible's CrucibleAction#canAutoConfirm is wrapped: the GM leaves those players' Move cards unconfirmed.
// - The player gets a Confirm button on their own pending Move card (Crucible shows its button to GMs only).
// - A pending move is confirmed before the player's next action, and when their turn ends.
// - A new drag while a move is pending confirms the old one first and asks for the drag again, because Crucible
//   checks a move's AP before the earlier move has spent any. preMoveToken cannot wait, so the drag is stopped.
import { HELD_FLAG, HOLD_FLAG, holdForPlayer, isHeldMove, pendingMovesFor } from "./lib/move-confirm.mjs";

const isActiveGM = () => game.user.isGM && game.users.activeGM?.id === game.user.id;
const Action = () => globalThis.crucible?.api?.models?.CrucibleAction;

/** This user's held Move cards for an actor. */
function pendingMoves(moduleId, actor) {
  if (!actor) return [];
  const rows = game.messages.contents.map((m) => ({ id: m.id, authorId: m.author?.id, actorUuid: m.flags?.crucible?.actor,
    flags: m.flags?.crucible, moduleFlags: m.flags?.[moduleId] }));
  return pendingMovesFor(rows, { userId: game.user.id, actorUuid: actor.uuid }).map((r) => game.messages.get(r.id));
}

/** Confirm this user's held moves for an actor, oldest first. */
async function confirmPending(moduleId, actor) {
  for (const message of pendingMoves(moduleId, actor)) await Action().confirmMessage(message);
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
  // Only a card Crucible would have auto-confirmed is held, and it is marked, so the player-side confirms below never
  // touch a card the GM left unconfirmed on purpose (for example with Crucible's auto-confirm turned off).
  const canAutoConfirm = CrucibleAction.prototype.canAutoConfirm;
  CrucibleAction.prototype.canAutoConfirm = function () {
    const auto = canAutoConfirm.call(this);
    const author = this.message?.author;
    if (!auto || !holdForPlayer({ actionId: this.id, authorIsGM: !!author?.isGM, authorHolds: holds(author) })) return auto;
    this.message.setFlag(moduleId, HELD_FLAG, true);
    return false;
  };

  // Before this player's next action (a strike, a spell, another Move card), confirm their pending move.
  const use = CrucibleAction.prototype.use;
  CrucibleAction.prototype.use = async function (...args) {
    if (holds(game.user)) await confirmPending(moduleId, this.actor);
    return use.apply(this, args);
  };

  // A Confirm button on the player's own pending Move card, styled like Crucible's GM button.
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (game.user.isGM || !holds(game.user) || message.author?.id !== game.user.id) return;
    if (!isHeldMove(message.flags?.crucible, message.flags?.[moduleId])) return;
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
    if (!pendingMoves(moduleId, token.actor).length) return;
    confirmPending(moduleId, token.actor).then(() => ui.notifications.info(game.i18n.format("PFM.MoveConfirm.ConfirmedDragAgain", { name: token.name })));
    return false;
  });

  // When a turn ends, the active GM confirms that combatant's held moves still waiting on their player. Unmarked
  // pending cards are the GM's own to review and are left alone.
  Hooks.on("combatTurnChange", async (combat, prior) => {
    if (!isActiveGM()) return;
    const actor = combat.combatants.get(prior?.combatantId)?.actor;
    if (!actor) return;
    for (const message of game.messages.contents) {
      const flags = message.flags?.crucible;
      if (flags?.actor === actor.uuid && isHeldMove(flags, message.flags?.[moduleId])) await Action().confirmMessage(message);
    }
  });
}

/** Mirror this user's setting onto their User flag, so the GM sees it even if it was set before this module version. */
export async function syncMoveConfirmFlag(moduleId) {
  const value = game.settings.get(moduleId, HOLD_FLAG);
  if (!!game.user.getFlag(moduleId, HOLD_FLAG) !== value) await game.user.setFlag(moduleId, HOLD_FLAG, value);
}
