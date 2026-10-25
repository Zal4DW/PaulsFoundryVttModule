// Quench batches. They run inside a live Foundry world against the real `game` object.
// main.mjs loads this file from the quenchReady hook only.
import { decideApproval, handle as handleTrade } from "../merchant/trade.mjs";

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
          // Other owned characters or selected tokens in the world make this a picker instead. The picker waits
          // for a click, so close it as soon as it renders. openCharacter then resolves with nothing picked.
          await game.user.update({ character: temp.id });
          // A selected or targeted token outranks the assigned character, so clear both just before the call.
          canvas?.tokens?.releaseAll();
          canvas?.tokens?.setTargets([]);
          const closePicker = Hooks.on("renderDialogV2", (dialog) => dialog.close());
          let result;
          try {
            result = await game.modules.get(moduleId).api.openCharacter();
          } finally {
            Hooks.off("renderDialogV2", closePicker);
          }
          if (result.mode === "pick") this.skip();
          assert.equal(result.mode, "open");
          assert.equal(result.uuid, temp.uuid);
          assert.isTrue(temp.sheet.rendered);
        });

        // Out of combat on a travel map, a player's selected token is the party token. C used to open the party sheet.
        it("never offers a party group, and opens its member instead", async function () {
          if (game.system.id !== "crucible") this.skip();
          await temp.sheet.close();
          const group = await Actor.create({ name: "PFM Quench Party", type: "group", system: { members: [{ actorId: temp.id }] } });
          const offered = [];
          const closePicker = Hooks.on("renderDialogV2", (dialog) => {
            offered.push(...Object.keys(dialog.options.buttons ?? {}), ...(dialog.options.buttons ?? []).map?.((b) => b.action) ?? []);
            dialog.close();
          });
          let result;
          try {
            await game.user.update({ character: group.id });
            canvas?.tokens?.releaseAll();
            canvas?.tokens?.setTargets([]);
            result = await game.modules.get(moduleId).api.openCharacter();
          } finally {
            Hooks.off("renderDialogV2", closePicker);
            await game.user.update({ character: originalCharacter });
            await group.sheet?.close();
            await group.delete();
          }
          assert.include(["open", "pick"], result.mode, "C found no one to open");
          assert.notEqual(result.uuid, group.uuid, "C opened the party");
          assert.notInclude(offered, group.uuid, "the picker offered the party");
          if (result.mode === "open") assert.equal(result.uuid, temp.uuid);
          else assert.include(offered, temp.uuid, "the picker left out the party's member");
        });
      });
    },
    { displayName: "Paul's Foundry Module: character" }
  );

  quench.registerBatch(
    `${moduleId}.hotbar`,
    (context) => {
      const { describe, it, assert, before, after } = context;
      let original = true;
      const tongsBar = () => foundry.applications.instances.get("actor-hud");
      const rerender = async () => {
        await tongsBar().render({ force: true });
        await new Promise((resolve) => setTimeout(resolve, 200));
      };

      describe("Keep Foundry's hotbar with Crucible Tongs", function () {
        this.timeout(10_000);

        before(() => {
          original = game.settings.get(moduleId, "keepCoreHotbar");
        });

        after(async () => {
          await game.settings.set(moduleId, "keepCoreHotbar", original);
          if (tongsBar()?.actor) await rerender();
        });

        it("registers a per-user setting, off by default", () => {
          const setting = game.settings.settings.get(`${moduleId}.keepCoreHotbar`);
          assert.exists(setting);
          assert.equal(setting.scope, "client");
          assert.isFalse(setting.default, "Tongs replaces the hotbar by default");
        });

        it("keeps Foundry's hotbar visible when on, and lets Tongs hide it when off", async function () {
          // Needs Crucible Tongs active with its hotbar showing an actor (an assigned character or a selected token).
          if (!game.modules.get("crucibletongs")?.active || !tongsBar()?.actor) this.skip();

          await game.settings.set(moduleId, "keepCoreHotbar", true);
          await rerender();
          assert.isFalse(ui.hotbar.element.hidden, "Foundry's hotbar should stay visible");

          await game.settings.set(moduleId, "keepCoreHotbar", false);
          await rerender();
          assert.isTrue(ui.hotbar.element.hidden, "Tongs should hide Foundry's hotbar");
        });
      });
    },
    { displayName: "Paul's Foundry Module: hotbar" }
  );

  quench.registerBatch(
    `${moduleId}.tosslight`,
    (context) => {
      const { describe, it, assert, before, after, afterEach } = context;
      const api = () => game.modules.get(moduleId).api;
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let scene, priorScene, caster, ally, casterToken, allyToken, priorSetting;

      const releaseTargets = () => { for (const t of [...game.user.targets]) t.setTarget(false); };
      // Token#targetArrows is the "target arrows marker" (v14 docs). Foundry draws it every frame for a targeted token and
      // throws if the token is still drawing, so wait for it before targeting.
      const target = async (token) => {
        await until(() => token.object?.targetArrows);
        token.object.setTarget(true, { releaseOthers: true });
      };
      const revealCards = () => game.messages.contents.filter((m) => m.flags.crucible?.action?.id === "reveal"
        && [caster?.id, ally?.id].includes(m.speaker?.actor));
      /** Wait for a condition the module's async hooks settle, up to five seconds. */
      const until = async (test) => {
        for (let i = 0; i < 100 && !test(); i++) await sleep(50);
        return Boolean(test());
      };

      /**
       * Cast Reveal the way a player does: open Crucible's use dialog, click Use Action, then confirm the card as GM.
       * The bug was in the dialog, which disabled Use Action when the caster targeted themselves or nothing.
       */
      async function castReveal() {
        const warnings = [];
        const warn = ui.notifications.warn;
        ui.notifications.warn = (message, options) => { warnings.push(String(message?.message ?? message)); return warn.call(ui.notifications, message, options); };
        try { return await castRevealOnce(warnings); } finally { ui.notifications.warn = warn; }
      }

      async function castRevealOnce(warnings) {
        const using = caster.useAction("reveal");
        let dialog;
        await until(() => (dialog = [...foundry.applications.instances.values()]
          .find((a) => a.rendered && a.action?.id === "reveal" && a.actor === caster)));
        assert.exists(dialog, `Crucible's action use dialog did not open. ${warnings.join(" ")}`);
        const submit = dialog.element.querySelector('button[type="submit"][data-action="roll"]');
        if (submit.disabled) {
          const reason = submit.dataset.tooltip ?? "";
          await dialog.close();
          await using;
          assert.fail(`Use Action is disabled: ${reason}`);
        }
        submit.click();
        const action = await using;
        assert.exists(action, "Reveal was not used");
        // The card holds the targets now. Release them: Foundry v14 animates target arrows on each targeted token every
        // frame, and when the tosslight redraws a targeted token, Token#_drawTargetArrows throws on its missing graphic.
        releaseTargets();
        const card = revealCards().at(-1);
        // Crucible auto-confirms a GM's self-only cast in the background. Confirming it here too would race that.
        if (action.canAutoConfirm()) await until(() => card.flags.crucible.confirmed);
        else await globalThis.crucible.api.models.CrucibleAction.fromChatMessage(card).confirm();
        assert.isTrue(card.flags.crucible.confirmed, "the Reveal card was not confirmed");
        return card;
      }

      describe("Reveal's tosslight", function () {
        this.timeout(20_000);

        before(async function () {
          const rune = game.system.id === "crucible"
            ? (await game.packs.get("crucible.talent")?.getDocuments())?.find((d) => d.system.actions?.some((a) => a.id === "reveal"))
            : null;
          if (!rune) this.skip();
          priorSetting = game.settings.get(moduleId, "revealLight");
          await game.settings.set(moduleId, "revealLight", true);
          priorScene = game.scenes.viewed;
          scene = await CONFIG.Scene.documentClass.create({ name: "PFM Quench Tosslight", width: 1500, height: 1000 });
          await scene.view();
          // Adversaries get their resources from their level, so they can act straight away. Heroes need a full build.
          // createDocuments does not promise to return documents in input order, so look each one up by name.
          const actors = await Actor.createDocuments([
            { name: "PFM Quench Caster", type: "adversary", system: { details: { level: 3 } } },
            { name: "PFM Quench Ally", type: "adversary", system: { details: { level: 3 } } }
          ]);
          caster = actors.find((a) => a.name === "PFM Quench Caster");
          ally = actors.find((a) => a.name === "PFM Quench Ally");
          await caster.createEmbeddedDocuments("Item", [rune.toObject()]);
          const tokens = await Promise.all([caster, ally].map((a) => a.getTokenDocument({ actorLink: true })));
          const placed = await scene.createEmbeddedDocuments("Token", [
            { ...tokens[0].toObject(), x: 500, y: 500 },
            { ...tokens[1].toObject(), x: 600, y: 500 }
          ]);
          casterToken = placed.find((t) => t.actorId === caster.id);
          allyToken = placed.find((t) => t.actorId === ally.id);
          await until(() => casterToken.object?.targetArrows && allyToken.object?.targetArrows);
        });

        afterEach(async () => {
          releaseTargets();
          // Each cast spends Action; refill it so the next test can cast again.
          await caster?.update({ "system.resources.action.value": caster.system.resources.action.max });
          for (const token of [casterToken, allyToken]) if (token) await api().dismissTosslight(token);
        });

        after(async () => {
          releaseTargets();
          const cards = revealCards().map((m) => m.id);
          if (cards.length) await ChatMessage.deleteDocuments(cards);
          if (priorScene) await priorScene.view();
          await scene?.delete();
          for (const actor of [caster, ally]) await actor?.delete();
          if (priorSetting !== undefined) await game.settings.set(moduleId, "revealLight", priorSetting);
        });

        it("lets Reveal target its caster", () => {
          assert.isTrue(caster.actions.reveal.target.self);
        });

        it("lights the caster's own token when the caster targets themselves", async () => {
          await target(casterToken);
          const card = await castReveal();
          assert.equal(card.flags.crucible.targets?.[0]?.token, casterToken.uuid);
          assert.isTrue(await until(() => casterToken.getFlag(moduleId, "tosslight")), "no tosslight on the caster");
          assert.deepEqual([casterToken.light.bright, casterToken.light.dim], [20, 40]);
        });

        it("lights the caster's own token when nothing is targeted", async () => {
          releaseTargets();
          const card = await castReveal();
          const { token, targets, confirmed } = card.flags.crucible;
          assert.isTrue(await until(() => casterToken.getFlag(moduleId, "tosslight")),
            `no tosslight on the caster. Card: ${JSON.stringify({ token, targets, confirmed })}, caster ${casterToken.uuid}`);
          assert.deepEqual([casterToken.light.bright, casterToken.light.dim], [20, 40]);
        });

        it("still lights another token, and dismissing puts its light out", async () => {
          await target(allyToken);
          await castReveal();
          assert.isTrue(await until(() => allyToken.getFlag(moduleId, "tosslight")), "no tosslight on the ally");
          assert.equal(allyToken.light.bright, 20);
          assert.notExists(casterToken.getFlag(moduleId, "tosslight"));
          assert.isTrue(await api().dismissTosslight(allyToken));
          assert.deepEqual([allyToken.light.bright, allyToken.light.dim], [0, 0]);
          assert.notExists(allyToken.getFlag(moduleId, "tosslight"));
        });

        it("leaves Crucible's Reveal as it was while the setting is off", async () => {
          await game.settings.set(moduleId, "revealLight", false);
          try {
            caster.reset();
            assert.isFalse(caster.actions.reveal.target.self);
          } finally {
            await game.settings.set(moduleId, "revealLight", true);
            caster.reset();
          }
        });
      });
    },
    { displayName: "Paul's Foundry Module: Reveal's tosslight" }
  );

  quench.registerBatch(
    `${moduleId}.fled`,
    (context) => {
      const { describe, it, assert } = context;

      describe("Mark as fled in the combat tracker", () => {
        // The v14 docs only describe getDocumentContextOptions(application, menuItems) in general. This runs the
        // tracker's row menu event the way _createContextMenu does (default hook name "get{}ContextOptions"), so it
        // fails if Foundry stops firing getCombatTrackerContextOptions for combatant rows.
        it("adds Mark as fled and Clear fled to the combatant row menu", function () {
          if (!ui.combat?._getEntryContextOptions) this.skip();
          // Capture the array the hook receives: _doEvent is documented as returning void.
          let items = null;
          const hookId = Hooks.on("getCombatTrackerContextOptions", (_app, menuItems) => { items = menuItems; });
          try {
            ui.combat._doEvent(ui.combat._getEntryContextOptions, { hookName: "get{}ContextOptions", hookResponse: true });
          } finally {
            Hooks.off("getCombatTrackerContextOptions", hookId);
          }
          assert.isArray(items, "getCombatTrackerContextOptions did not fire for the combatant row menu");
          const labels = items.map((i) => i.label ?? i.name);
          assert.include(labels, "PFM.Stats.Fled.Mark");
          assert.include(labels, "PFM.Stats.Fled.Clear");
        });

        it("hides both entries from players", () => {
          const items = [];
          Hooks.call("getCombatTrackerContextOptions", ui.combat, items);
          const mark = items.find((i) => i.label === "PFM.Stats.Fled.Mark");
          assert.exists(mark);
          if (!game.user.isGM) assert.isFalse(mark.visible({ dataset: {} }));
          else assert.isFalse(mark.visible({ dataset: { combatantId: "no-such-combatant" } }), "no combatant, no entry");
        });
      });
    },
    { displayName: "Paul's Foundry Module: fled adversaries" }
  );

  quench.registerBatch(
    `${moduleId}.merchant`,
    (context) => {
      const { describe, it, assert, before, after } = context;
      const api = () => game.modules.get(moduleId).api;
      let merchant, hero, kitUuid;
      const flag = () => merchant.getFlag(moduleId, "merchant");
      const buy = (id, quantity, source = "catalogue") => api().merchantTrade({ action: "buy", merchantId: merchant.id, actorId: hero.id, source, id, quantity });

      describe("Merchant trades", function () {
        this.timeout(20_000);

        before(async function () {
          if (game.system.id !== "crucible" || !game.user.isGM) this.skip();
          const pack = game.packs.get(`${moduleId}.items`);
          const kit = (await pack.getIndex()).find((e) => e.name === "Wound Medical Kit");
          kitUuid = kit.uuid;
          merchant = await Actor.create({ name: "PFM Quench Merchant", type: "adversary" });
          // Not rendered, so the blank hero never opens Crucible's character builder.
          hero = await Actor.create({ name: "PFM Quench Buyer", type: "hero", system: { currency: 1000 } });
          await api().setMerchant(merchant, { buyRate: 50, catalogue: [{ id: "kit", uuid: kitUuid, count: 3 }] });
        });

        after(async () => {
          // Mocha runs after() even when before() skipped, and then merchant is undefined.
          if (merchant) {
            const receipts = game.messages.filter((m) => m.getFlag(moduleId, "merchantReceipt")?.merchantId === merchant.id);
            if (receipts.length) await ChatMessage.deleteDocuments(receipts.map((m) => m.id));
            await merchant.delete();
          }
          await hero?.delete();
        });

        it("makes the merchant visible to players", () => {
          assert.isAtLeast(merchant.ownership.default, CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED);
        });

        it("sells from the catalogue at the buy rate and stacks the items", async () => {
          const result = await buy("kit", 2);
          assert.isTrue(result.ok, result.reason);
          assert.equal(result.total, 300); // 2 × 300cp at 50%
          assert.equal(hero.system.currency, 700);
          const kits = hero.items.filter((i) => i.name === "Wound Medical Kit");
          assert.lengthOf(kits, 1);
          assert.equal(kits[0].system.quantity, 2);
          assert.equal(kits[0]._stats.compendiumSource, kitUuid);
          assert.equal(flag().catalogue[0].count, 1);
          assert.lengthOf(flag().log, 1);
        });

        it("refuses more than is in stock, then sells out", async () => {
          assert.equal((await buy("kit", 2)).reason, "notEnoughStock");
          assert.isTrue((await buy("kit", 1)).ok);
          assert.equal((await buy("kit", 1)).reason, "soldOut");
          assert.equal(hero.system.currency, 550);
        });

        it("gives the last one to only one of two buyers at once", async () => {
          await api().setMerchant(merchant, { catalogue: [{ id: "kit", uuid: kitUuid, count: 1 }] });
          const results = await Promise.all([buy("kit", 1), buy("kit", 1)]);
          assert.deepEqual(results.map((r) => r.ok ? "ok" : r.reason).sort(), ["ok", "soldOut"]);
          assert.equal(hero.system.currency, 400);
        });

        it("refuses a hero who can't pay", async () => {
          await api().setMerchant(merchant, { catalogue: [{ id: "kit", uuid: kitUuid, count: null }] });
          assert.equal((await buy("kit", 3)).reason, "notEnoughCoin");
          assert.equal(hero.system.currency, 400);
        });

        it("sells the merchant's own held items and removes them when gone", async () => {
          const kit = (await fromUuid(kitUuid)).toObject();
          kit.system.quantity = 2;
          const [held] = await merchant.createEmbeddedDocuments("Item", [kit]);
          assert.isTrue((await buy(held.id, 2, "held")).ok);
          assert.isFalse(merchant.items.has(held.id));
          assert.equal(hero.items.find((i) => i.name === "Wound Medical Kit").system.quantity, 6);
        });

        it("posts a receipt priced in Crucible coin", () => {
          const last = game.messages.filter((m) => m.getFlag(moduleId, "merchantReceipt")?.merchantId === merchant.id).at(-1);
          assert.exists(last);
          assert.include(last.content, globalThis.crucible.api.documents.CrucibleItem.formatCurrency(300));
        });

        it("opens the window with the stock and the purse in Crucible coin", async () => {
          const app = api().openMerchant(merchant, { heroId: hero.id });
          await new Promise((r) => setTimeout(r, 500));
          try {
            assert.isTrue(app.rendered);
            assert.include(app.element.querySelector(".pfm-merchant-purse").textContent, globalThis.crucible.api.documents.CrucibleItem.formatCurrency(hero.system.currency));
            assert.isAtLeast(app.element.querySelectorAll(".pfm-merchant-row").length, 1);
          } finally {
            await app.close();
          }
        });
      });
    },
    { displayName: "Paul's Foundry Module: merchants" }
  );

  quench.registerBatch(
    `${moduleId}.merchantSell`,
    (context) => {
      const { describe, it, assert, before, after } = context;
      const api = () => game.modules.get(moduleId).api;
      let merchant, hero, player, kitUuid, heroKit;
      const log = () => merchant.getFlag(moduleId, "merchant").log;
      const kitsOn = (actor) => actor.items.filter((i) => i.name === "Wound Medical Kit").reduce((n, i) => n + (i.system.quantity ?? 1), 0);
      const waitFor = async (fn, ms = 5000) => {
        for (let t = 0; t < ms; t += 100) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
        return null;
      };
      const receiptOf = (tradeId) => game.messages.find((m) => m.getFlag(moduleId, "merchantReceipt")?.tradeId === tradeId);

      describe("Merchant selling, approval and undo", function () {
        this.timeout(30_000);

        before(async function () {
          if (game.system.id !== "crucible" || !game.user.isGM) this.skip();
          const pack = game.packs.get(`${moduleId}.items`);
          kitUuid = (await pack.getIndex()).find((e) => e.name === "Wound Medical Kit").uuid;
          merchant = await Actor.create({ name: "PFM Quench Fence", type: "adversary" });
          hero = await Actor.create({ name: "PFM Quench Seller", type: "hero", system: { currency: 0 } });
          const kit = (await fromUuid(kitUuid)).toObject();
          kit.system.quantity = 3;
          [heroKit] = await hero.createEmbeddedDocuments("Item", [kit]);
          await api().setMerchant(merchant, { buyRate: 100, sellRate: 50, catalogue: [{ id: "kit", uuid: kitUuid, count: 2 }] });
        });

        after(async () => {
          // Mocha runs after() even when before() skipped, and then merchant is undefined.
          if (merchant) {
            const ours = game.messages.filter((m) => {
              const f = m.flags?.[moduleId];
              return (f?.merchantReceipt ?? f?.merchantApproval)?.merchantId === merchant.id;
            });
            if (ours.length) await ChatMessage.deleteDocuments(ours.map((m) => m.id));
            await merchant.delete();
          }
          await hero?.delete();
          await player?.delete();
        });

        it("buys from a hero at the sell rate and holds the items for resale", async () => {
          const result = await api().merchantTrade({ action: "sell", merchantId: merchant.id, actorId: hero.id, itemId: heroKit.id, quantity: 2 });
          assert.isTrue(result.ok, result.reason);
          assert.equal(hero.system.currency, 300); // 2 × 300cp at 50%
          assert.equal(kitsOn(hero), 1);
          assert.equal(kitsOn(merchant), 2);
          assert.equal(log().at(-1).action, "sell");
        });

        it("refuses to buy more than the hero holds", async () => {
          const result = await api().merchantTrade({ action: "sell", merchantId: merchant.id, actorId: hero.id, itemId: heroKit.id, quantity: 5 });
          assert.equal(result.reason, "notEnoughItems");
        });

        it("resells a held item at the buy rate", async () => {
          const held = merchant.items.find((i) => i.name === "Wound Medical Kit");
          const result = await api().merchantTrade({ action: "buy", merchantId: merchant.id, actorId: hero.id, source: "held", id: held.id, quantity: 1 });
          assert.isTrue(result.ok, result.reason);
          assert.equal(result.total, 300);
          assert.equal(hero.system.currency, 0);
          assert.equal(kitsOn(merchant), 1);
        });

        it("won't undo a sale once the merchant has resold the items", async () => {
          const sale = log().find((e) => e.action === "sell");
          const result = await api().merchantTrade({ action: "undo", merchantId: merchant.id, tradeId: sale.id });
          assert.equal(result.reason, "itemGone");
        });

        it("undoes the resale, then the sale, and marks both receipts", async () => {
          const resale = log().at(-1);
          assert.isTrue((await api().merchantTrade({ action: "undo", merchantId: merchant.id, tradeId: resale.id })).ok);
          assert.equal(hero.system.currency, 300);
          assert.equal(kitsOn(merchant), 2);
          const sale = log().find((e) => e.action === "sell");
          assert.isTrue((await api().merchantTrade({ action: "undo", merchantId: merchant.id, tradeId: sale.id })).ok);
          assert.equal(hero.system.currency, 0);
          assert.equal(kitsOn(hero), 3);
          assert.equal(kitsOn(merchant), 0);
          assert.isTrue(receiptOf(resale.id).getFlag(moduleId, "merchantReceipt").undone);
          assert.isTrue(receiptOf(sale.id).getFlag(moduleId, "merchantReceipt").undone);
          assert.equal((await api().merchantTrade({ action: "undo", merchantId: merchant.id, tradeId: sale.id })).reason, "alreadyUndone");
        });

        it("undoes a catalogue purchase and puts the stock back", async () => {
          await hero.update({ "system.currency": 600 });
          const bought = await api().merchantTrade({ action: "buy", merchantId: merchant.id, actorId: hero.id, source: "catalogue", id: "kit", quantity: 2 });
          assert.isTrue(bought.ok, bought.reason);
          assert.equal(merchant.getFlag(moduleId, "merchant").catalogue[0].count, 0);
          assert.isTrue((await api().merchantTrade({ action: "undo", merchantId: merchant.id, tradeId: bought.tradeId })).ok);
          assert.equal(merchant.getFlag(moduleId, "merchant").catalogue[0].count, 2);
          assert.equal(hero.system.currency, 600);
          assert.equal(kitsOn(hero), 3);
        });

        it("waits for the GM to approve a player's trade, and stops it when declined", async () => {
          player = await globalThis.User.create({ name: "PFM Quench Player", role: CONST.USER_ROLES.PLAYER });
          await hero.update({ [`ownership.${player.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
          await api().setMerchant(merchant, { requireApproval: true });
          const request = { action: "buy", merchantId: merchant.id, actorId: hero.id, source: "catalogue", id: "kit", quantity: 1 };
          const cardFor = (seen) => game.messages.find((m) => m.getFlag(moduleId, "merchantApproval") && !seen.includes(m.id) && !m.getFlag(moduleId, "merchantApproval").decided);

          let waited = false;
          const approvedTrade = handleTrade(moduleId, request, player.id, () => { waited = true; });
          const card = await waitFor(() => cardFor([]));
          assert.exists(card, "no approval card");
          assert.isTrue(waited, "the player was not told the trade is waiting");
          assert.deepEqual(card.whisper, game.users.filter((u) => u.isGM).map((u) => u.id));
          decideApproval(moduleId, card.getFlag(moduleId, "merchantApproval").approvalId, true);
          assert.isTrue((await approvedTrade).ok);
          assert.equal(hero.system.currency, 300);
          assert.equal((await waitFor(() => card.getFlag(moduleId, "merchantApproval").decided)), "approved");

          const declinedTrade = handleTrade(moduleId, request, player.id);
          const second = await waitFor(() => cardFor([card.id]));
          decideApproval(moduleId, second.getFlag(moduleId, "merchantApproval").approvalId, false);
          assert.equal((await declinedTrade).reason, "declined");
          assert.equal(hero.system.currency, 300);
        });

        it("lets a GM's own trade skip approval", async () => {
          const result = await api().merchantTrade({ action: "buy", merchantId: merchant.id, actorId: hero.id, source: "catalogue", id: "kit", quantity: 1 });
          assert.isTrue(result.ok, result.reason);
        });
      });
    },
    { displayName: "Paul's Foundry Module: merchant selling" }
  );

  quench.registerBatch(
    `${moduleId}.merchantSetup`,
    (context) => {
      const { describe, it, assert, before, after } = context;
      const api = () => game.modules.get(moduleId).api;
      const made = [];
      let kitUuid;

      describe("Merchant setup and import", function () {
        this.timeout(20_000);

        before(async function () {
          if (game.system.id !== "crucible" || !game.user.isGM) this.skip();
          kitUuid = (await game.packs.get(`${moduleId}.items`).getIndex()).find((e) => e.name === "Wound Medical Kit").uuid;
        });

        after(async () => {
          const ids = made.filter((id) => game.actors.has(id));
          if (ids.length) await Actor.deleteDocuments(ids);
        });

        it("extends the token class so a player's double-click can open a shop", () => {
          assert.equal(CONFIG.Token.objectClass.name, "MerchantToken");
          assert.isTrue(Object.hasOwn(CONFIG.Token.objectClass.prototype, "_onClickLeft2"));
        });

        // The v14 docs list getDocumentContextOptions only. The directory builds the hook name from the document name
        // (client/applications/sidebar/document-directory.mjs), so this fails if Foundry stops firing it for actors.
        it("adds Merchant setup and Open shop to the Actors sidebar menu", function () {
          if (!ui.actors?._getEntryContextOptions) this.skip();
          let items = null;
          const hookId = Hooks.on("getActorContextOptions", (_app, menuItems) => { items = menuItems; });
          try {
            ui.actors._doEvent(ui.actors._getEntryContextOptions, { hookName: `get${ui.actors.documentName}ContextOptions`, hookResponse: true });
          } finally {
            Hooks.off("getActorContextOptions", hookId);
          }
          assert.isArray(items, "getActorContextOptions did not fire");
          const labels = items.map((i) => i.label ?? i.name);
          assert.include(labels, "PFM.Merchant.Setup");
          assert.include(labels, "PFM.Merchant.Open");
        });

        it("saves rates, approval and catalogue counts from the setup window", async () => {
          const actor = await Actor.create({ name: "PFM Quench Setup", type: "adversary" });
          made.push(actor.id);
          await api().setMerchant(actor, { catalogue: [{ id: "kit", uuid: kitUuid, count: null }] });
          const app = api().configureMerchant(actor);
          await new Promise((r) => setTimeout(r, 500));
          try {
            const form = app.element;
            form.elements.buyRate.value = "70";
            form.elements.requireApproval.checked = true;
            form.elements["count.kit"].value = "4";
            form.elements["price.kit"].value = "123";
            form.requestSubmit();
            await new Promise((r) => setTimeout(r, 800));
            const data = actor.getFlag(moduleId, "merchant");
            assert.equal(data.buyRate, 70);
            assert.isTrue(data.requireApproval);
            assert.deepInclude(data.catalogue[0], { id: "kit", count: 4, price: 123 });
          } finally {
            await app.close();
          }
        });

        it("turns an Item Piles merchant into ours, keeps its items and turns Item Piles off", async () => {
          const kit = (await fromUuid(kitUuid)).toObject();
          kit.system.quantity = 2;
          const actor = await Actor.create({ name: "PFM Quench Muskrat", type: "adversary", items: [kit],
            flags: { "item-piles": { data: { enabled: true, type: "merchant", buyPriceModifier: 0.5, sellPriceModifier: 0.25 } } } });
          made.push(actor.id);
          await api().importItemPilesMerchant(actor);
          const data = actor.getFlag(moduleId, "merchant");
          assert.equal(data.buyRate, 50);
          assert.equal(data.sellRate, 25);
          assert.isFalse(actor.getFlag("item-piles", "data").enabled);
          assert.equal(actor.items.find((i) => i.name === "Wound Medical Kit").system.quantity, 2);
        });

        it("imports a Crucible Shop shop when Crucible Shop is active", async function () {
          if (!game.modules.get("crucible-shop")?.active) this.skip();
          const shops = game.settings.get("crucible-shop", "shops") ?? {};
          const shop = Object.values(shops).find((s) => s.mode !== "default" && s.itemUuids?.length);
          if (!shop) this.skip();
          const actor = await api().importCrucibleShop(shop.id);
          made.push(actor.id);
          const data = actor.getFlag(moduleId, "merchant");
          assert.lengthOf(data.catalogue, shop.itemUuids.length);
          assert.isTrue(data.catalogue.every((l) => l.count === null));
          const again = await api().importCrucibleShop(shop.id);
          assert.equal(again.id, actor.id, "importing twice updates the same actor");
        });
      });
    },
    { displayName: "Paul's Foundry Module: merchant setup" }
  );
}
