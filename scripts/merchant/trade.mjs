// Merchant trades. A player can't edit the merchant actor or take coin itself, so every trade runs on the active GM's
// client, one at a time: two players buying the last Dose at once get it and "sold out", in that order.
import { checkBuy, logTrade, MERCHANT_FLAG, normaliseMerchant, priceFor, takeFromCatalogue } from "../lib/merchant.mjs";

const TIMEOUT_MS = 15000;
const pending = new Map();
let queue = Promise.resolve();

/** The merchant data on an actor, or null when it isn't a merchant. */
export function merchantData(moduleId, actor) {
  const data = actor?.getFlag(moduleId, MERCHANT_FLAG);
  return data ? normaliseMerchant(data) : null;
}

/** Crucible items stack only with the "stackable" property; anything else is clamped to quantity 1. */
export const isStackable = (item) => !!(item?.system?.properties?.has?.("stackable") ?? item?.system?.properties?.includes?.("stackable"));

/** Listen for trade requests (on the GM's client) and results (on every client). Call once, from ready. */
export function registerMerchantSocket(moduleId) {
  // The manifest's "socket": true gives the module the event module.<id>. Socket.io relays a message to the other
  // clients only, so the GM's own requests skip the socket (see requestTrade).
  // The v14 docs don't describe the handler's arguments. The v14 server (dist/server/sockets.mjs, handleCustomSocket)
  // relays each message as (data, senderUserId), with the id taken from the sender's authenticated socket, and
  // delivers to {recipients} when given. So the GM trusts that id, never a user id inside the message.
  const channel = `module.${moduleId}`;
  game.socket.on(channel, (msg, senderId) => {
    if (msg?.type === "merchantTrade" && game.users.activeGM?.isSelf) {
      if (!game.users.get(senderId)) return;
      enqueue(moduleId, msg.request, senderId).then((result) => game.socket.emit(channel, { type: "merchantResult", requestId: msg.requestId, result }, { recipients: [senderId] }));
    }
    // Only the active GM's answer counts.
    if (msg?.type === "merchantResult" && senderId === game.users.activeGM?.id) {
      pending.get(msg.requestId)?.(msg.result);
      pending.delete(msg.requestId);
    }
  });
}

/**
 * Ask the active GM to run a trade.
 * @param {{action: "buy", merchantId: string, actorId: string, source: "catalogue"|"held", id: string, quantity: number}} request
 * @returns {Promise<{ok: boolean, reason?: string, total?: number}>}
 */
export function requestTrade(moduleId, request) {
  const gm = game.users.activeGM;
  if (!gm) return Promise.resolve({ ok: false, reason: "noGM" });
  if (gm.isSelf) return enqueue(moduleId, request, game.user.id);
  const requestId = foundry.utils.randomID();
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    game.socket.emit(`module.${moduleId}`, { type: "merchantTrade", requestId, request }, { recipients: [gm.id] });
    setTimeout(() => { if (pending.delete(requestId)) resolve({ ok: false, reason: "timeout" }); }, TIMEOUT_MS);
  });
}

/** Run trades one after another, so each one checks the stock and coin the last one left. */
function enqueue(moduleId, request, userId) {
  const run = queue.then(() => runTrade(moduleId, request, userId)).catch((err) => {
    console.error(`${moduleId} | merchant trade failed`, err);
    return { ok: false, reason: "error" };
  });
  queue = run;
  return run;
}

async function runTrade(moduleId, request, userId) {
  if (request?.action === "buy") return buy(moduleId, request, userId);
  return { ok: false, reason: "unknown" };
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

async function buy(moduleId, { merchantId, actorId, source, id, quantity }, userId) {
  const user = game.users.get(userId);
  const merchant = game.actors.get(merchantId);
  const hero = game.actors.get(actorId);
  const data = merchantData(moduleId, merchant);
  if (!data?.enabled) return { ok: false, reason: "closed" };
  if (!hero || hero.type !== "hero" || !hero.testUserPermission(user, "OWNER")) return { ok: false, reason: "notYours" };
  const found = await stockItem(merchant, data, source, id);
  if (!found) return { ok: false, reason: "soldOut" };
  const { item, line } = found;
  // A held item that doesn't stack is one item, so it sells one at a time.
  if (source === "held" && !isStackable(item) && quantity !== 1) return { ok: false, reason: "quantity" };
  const unitPrice = priceFor(item.system.price, data.buyRate, line?.price ?? null);
  const check = checkBuy({ quantity, stock: found.stock, unitPrice, purse: hero.system.currency });
  if (!check.ok) return check;

  const purse = hero.system.currency;
  await hero.update({ "system.currency": purse - check.total });
  try {
    await giveItem(hero, item, quantity, line?.uuid ?? null);
  } catch (err) {
    // The hero paid but got nothing: give the coin back before the queue logs the error.
    await hero.update({ "system.currency": purse });
    throw err;
  }
  if (source === "held") {
    const left = (item.system.quantity ?? 1) - quantity;
    if (left > 0) await item.update({ "system.quantity": left });
    else await item.delete();
  }
  const entry = { id: foundry.utils.randomID(), ts: Date.now(), action: "buy", userId, actorId, source, lineId: id, uuid: line?.uuid ?? null, name: item.name, quantity, total: check.total };
  const catalogue = source === "catalogue" ? takeFromCatalogue(data.catalogue, id, quantity) : data.catalogue;
  await merchant.update({ [`flags.${moduleId}.${MERCHANT_FLAG}`]: { ...data, catalogue, log: logTrade(data.log, entry) } });
  await postReceipt(moduleId, merchant, hero, entry);
  return { ok: true, total: check.total };
}

/** Put quantity of an item on the hero: onto a matching stack when it stacks, else as new items. */
async function giveItem(hero, item, quantity, uuid) {
  const data = item.toObject();
  delete data._id;
  // Crucible rebuilds an item's loot text from its compendium source, so keep where it came from.
  if (uuid?.startsWith("Compendium.")) foundry.utils.setProperty(data, "_stats.compendiumSource", uuid);
  if (isStackable(item)) {
    const stack = hero.items.find((i) => i.type === item.type && i.name === item.name && isStackable(i));
    if (stack) return stack.update({ "system.quantity": (stack.system.quantity ?? 1) + quantity });
    data.system.quantity = quantity;
    return hero.createEmbeddedDocuments("Item", [data]);
  }
  data.system.quantity = 1;
  return hero.createEmbeddedDocuments("Item", Array.from({ length: quantity }, () => foundry.utils.deepClone(data)));
}

/** A chat card that says who bought what, and for how much. */
async function postReceipt(moduleId, merchant, hero, entry) {
  const price = globalThis.crucible?.api?.documents?.CrucibleItem?.formatCurrency?.(entry.total) ?? `${entry.total}cp`;
  const text = game.i18n.format("PFM.Merchant.Receipt", { hero: hero.name, quantity: entry.quantity, item: entry.name, price });
  await ChatMessage.create({
    speaker: { alias: merchant.name },
    content: `<div class="pfm-message pfm-merchant-receipt">${foundry.utils.escapeHTML(text)}</div>`,
    flags: { [moduleId]: { merchantReceipt: { merchantId: merchant.id, tradeId: entry.id } } }
  });
}
