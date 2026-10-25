// Merchant trades. A player can't edit the merchant actor or take coin itself, so every trade runs on the active GM's
// client, one at a time: two players buying the last Dose at once get it and "sold out", in that order.
// A merchant that needs approval asks the GM first, outside the queue, so other trades carry on while the GM decides.
import { checkBuy, checkSell, findUndoable, logTrade, markUndone, MERCHANT_FLAG, normaliseMerchant, priceFor, restoreCatalogue, takeFromCatalogue } from "../lib/merchant.mjs";

const TIMEOUT_MS = 15000;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
/** Requests this client sent, waiting for the GM's result: requestId -> {resolve, timer, onPending}. */
const pending = new Map();
/** Approval cards waiting for a GM's click, on the active GM's client: approvalId -> resolve(boolean). */
const approvals = new Map();
let queue = Promise.resolve();

const L = (key, data) => (data ? game.i18n.format(`PFM.Merchant.${key}`, data) : game.i18n.localize(`PFM.Merchant.${key}`));
const coin = (cp) => globalThis.crucible?.api?.documents?.CrucibleItem?.formatCurrency?.(cp) ?? `${cp}cp`;

/** The merchant data on an actor, or null when it isn't a merchant. */
export function merchantData(moduleId, actor) {
  const data = actor?.getFlag(moduleId, MERCHANT_FLAG);
  return data ? normaliseMerchant(data) : null;
}

/** Crucible items stack only with the "stackable" property; anything else is clamped to quantity 1. Takes an item or its data. */
export const isStackable = (item) => !!(item?.system?.properties?.has?.("stackable") ?? item?.system?.properties?.includes?.("stackable"));

/** Listen for trade requests (on the GM's client), results (on every client) and approval clicks. Call once, from ready. */
export function registerMerchantSocket(moduleId) {
  // The manifest's "socket": true gives the module the event module.<id>. Socket.io relays a message to the other
  // clients only, so the GM's own requests skip the socket (see requestTrade).
  // The v14 docs don't describe the handler's arguments. The v14 server (dist/server/sockets.mjs, handleCustomSocket)
  // relays each message as (data, senderUserId), with the id taken from the sender's authenticated socket, and
  // delivers to {recipients} when given. So every check here trusts that id, never a user id inside the message.
  const channel = `module.${moduleId}`;
  game.socket.on(channel, (msg, senderId) => {
    const sender = game.users.get(senderId);
    if (!sender) return;
    const fromGM = senderId === game.users.activeGM?.id;
    if (msg?.type === "merchantTrade" && game.users.activeGM?.isSelf) {
      const reply = (data) => game.socket.emit(channel, { requestId: msg.requestId, ...data }, { recipients: [senderId] });
      handle(moduleId, msg.request, senderId, () => reply({ type: "merchantPending" })).then((result) => reply({ type: "merchantResult", result }));
    }
    if (msg?.type === "merchantPending" && fromGM) {
      // The GM is deciding, which can take longer than the timeout.
      // Give up after ten minutes, so a GM who reloads with the card open doesn't leave the player waiting forever.
      const p = pending.get(msg.requestId);
      if (p) {
        clearTimeout(p.timer);
        p.timer = setTimeout(() => { if (pending.delete(msg.requestId)) p.resolve({ ok: false, reason: "timeout" }); }, APPROVAL_TIMEOUT_MS);
        p.onPending?.();
      }
    }
    if (msg?.type === "merchantResult" && fromGM) {
      const p = pending.get(msg.requestId);
      pending.delete(msg.requestId);
      if (p) { clearTimeout(p.timer); p.resolve(msg.result); }
    }
    // Another GM clicked Approve or Decline. Only a GM may decide.
    if (msg?.type === "merchantApproval" && sender.isGM) resolveApproval(msg.approvalId, msg.approved);
  });
}

/**
 * Ask the active GM to run a trade.
 * @param {{action: "buy"|"sell"|"undo", merchantId: string, actorId?: string, source?: "catalogue"|"held", id?: string, itemId?: string, tradeId?: string, quantity?: number}} request
 * @param {{onPending?: () => void}} [options]  onPending runs when the trade waits for the GM's approval.
 * @returns {Promise<{ok: boolean, reason?: string, total?: number}>}
 */
export function requestTrade(moduleId, request, { onPending } = {}) {
  const gm = game.users.activeGM;
  if (!gm) return Promise.resolve({ ok: false, reason: "noGM" });
  if (gm.isSelf) return handle(moduleId, request, game.user.id, onPending);
  const requestId = foundry.utils.randomID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (pending.delete(requestId)) resolve({ ok: false, reason: "timeout" }); }, TIMEOUT_MS);
    pending.set(requestId, { resolve, timer, onPending });
    game.socket.emit(`module.${moduleId}`, { type: "merchantTrade", requestId, request }, { recipients: [gm.id] });
  });
}

/** Run one task after the last, so each trade checks the stock and coin the one before it left. */
function enqueue(moduleId, task) {
  const run = queue.then(task).catch((err) => {
    console.error(`${moduleId} | merchant trade failed`, err);
    return { ok: false, reason: "error" };
  });
  queue = run;
  return run;
}

/**
 * On the active GM's client: check, ask for approval when the merchant needs it, then run the trade in the queue.
 * Exported for the Quench tests, which run a trade on behalf of a test player.
 */
export async function handle(moduleId, request, userId, onPending) {
  const run = { buy, sell, undo }[request?.action];
  if (!run) return { ok: false, reason: "unknown" };
  if (request.action === "undo") {
    if (!game.users.get(userId)?.isGM) return { ok: false, reason: "notGM" };
    return enqueue(moduleId, () => undo(moduleId, request));
  }
  const data = merchantData(moduleId, game.actors.get(request.merchantId));
  if (data?.requireApproval && !game.users.get(userId)?.isGM) {
    const plan = await enqueue(moduleId, () => run(moduleId, request, userId, { dryRun: true }));
    if (!plan.ok) return plan;
    onPending?.();
    if (!(await askApproval(moduleId, request, userId, plan))) return { ok: false, reason: "declined" };
  }
  return enqueue(moduleId, () => run(moduleId, request, userId));
}

/** The hero making the trade, if this user owns it. */
function heroFor(actorId, userId) {
  const hero = game.actors.get(actorId);
  return hero?.type === "hero" && hero.testUserPermission(game.users.get(userId), "OWNER") ? hero : null;
}

/** The item a stock row sells: a fresh copy from the catalogue line's uuid, or the merchant's own held item. */
async function stockItem(merchant, data, source, id) {
  if (source === "held") {
    const item = merchant.items.get(id);
    return item ? { item, line: null, stock: item.system.quantity ?? 1 } : null;
  }
  const line = data.catalogue.find((l) => l.id === id);
  const item = line ? await fromUuid(line.uuid) : null;
  return item ? { item, line, stock: line.count } : null;
}

async function buy(moduleId, { merchantId, actorId, source, id, quantity }, userId, { dryRun = false } = {}) {
  const merchant = game.actors.get(merchantId);
  const data = merchantData(moduleId, merchant);
  if (!data?.enabled) return { ok: false, reason: "closed" };
  const hero = heroFor(actorId, userId);
  if (!hero) return { ok: false, reason: "notYours" };
  const found = await stockItem(merchant, data, source, id);
  if (!found) return { ok: false, reason: "soldOut" };
  const { item, line } = found;
  // A held item that doesn't stack is one item, so it sells one at a time.
  if (source === "held" && !isStackable(item) && quantity !== 1) return { ok: false, reason: "quantity" };
  const unitPrice = priceFor(item.system.price, data.buyRate, line?.price ?? null);
  const check = checkBuy({ quantity, stock: found.stock, unitPrice, purse: hero.system.currency });
  if (!check.ok || dryRun) return { ...check, name: item.name, hero: hero.name, merchant: merchant.name };

  // Keep what an undo needs: the held item as it was, and the stacks the hero received.
  const heldData = source === "held" ? { ...item.toObject(), _id: undefined, system: { ...item.toObject().system, quantity } } : null;
  const purse = hero.system.currency;
  await hero.update({ "system.currency": purse - check.total });
  let given;
  try {
    given = await giveTo(hero, item, quantity, line?.uuid ?? null);
  } catch (err) {
    // The hero paid but got nothing: give the coin back before the queue logs the error.
    await hero.update({ "system.currency": purse });
    throw err;
  }
  if (source === "held") await takeFrom(merchant, [{ id: item.id, quantity }]);
  const entry = { id: foundry.utils.randomID(), ts: Date.now(), action: "buy", userId, actorId, source, lineId: id, uuid: line?.uuid ?? null, name: item.name, quantity, total: check.total, given, heldData };
  const catalogue = source === "catalogue" ? takeFromCatalogue(data.catalogue, id, quantity) : data.catalogue;
  await merchant.update({ [`flags.${moduleId}.${MERCHANT_FLAG}`]: { ...data, catalogue, log: logTrade(data.log, entry) } });
  await postReceipt(moduleId, merchant, hero, entry);
  return { ok: true, total: check.total, tradeId: entry.id };
}

async function sell(moduleId, { merchantId, actorId, itemId, quantity }, userId, { dryRun = false } = {}) {
  const merchant = game.actors.get(merchantId);
  const data = merchantData(moduleId, merchant);
  if (!data?.enabled) return { ok: false, reason: "closed" };
  const hero = heroFor(actorId, userId);
  if (!hero) return { ok: false, reason: "notYours" };
  const item = hero.items.get(itemId);
  if (!item) return { ok: false, reason: "notEnoughItems" };
  const sellable = typeof item.system.price === "number";
  const check = checkSell({ quantity, have: item.system.quantity ?? 1, unitPrice: priceFor(item.system.price, data.sellRate), equipped: !!item.system.equipped, sellable });
  if (!check.ok || dryRun) return { ...check, name: item.name, hero: hero.name, merchant: merchant.name };

  const taken = { ...item.toObject(), _id: undefined, system: { ...item.toObject().system, quantity } };
  await takeFrom(hero, [{ id: item.id, quantity }]);
  // The merchant resells it at the buy rate, as a held item.
  const held = await giveTo(merchant, taken, quantity);
  await hero.update({ "system.currency": (hero.system.currency ?? 0) + check.total });
  const entry = { id: foundry.utils.randomID(), ts: Date.now(), action: "sell", userId, actorId, name: item.name, quantity, total: check.total, taken, held };
  await merchant.update({ [`flags.${moduleId}.${MERCHANT_FLAG}.log`]: logTrade(data.log, entry) });
  await postReceipt(moduleId, merchant, hero, entry);
  return { ok: true, total: check.total, tradeId: entry.id };
}

/** Reverse a logged trade: coin back, items back, stock back. Refused if the items have moved on since. */
async function undo(moduleId, { merchantId, tradeId }) {
  const merchant = game.actors.get(merchantId);
  const data = merchantData(moduleId, merchant);
  const { entry, reason } = findUndoable(data?.log, tradeId);
  if (!entry) return { ok: false, reason };
  const hero = game.actors.get(entry.actorId);
  if (!hero) return { ok: false, reason: "itemGone" };
  let catalogue = data.catalogue;
  if (entry.action === "buy") {
    if (!canTake(hero, entry.given)) return { ok: false, reason: "itemGone" };
    await takeFrom(hero, entry.given);
    await hero.update({ "system.currency": (hero.system.currency ?? 0) + entry.total });
    if (entry.source === "held") await giveTo(merchant, entry.heldData, entry.quantity);
    else catalogue = restoreCatalogue(catalogue, entry.lineId, entry.quantity);
  } else {
    if (!canTake(merchant, entry.held)) return { ok: false, reason: "itemGone" };
    if ((hero.system.currency ?? 0) < entry.total) return { ok: false, reason: "notEnoughCoin" };
    await takeFrom(merchant, entry.held);
    await hero.update({ "system.currency": hero.system.currency - entry.total });
    await giveTo(hero, entry.taken, entry.quantity);
  }
  await merchant.update({ [`flags.${moduleId}.${MERCHANT_FLAG}`]: { ...data, catalogue, log: markUndone(data.log, tradeId) } });
  const receipt = game.messages.find((m) => m.getFlag(moduleId, "merchantReceipt")?.tradeId === tradeId);
  await receipt?.update({ [`flags.${moduleId}.merchantReceipt.undone`]: true });
  return { ok: true };
}

/**
 * Put quantity of an item on an actor: onto a matching stack when it stacks, else as new items.
 * @param {Actor} actor
 * @param {Item|object} source  An item, or item data.
 * @param {number} quantity
 * @param {string|null} [uuid]  The compendium uuid it came from.
 * @returns {Promise<{id: string, quantity: number}[]>}  The items that received it, for undo.
 */
async function giveTo(actor, source, quantity, uuid = null) {
  const data = foundry.utils.deepClone(source.toObject?.() ?? source);
  delete data._id;
  // Crucible rebuilds an item's loot text from its compendium source, so keep where it came from.
  if (uuid?.startsWith("Compendium.")) foundry.utils.setProperty(data, "_stats.compendiumSource", uuid);
  if (isStackable(data)) {
    const stack = actor.items.find((i) => i.type === data.type && i.name === data.name && isStackable(i));
    if (stack) {
      await stack.update({ "system.quantity": (stack.system.quantity ?? 1) + quantity });
      return [{ id: stack.id, quantity }];
    }
    data.system.quantity = quantity;
    const [created] = await actor.createEmbeddedDocuments("Item", [data]);
    return [{ id: created.id, quantity }];
  }
  data.system.quantity = 1;
  const created = await actor.createEmbeddedDocuments("Item", Array.from({ length: quantity }, () => foundry.utils.deepClone(data)));
  return created.map((c) => ({ id: c.id, quantity: 1 }));
}

/** True when the actor still holds every part. */
function canTake(actor, parts = []) {
  return parts.every(({ id, quantity }) => (actor.items.get(id)?.system.quantity ?? 0) >= quantity);
}

/** Remove each part: lower the stack, or delete the item when none are left. */
async function takeFrom(actor, parts) {
  for (const { id, quantity } of parts) {
    const item = actor.items.get(id);
    const left = (item?.system.quantity ?? 1) - quantity;
    if (left > 0) await item.update({ "system.quantity": left });
    else await item?.delete();
  }
}

/** A chat card that says who bought or sold what, and for how much. The GM sees an Undo button on it. */
async function postReceipt(moduleId, merchant, hero, entry) {
  const text = L(entry.action === "sell" ? "SoldReceipt" : "Receipt", { hero: hero.name, quantity: entry.quantity, item: entry.name, price: coin(entry.total) });
  await ChatMessage.create({
    speaker: { alias: merchant.name },
    content: `<div class="pfm-message pfm-merchant-receipt">${foundry.utils.escapeHTML(text)}</div>`,
    flags: { [moduleId]: { merchantReceipt: { merchantId: merchant.id, tradeId: entry.id } } }
  });
}

/** Post a GM-only card with Approve and Decline, and wait for a click. */
async function askApproval(moduleId, request, userId, plan) {
  const approvalId = foundry.utils.randomID();
  const key = request.action === "sell" ? "ApproveSell" : "ApproveBuy";
  const text = L(key, { user: game.users.get(userId)?.name ?? "?", hero: plan.hero, quantity: request.quantity, item: plan.name, price: coin(plan.total), merchant: plan.merchant });
  const buttons = `<div class="pfm-merchant-approval-buttons"><button type="button" data-approval="${approvalId}" data-approved="1"><i class="fa-solid fa-check"></i> ${foundry.utils.escapeHTML(L("Approve"))}</button>`
    + `<button type="button" data-approval="${approvalId}" data-approved="0"><i class="fa-solid fa-xmark"></i> ${foundry.utils.escapeHTML(L("Decline"))}</button></div>`;
  const message = await ChatMessage.create({
    speaker: { alias: plan.merchant },
    content: `<div class="pfm-message pfm-merchant-approval"><p>${foundry.utils.escapeHTML(text)}</p>${buttons}</div>`,
    whisper: game.users.filter((u) => u.isGM).map((u) => u.id),
    flags: { [moduleId]: { merchantApproval: { approvalId, merchantId: request.merchantId } } }
  });
  const approved = await new Promise((resolve) => approvals.set(approvalId, resolve));
  await message.update({ [`flags.${moduleId}.merchantApproval.decided`]: approved ? "approved" : "declined" });
  return approved;
}

/** A GM clicked Approve or Decline. The waiting promise lives on the active GM's client, so other GMs send it there. */
export function decideApproval(moduleId, approvalId, approved) {
  if (resolveApproval(approvalId, approved)) return true;
  const gm = game.users.activeGM;
  if (gm) game.socket.emit(`module.${moduleId}`, { type: "merchantApproval", approvalId, approved }, { recipients: [gm.id] });
  return false;
}

/** True while this client holds the waiting promise for an approval card. */
export const isWaitingApproval = (approvalId) => approvals.has(approvalId);

function resolveApproval(approvalId, approved) {
  const resolve = approvals.get(approvalId);
  if (!resolve) return false;
  approvals.delete(approvalId);
  resolve(!!approved);
  return true;
}
