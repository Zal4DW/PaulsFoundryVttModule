import { expect, test } from "@playwright/test";

const MODULE_ID = "pauls-foundry-module";
const USER = process.env.FOUNDRY_USER ?? "Gamemaster";
// A user password inside the local test world only. Leave it unset if the user has none.
const USER_PASSWORD = process.env.FOUNDRY_USER_PASSWORD ?? "";

/** Join the running world as USER and wait until Foundry is ready. */
async function joinWorld(page) {
  await page.goto("/join");
  if (!page.url().includes("/join")) {
    throw new Error(
      `Expected the /join page but got ${page.url()}. Launch the test world first (set FOUNDRY_WORLD in compose.yaml).`
    );
  }
  const userSelect = page.getByRole("combobox", { name: "Select User" });
  // Foundry allows one connection per user and disables the option while that user is connected.
  if (await userSelect.getByRole("option", { name: USER }).isDisabled()) {
    throw new Error(`User "${USER}" is already connected in another browser. Log out there, then run the tests again.`);
  }
  await userSelect.selectOption({ label: USER });
  if (USER_PASSWORD) await page.getByRole("textbox", { name: "User Password" }).fill(USER_PASSWORD);
  await page.getByRole("button", { name: "Join Game Session" }).click();
  await page.waitForURL("**/game");
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 45_000 });
}

test.describe("Paul's Foundry Module smoke test", () => {
  test.beforeEach(async ({ page }) => {
    await joinWorld(page);
  });

  test("runs on Foundry v14 with the module active", async ({ page }) => {
    const info = await page.evaluate(
      (id) => ({ major: Number(game.version.split(".")[0]), active: game.modules.get(id)?.active ?? false }),
      MODULE_ID
    );
    expect(info.major).toBe(14);
    expect(info.active).toBe(true);
  });

  test("typing /hello in the chat box posts a decorated greeting", async ({ page }) => {
    // Use the real chat box, not ui.chat.processMessage("/hello"). The v14 box is ProseMirror and sends
    // "<p>/hello</p>", and a plain-string test missed that unknown commands are rejected on this path.
    await page.evaluate(async () => {
      // Close framed windows (Crucible opens its welcome journal on login) so nothing covers the chat box.
      const open = [...foundry.applications.instances.values()].filter((app) => app.hasFrame && app.rendered);
      await Promise.all(open.map((app) => app.close()));
      ui.sidebar.changeTab("chat", "primary");
      ui.sidebar.expand();
    });
    const before = await page.evaluate(() => game.messages.contents.map((m) => m.id));
    // Focus instead of click. Crucible's welcome journal can open a moment after login and cover the box.
    await page.locator('#chat-message [contenteditable="true"]').focus();
    await page.keyboard.type("/hello");
    await page.keyboard.press("Enter");

    const newIds = await page.waitForFunction(
      (ids) => {
        const fresh = game.messages.contents.filter((m) => !ids.includes(m.id)).map((m) => m.id);
        return fresh.length ? fresh : null;
      },
      before,
      { timeout: 10_000 }
    ).then((h) => h.jsonValue());

    try {
      expect(newIds, "expected exactly one new message, the greeting").toHaveLength(1);
      const [id] = newIds;
      await expect(page.locator(`[data-message-id="${id}"] .pfm-message`).first()).toBeAttached();
      await expect(page.locator(`[data-message-id="${id}"].pfm-chat-message`).first()).toBeAttached();
      await expect(page.getByText("is not a valid chat message command")).toHaveCount(0);
    } finally {
      await page.evaluate((ids) => Promise.all(ids.map((id) => game.messages.get(id)?.delete())), newIds);
    }
  });

  test("typing /stats opens the stats dashboard and posts nothing", async ({ page }) => {
    await page.evaluate(async () => {
      const open = [...foundry.applications.instances.values()].filter((app) => app.hasFrame && app.rendered);
      await Promise.all(open.map((app) => app.close()));
      ui.sidebar.changeTab("chat", "primary");
      ui.sidebar.expand();
    });
    const before = await page.evaluate(() => game.messages.size);
    await page.locator('#chat-message [contenteditable="true"]').focus();
    await page.keyboard.type("/stats");
    await page.keyboard.press("Enter");

    // The dashboard shows either a fight or the empty notice, depending on what this world has recorded.
    await expect(page.locator("#pfm-stats")).toBeVisible();
    await expect(page.locator("#pfm-stats .pfm-head, #pfm-stats .pfm-empty").first()).toBeVisible();
    expect(await page.evaluate(() => game.messages.size)).toBe(before);
    await expect(page.getByText("is not a valid chat message command")).toHaveCount(0);
    await page.evaluate(() => foundry.applications.instances.get("pfm-stats")?.close());
  });

  test("pressing P opens the party sheet", async ({ page }) => {
    const isCrucible = await page.evaluate(() => game.system.id === "crucible");
    test.skip(!isCrucible, "The party sheet comes from the Crucible system");

    // Use a throwaway group actor as the party, and restore the setting afterwards.
    const { partyId, original } = await page.evaluate(async () => {
      const original = game.settings.get("crucible", "party");
      const party = await Actor.create({ name: "PFM Smoke Party", type: "group" });
      await game.settings.set("crucible", "party", party.id);
      await Promise.all([...foundry.applications.instances.values()].filter((a) => a.hasFrame && a.rendered).map((a) => a.close()));
      document.activeElement?.blur(); // Keybindings do not fire while a text field has focus.
      return { partyId: party.id, original };
    });

    try {
      await page.keyboard.press("p");
      await page.waitForFunction((id) => game.actors.get(id)?.sheet.rendered === true, partyId, { timeout: 10_000 });
    } finally {
      await page.evaluate(
        async ({ partyId, original }) => {
          const party = game.actors.get(partyId);
          await party?.sheet.close();
          await game.settings.set("crucible", "party", original);
          await party?.delete();
        },
        { partyId, original }
      );
    }
  });

  test("pressing C runs the module's handler and opens the assigned character", async ({ page }) => {
    // Core also binds C and opens the assigned character, so a rendered sheet alone proves nothing.
    // The module's own hook proves its handler ran instead of core's.
    const setup = await page.evaluate(async () => {
      globalThis.__pfmOpenCharacter = null;
      Hooks.once("pauls-foundry-module.openCharacter", (result) => (globalThis.__pfmOpenCharacter = result));
      const original = game.user.character?.id ?? null;
      // An adversary, not a hero. A blank Crucible hero opens the character builder, whose close waits on a dialog.
      const type = game.system.id === "crucible" ? "adversary" : "character";
      const hero = await Actor.create({ name: "PFM Smoke Hero", type });
      await game.user.update({ character: hero.id });
      await Promise.all([...foundry.applications.instances.values()].filter((a) => a.hasFrame && a.rendered).map((a) => a.close()));
      canvas?.tokens?.releaseAll();
      document.activeElement?.blur(); // Keybindings do not fire while a text field has focus.
      return { heroId: hero.id, heroUuid: hero.uuid, original };
    });

    try {
      await page.keyboard.press("c");
      const result = await page
        .waitForFunction(() => globalThis.__pfmOpenCharacter, null, { timeout: 10_000 })
        .then((h) => h.jsonValue());
      expect(result).toEqual({ mode: "open", uuid: setup.heroUuid });
      await page.waitForFunction((id) => game.actors.get(id)?.sheet.rendered === true, setup.heroId, { timeout: 10_000 });
    } finally {
      await page.evaluate(async ({ heroId, original }) => {
        const hero = game.actors.get(heroId);
        await hero?.sheet.close();
        await game.user.update({ character: original });
        await hero?.delete();
      }, setup);
    }
  });

  test("Quench batches pass", async ({ page }) => {
    const hasQuench = await page.evaluate(() => typeof globalThis.quench !== "undefined");
    test.skip(!hasQuench, "Quench is not active in the test world");

    const report = await page.evaluate(async (id) => {
      // Quench 0.10.0 on v14: its reporter throws if the results window is not rendered, and the run never ends.
      await quench.app.render(true);
      const runner = await quench.runBatches([`${id}.**`]);
      const failures = [];
      runner.on("fail", (t, err) => failures.push(`${t.fullTitle()}: ${err?.message}`));
      await new Promise((resolve) => runner.once("end", resolve));
      return { tests: runner.stats.tests, failures };
    }, MODULE_ID);

    expect(report.failures, report.failures.join("\n")).toEqual([]);
    expect(report.tests).toBeGreaterThan(0);
  });
});
