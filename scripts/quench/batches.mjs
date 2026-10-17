// Quench batches. They run inside a live Foundry world against the real `game` object.
// main.mjs loads this file from the quenchReady hook only.

export function registerQuenchBatches(quench, moduleId) {
  quench.registerBatch(
    `${moduleId}.hello`,
    (context) => {
      const { describe, it, assert, afterEach } = context;
      const created = [];

      afterEach(async () => {
        const ids = created.splice(0).filter((id) => game.messages.has(id));
        if (ids.length) await ChatMessage.deleteDocuments(ids);
      });

      describe("module", () => {
        it("is active", () => {
          assert.isTrue(game.modules.get(moduleId)?.active);
        });

        it("registers its settings", () => {
          assert.isTrue(game.settings.settings.has(`${moduleId}.enabled`));
          assert.isTrue(game.settings.settings.has(`${moduleId}.greeting`));
        });

        it("exposes sayHello on its API", () => {
          assert.isFunction(game.modules.get(moduleId).api?.sayHello);
        });
      });

      describe("chatMessage hook", () => {
        it("blocks the raw /hello text and posts the greeting instead", async () => {
          const posted = new Promise((resolve) => Hooks.once("createChatMessage", resolve));
          assert.isFalse(Hooks.call("chatMessage", ui.chat, "/hello", {}));
          const message = await posted;
          created.push(message.id);
          assert.include(message.content, 'class="pfm-message"');
        });

        it("lets other messages through", () => {
          assert.isTrue(Hooks.call("chatMessage", ui.chat, "just chatting", {}));
        });
      });

      describe("sayHello", () => {
        it("posts the greeting with the module markup", async () => {
          const message = await game.modules.get(moduleId).api.sayHello();
          created.push(message.id);
          // Compare the text, not the HTML. escapeHTML writes ' as &#x27;, but the stored content keeps a plain '.
          const el = document.createElement("div");
          el.innerHTML = message.content;
          assert.equal(el.querySelector(".pfm-message")?.textContent, game.settings.get(moduleId, "greeting"));
        });
      });
    },
    { displayName: "Paul's Foundry Module: hello" }
  );
}
