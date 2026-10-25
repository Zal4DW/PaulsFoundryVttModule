// Merchants: the module's own shop window, to replace Crucible Shop. See docs/merchant-plan.md.
import { MERCHANT_FLAG, normaliseMerchant } from "../lib/merchant.mjs";
import { decideApproval, isWaitingApproval, merchantData, registerMerchantSocket, requestTrade } from "./trade.mjs";
import { MerchantWindow } from "./window.mjs";

const L = (key, data) => (data ? game.i18n.format(`PFM.Merchant.${key}`, data) : game.i18n.localize(`PFM.Merchant.${key}`));
const actorOf = (actorOrId) => (typeof actorOrId === "string" ? game.actors.get(actorOrId) ?? fromUuidSync(actorOrId) : actorOrId);

/** Open a merchant's window, or bring it to the front if it is open. */
export function openMerchant(moduleId, actorOrId, options = {}) {
  const merchant = actorOf(actorOrId);
  if (!merchantData(moduleId, merchant)) { ui.notifications.warn(L("NotAMerchant")); return null; }
  const open = foundry.applications.instances.get(`pfm-merchant-${merchant.id}`);
  if (open) { open.bringToFront(); return open; }
  const app = new MerchantWindow(moduleId, merchant, options);
  app.render({ force: true });
  return app;
}

/**
 * GM only: make an actor a merchant, or change its data. Players need Limited ownership to see a merchant, so this
 * sets the actor's default ownership to Limited when it is lower.
 * @param {Actor} actor
 * @param {object} data  Fields of the merchant data; see normaliseMerchant.
 */
export async function setMerchant(moduleId, actorOrId, data) {
  const actor = actorOf(actorOrId);
  const merged = normaliseMerchant({ ...(merchantData(moduleId, actor) ?? {}), ...data });
  const update = { [`flags.${moduleId}.${MERCHANT_FLAG}`]: merged };
  const limited = CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED;
  if ((actor.ownership.default ?? 0) < limited) update["ownership.default"] = limited;
  await actor.update(update);
  return merged;
}

/**
 * GM only: post a card with an "Open shop" button. With userIds, only those players (and the GM) see it.
 * @param {Actor|string} actorOrId
 * @param {string[]} [userIds]
 */
export async function inviteToMerchant(moduleId, actorOrId, userIds = []) {
  const merchant = actorOf(actorOrId);
  if (!merchantData(moduleId, merchant)) throw new Error(`${merchant?.name ?? actorOrId} is not a merchant`);
  const text = foundry.utils.escapeHTML(L("Invite", { name: merchant.name }));
  const button = `<button type="button" class="pfm-merchant-open" data-merchant="${merchant.id}"><i class="fa-solid fa-scale-balanced"></i> ${foundry.utils.escapeHTML(L("Open"))}</button>`;
  return ChatMessage.create({
    speaker: { alias: merchant.name },
    content: `<div class="pfm-message pfm-merchant-invite"><p>${text}</p>${button}</div>`,
    whisper: userIds.length ? [...new Set([...userIds, ...game.users.filter((u) => u.isGM).map((u) => u.id)])] : [],
    flags: { [moduleId]: { merchantInvite: { merchantId: merchant.id } } }
  });
}

export function registerMerchant(moduleId) {
  Hooks.once("ready", () => registerMerchantSocket(moduleId));
  // The cards' buttons. A card's HTML is rebuilt on each render, so bind them every time.
  Hooks.on("renderChatMessageHTML", (message, html) => {
    for (const button of html.querySelectorAll(".pfm-merchant-open")) {
      button.addEventListener("click", () => openMerchant(moduleId, button.dataset.merchant));
    }
    decorateApproval(moduleId, message, html);
    decorateReceipt(moduleId, message, html);
  });
  return {
    openMerchant: (actor, options) => openMerchant(moduleId, actor, options),
    setMerchant: (actor, data) => setMerchant(moduleId, actor, data),
    inviteToMerchant: (actor, userIds) => inviteToMerchant(moduleId, actor, userIds),
    merchantTrade: (request, options) => requestTrade(moduleId, request, options)
  };
}

/** Approval card: live buttons for a GM while the trade waits, else the decision. */
function decorateApproval(moduleId, message, html) {
  const flag = message.getFlag(moduleId, "merchantApproval");
  const box = html.querySelector(".pfm-merchant-approval-buttons");
  if (!flag || !box) return;
  // Only the active GM holds the waiting trade. After a reload it is gone, so the card can't decide anything.
  const stale = !flag.decided && game.users.activeGM?.isSelf && !isWaitingApproval(flag.approvalId);
  const status = flag.decided ? L(flag.decided === "approved" ? "Approved" : "Declined") : stale ? L("Expired") : null;
  if (status) {
    box.replaceWith(Object.assign(document.createElement("p"), { className: "pfm-merchant-status", textContent: status }));
    return;
  }
  for (const button of box.querySelectorAll("button[data-approval]")) {
    button.addEventListener("click", () => {
      for (const b of box.querySelectorAll("button")) b.disabled = true;
      decideApproval(moduleId, button.dataset.approval, button.dataset.approved === "1");
    });
  }
}

/** Receipt card: "Undone" once reversed, else an Undo button for the GM. */
function decorateReceipt(moduleId, message, html) {
  const flag = message.getFlag(moduleId, "merchantReceipt");
  const card = html.querySelector(".pfm-merchant-receipt");
  if (!flag || !card) return;
  if (flag.undone) {
    card.classList.add("pfm-merchant-undone");
    card.append(Object.assign(document.createElement("p"), { className: "pfm-merchant-status", textContent: L("Undone") }));
    return;
  }
  if (!game.user.isGM) return;
  const button = Object.assign(document.createElement("button"), { type: "button", className: "pfm-merchant-undo" });
  button.innerHTML = `<i class="fa-solid fa-rotate-left"></i> ${foundry.utils.escapeHTML(L("Undo"))}`;
  button.addEventListener("click", async () => {
    button.disabled = true;
    const result = await requestTrade(moduleId, { action: "undo", merchantId: flag.merchantId, tradeId: flag.tradeId });
    if (!result.ok) { ui.notifications.warn(L(`Reason.${result.reason}`)); button.disabled = false; }
  });
  card.append(button);
}
