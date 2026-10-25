import { expect, test } from "@playwright/test";

// Merchant trades from a real player client, over the module socket.
// The v14 docs don't describe a module socket handler's arguments. The module relies on the v14 server passing the
// sender's authenticated user id as the second argument (dist/server/sockets.mjs, handleCustomSocket) and honouring
// {recipients}. This test checks both on the Docker v14 server: a player can buy for their own hero, and can't buy
// for another user's hero, even with a forged user id in the message.

const MODULE_ID = "pauls-foundry-module";
const GM = process.env.FOUNDRY_USER ?? "Gamemaster";
const GM_PASSWORD = process.env.FOUNDRY_USER_PASSWORD ?? "";
const PLAYER = "PFM E2E Player";

async function join(page, user, password = "") {
  await page.goto("/join");
  const userSelect = page.getByRole("combobox", { name: "Select User" });
  if (await userSelect.getByRole("option", { name: user }).isDisabled()) {
    throw new Error(`User "${user}" is already connected in another browser. Log out there, then run the tests again.`);
  }
  await userSelect.selectOption({ label: user });
  if (password) await page.getByRole("textbox", { name: "User Password" }).fill(password);
  await page.getByRole("button", { name: "Join Game Session" }).click();
  await page.waitForURL("**/game");
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 45_000 });
}

test("a player trades over the socket, and only for their own hero", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await join(page, GM, GM_PASSWORD);
  const isCrucible = await page.evaluate(() => game.system.id === "crucible");
  test.skip(!isCrucible, "The merchant needs the Crucible system");

  // GM: a player user, their hero, someone else's hero, and a merchant with two kits.
  const ids = await page.evaluate(async ({ id, name }) => {
    const old = game.users.getName(name);
    if (old) await old.delete();
    const player = await globalThis.User.create({ name, role: CONST.USER_ROLES.PLAYER });
    const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    const mine = await Actor.create({ name: "E2E Player Hero", type: "hero", system: { currency: 1000 }, ownership: { [player.id]: owner } });
    const theirs = await Actor.create({ name: "E2E Other Hero", type: "hero", system: { currency: 1000 } });
    const merchant = await Actor.create({ name: "E2E Merchant", type: "adversary" });
    const kit = (await game.packs.get(`${id}.items`).getIndex()).find((e) => e.name === "Wound Medical Kit");
    await game.modules.get(id).api.setMerchant(merchant, { buyRate: 50, catalogue: [{ id: "kit", uuid: kit.uuid, count: 2 }] });
    return { player: player.id, mine: mine.id, theirs: theirs.id, merchant: merchant.id, gm: game.user.id };
  }, { id: MODULE_ID, name: PLAYER });

  const context = await browser.newContext();
  const playerPage = await context.newPage();
  try {
    await join(playerPage, PLAYER);
    const results = await playerPage.evaluate(async ({ id, ids: x }) => {
      const api = game.modules.get(id).api;
      const buy = (actorId) => api.merchantTrade({ action: "buy", merchantId: x.merchant, actorId, source: "catalogue", id: "kit", quantity: 1 });
      const own = await buy(x.mine);
      const other = await buy(x.theirs);
      // A forged request that names the GM as the sender. The GM must use the server's sender id instead.
      const forged = await new Promise((resolve) => {
        const channel = `module.${id}`;
        game.socket.on(channel, (msg) => { if (msg?.requestId === "forged") resolve(msg.result); });
        game.socket.emit(channel, { type: "merchantTrade", requestId: "forged", userId: x.gm, request: { action: "buy", merchantId: x.merchant, actorId: x.theirs, source: "catalogue", id: "kit", quantity: 1 } }, { recipients: [x.gm] });
        setTimeout(() => resolve({ ok: false, reason: "no reply" }), 10_000);
      });
      return { own, other, forged };
    }, { id: MODULE_ID, ids });

    expect(results.own.ok, results.own.reason).toBe(true);
    expect(results.other.reason).toBe("notYours");
    expect(results.forged.reason).toBe("notYours");

    const state = await page.evaluate((x) => ({
      mine: game.actors.get(x.mine).system.currency,
      theirs: game.actors.get(x.theirs).system.currency,
      count: game.actors.get(x.merchant).getFlag("pauls-foundry-module", "merchant").catalogue[0].count
    }), ids);
    expect(state).toEqual({ mine: 850, theirs: 1000, count: 1 });
  } finally {
    await context.close();
    await page.evaluate(async ({ id, ids: x }) => {
      const receipts = game.messages.filter((m) => m.getFlag(id, "merchantReceipt")?.merchantId === x.merchant);
      if (receipts.length) await ChatMessage.deleteDocuments(receipts.map((m) => m.id));
      await Actor.deleteDocuments([x.mine, x.theirs, x.merchant].filter((a) => game.actors.has(a)));
      await game.users.get(x.player)?.delete();
    }, { id: MODULE_ID, ids });
  }
});
