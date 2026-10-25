// Merchants: the module's own shop window, to replace Crucible Shop. See docs/merchant-plan.md.
import { MERCHANT_FLAG, normaliseMerchant } from "../lib/merchant.mjs";
import { merchantData, registerMerchantSocket, requestTrade } from "./trade.mjs";
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
  // The invite card's button. The card's HTML is rebuilt on each render, so bind it every time.
  Hooks.on("renderChatMessageHTML", (_message, html) => {
    for (const button of html.querySelectorAll(".pfm-merchant-open")) {
      button.addEventListener("click", () => openMerchant(moduleId, button.dataset.merchant));
    }
  });
  return {
    openMerchant: (actor, options) => openMerchant(moduleId, actor, options),
    setMerchant: (actor, data) => setMerchant(moduleId, actor, data),
    inviteToMerchant: (actor, userIds) => inviteToMerchant(moduleId, actor, userIds),
    merchantTrade: (request) => requestTrade(moduleId, request)
  };
}
