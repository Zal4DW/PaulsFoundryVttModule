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

        it("exposes sayHello and openParty on its API", () => {
          assert.isFunction(game.modules.get(moduleId).api?.sayHello);
          assert.isFunction(game.modules.get(moduleId).api?.openParty);
        });
      });

      describe("/hello chat command", () => {
        // The v14 chat box is ProseMirror, so typed text reaches processMessage as HTML.
        const typed = "<p>/hello</p>";

        it("is registered in ChatLog.CHAT_COMMANDS on v14", function () {
          if (Number(game.version.split(".")[0]) < 14) this.skip();
          const ChatLog = foundry.applications.sidebar.tabs.ChatLog;
          assert.property(ChatLog.CHAT_COMMANDS, "hello");
          assert.equal(ChatLog.parse(typed)[0], "hello");
        });

        it("posts the greeting and not the raw text", async () => {
          // With the setting off, the command posts nothing, and waiting for a message would hang.
          const wasEnabled = game.settings.get(moduleId, "enabled");
          if (!wasEnabled) await game.settings.set(moduleId, "enabled", true);
          try {
            const posted = new Promise((resolve) => Hooks.once("createChatMessage", resolve));
            const raw = await ui.chat.processMessage(typed);
            const message = await posted;
            created.push(message.id);
            if (raw) created.push(raw.id);
            assert.isUndefined(raw, "ChatLog posted the raw /hello text");
            assert.include(message.content, 'class="pfm-message"');
          } finally {
            if (!wasEnabled) await game.settings.set(moduleId, "enabled", false);
          }
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

  quench.registerBatch(
    `${moduleId}.party`,
    (context) => {
      const { describe, it, assert, before, after } = context;
      let original = null;
      let tempParty = null;

      describe("Open Party keybinding", () => {
        before(async function () {
          if (game.system.id !== "crucible") return this.skip();
          // Point Crucible's party setting at a throwaway group actor, and restore it afterwards.
          original = game.settings.get("crucible", "party");
          tempParty = await Actor.create({ name: "PFM Quench Party", type: "group" });
          await game.settings.set("crucible", "party", tempParty.id);
        });

        after(async () => {
          if (game.system.id !== "crucible") return;
          await tempParty?.sheet.close();
          await game.settings.set("crucible", "party", original);
          await tempParty?.delete();
        });

        it("is registered on the P key", () => {
          const action = game.keybindings.actions.get(`${moduleId}.openParty`);
          assert.exists(action);
          assert.isFalse(action.restricted, "players must be able to use it");
          const keys = game.keybindings.get(moduleId, "openParty").map((b) => b.key);
          assert.include(keys, "KeyP");
        });

        it("opens the party sheet", async () => {
          assert.equal(await game.modules.get(moduleId).api.openParty(), "open");
          assert.isTrue(tempParty.sheet.rendered);
        });

        it("reports a missing party", async () => {
          await game.settings.set("crucible", "party", null);
          try {
            assert.equal(await game.modules.get(moduleId).api.openParty(), "missing");
          } finally {
            await game.settings.set("crucible", "party", tempParty.id);
          }
        });
      });
    },
    { displayName: "Paul's Foundry Module: party" }
  );

  quench.registerBatch(
    `${moduleId}.character`,
    (context) => {
      const { describe, it, assert, before, after } = context;
      let originalCharacter = null;
      let temp = null;

      describe("Open Character keybinding", function () {
        // Creating and deleting documents can take longer than Mocha's 2 second default.
        this.timeout(10_000);

        before(async () => {
          originalCharacter = game.user.character?.id ?? null;
          // An adversary, not a hero. A blank Crucible hero opens the character builder, and closing
          // the builder waits on a confirmation dialog, so cleanup would never finish.
          temp = await Actor.create({ name: "PFM Quench Hero", type: game.system.id === "crucible" ? "adversary" : "character" });
        });

        after(async () => {
          await temp?.sheet.close();
          await game.user.update({ character: originalCharacter });
          await temp?.delete();
        });

        it("is registered on the C key", () => {
          const action = game.keybindings.actions.get(`${moduleId}.openCharacter`);
          assert.exists(action);
          assert.isFalse(action.restricted, "players must be able to use it");
          assert.include(game.keybindings.get(moduleId, "openCharacter").map((b) => b.key), "KeyC");
        });

        it("runs before core's C (character sheet) binding", function () {
          const core = game.keybindings.actions.get("core.characterSheet");
          if (!core) this.skip();
          const ours = game.keybindings.actions.get(`${moduleId}.openCharacter`);
          const compare = foundry.helpers.interaction.ClientKeybindings._compareActions;
          assert.isBelow(compare(ours, core), 0, "core's handler would consume C first");
        });

        it("opens the assigned character when it is the only candidate", async function () {
          // Other owned characters or selected tokens in the world would make this a picker instead.
          await game.user.update({ character: temp.id });
          const result = await game.modules.get(moduleId).api.openCharacter();
          if (result.mode === "pick") this.skip();
          assert.equal(result.mode, "open");
          assert.equal(result.uuid, temp.uuid);
          assert.isTrue(temp.sheet.rendered);
        });
      });
    },
    { displayName: "Paul's Foundry Module: character" }
  );
}
