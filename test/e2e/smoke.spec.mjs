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

  test("/hello posts a decorated greeting", async ({ page }) => {
    const { messageId, rawMessageId } = await page.evaluate(async () => {
      const posted = new Promise((resolve) => Hooks.once("createChatMessage", resolve));
      // processMessage resolves to the created message, or to nothing when a chatMessage hook returns false.
      const raw = await ui.chat.processMessage("/hello");
      return { messageId: (await posted).id, rawMessageId: raw?.id ?? null };
    });

    try {
      // The v14 docs type the chatMessage hook as void. This checks that returning false still cancels the raw text.
      expect(rawMessageId, "the raw /hello text was posted to chat").toBeNull();
      await expect(page.locator(`[data-message-id="${messageId}"] .pfm-message`).first()).toBeAttached();
      await expect(page.locator(`[data-message-id="${messageId}"].pfm-chat-message`).first()).toBeAttached();
    } finally {
      await page.evaluate((ids) => Promise.all(ids.map((id) => game.messages.get(id)?.delete())), [messageId, rawMessageId]);
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
