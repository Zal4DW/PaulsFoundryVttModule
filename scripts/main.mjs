import { greetingContent, HELLO_PATTERN, isHelloCommand } from "./lib/hello.mjs";
import { OPEN_PARTY_KEY, partyOpenDecision } from "./lib/party.mjs";
import { chooseCharacter, OPEN_CHARACTER_KEY } from "./lib/character.mjs";

const MODULE_ID = "pauls-foundry-module";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: "PFM.Settings.Enabled.Name",
    hint: "PFM.Settings.Enabled.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "greeting", {
    name: "PFM.Settings.Greeting.Name",
    hint: "PFM.Settings.Greeting.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "Hello from Paul's Foundry Module!"
  });
  game.settings.register(MODULE_ID, "keepCoreHotbar", {
    name: "PFM.Settings.KeepCoreHotbar.Name",
    hint: "PFM.Settings.KeepCoreHotbar.Hint",
    scope: "client", // Per user, like Crucible Tongs' own "Enable Actor on Hotbar" setting.
    config: true,
    type: Boolean,
    default: false, // Tongs' Macro tab holds the same 50 macro slots, so hiding the duplicate is the default.
    onChange: () => applyCoreHotbarVisibility()
  });

  // P opens the party sheet, for players and the GM. Keybindings must be registered during init.
  // Foundry does not run keybindings while the user types in a text field, so chat is not affected.
  game.keybindings.register(MODULE_ID, "openParty", {
    name: "PFM.Keybindings.OpenParty.Name",
    hint: "PFM.Keybindings.OpenParty.Hint",
    editable: [{ key: OPEN_PARTY_KEY }],
    onDown: () => {
      openParty();
      return true; // Consume the key press.
    },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });

  // C opens the user's character: the active-turn actor in combat, a single selected token, or a picker list.
  // Core also binds C (core.characterSheet, PRIORITY): a single selected token, else the assigned character.
  // Actions on one key run by precedence, then registration order, and modules register before core.
  // So PRIORITY puts this one first, and returning true stops core's handler.
  game.keybindings.register(MODULE_ID, "openCharacter", {
    name: "PFM.Keybindings.OpenCharacter.Name",
    hint: "PFM.Keybindings.OpenCharacter.Hint",
    editable: [{ key: OPEN_CHARACTER_KEY }],
    onDown: () => {
      openCharacter();
      return true; // Consume the key press, so core's character sheet toggle does not also run.
    },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY
  });

  // Public API, used by macros and by the Quench tests.
  game.modules.get(MODULE_ID).api = { sayHello, openParty, openCharacter };
});

Hooks.once("ready", () => {
  if (!game.settings.get(MODULE_ID, "enabled")) return;
  console.log(`${MODULE_ID} | ready (system: ${game.system.id})`);
  ui.notifications.info(game.i18n.localize("PFM.Ready"));
});

/** Post the greeting to chat. Works with any system (Crucible, etc.). */
async function sayHello() {
  const greeting = game.settings.get(MODULE_ID, "greeting");
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: greetingContent(greeting, foundry.utils.escapeHTML)
  });
}

/**
 * Open the party sheet, or bring it to the front if it is already open.
 * The party is the group actor set in Crucible's "Primary Adventuring Party" setting (crucible.party).
 * @returns {Promise<"missing"|"denied"|"open">}
 */
async function openParty() {
  const party = globalThis.crucible?.party ?? null;
  const canView = party?.testUserPermission(game.user, "LIMITED") ?? false;
  const decision = partyOpenDecision(party, canView);
  if (decision === "missing") ui.notifications.warn(game.i18n.localize("PFM.Party.Missing"));
  else if (decision === "denied") ui.notifications.warn(game.i18n.localize("PFM.Party.Denied"));
  else if (party.sheet.rendered) party.sheet.bringToFront();
  else await party.sheet.render({ force: true });
  return decision;
}

/** Open an actor's sheet, or bring it to the front if it is already open. */
async function showSheet(actor) {
  if (actor.sheet.rendered) actor.sheet.bringToFront();
  else await actor.sheet.render({ force: true });
}

/** Toggle an actor's sheet like core's C key: open it, restore it if minimized, or close it if open. */
async function toggleSheet(actor) {
  const sheet = actor.sheet;
  if (!sheet.rendered) await sheet.render({ force: true });
  else if (sheet.minimized) await sheet.maximize();
  else await sheet.close();
}

/**
 * Open the user's character sheet. See chooseCharacter in lib/character.mjs for the order.
 * Fires the "pauls-foundry-module.openCharacter" hook with the result, for macros and tests.
 * @returns {Promise<{mode: string, uuid?: string}>}
 */
async function openCharacter() {
  const result = await chooseAndOpenCharacter();
  Hooks.callAll(`${MODULE_ID}.openCharacter`, result);
  return result;
}

/** Candidates are keyed by uuid, because an unlinked token's actor shares its id with the base actor. */
async function chooseAndOpenCharacter() {
  const actors = new Map();
  const keep = (actor) => {
    if (!actor?.isOwner) return null;
    actors.set(actor.uuid, actor);
    return actor.uuid;
  };
  const ids = (list) => list.map(keep).filter(Boolean);

  const combat = game.combat;
  const tokens = canvas?.tokens?.controlled ?? [];
  const party = globalThis.crucible?.party ?? null;
  const decision = chooseCharacter({
    activeTurn: combat?.started ? keep(combat.combatant?.actor) : null,
    selected: ids(tokens.map((t) => t.actor)),
    targeted: ids([...game.user.targets].map((t) => t.actor)),
    assigned: keep(game.user.character),
    // For the GM, hasPlayerOwner limits this to player characters. Group actors such as the party are left out.
    owned: ids(game.actors.filter((a) => a.hasPlayerOwner && a.type !== "group" && a !== party))
  });

  if (decision.mode === "none") {
    ui.notifications.warn(game.i18n.localize("PFM.Character.None"));
    return decision;
  }
  if (decision.mode === "open") {
    await toggleSheet(actors.get(decision.id));
    return { mode: "open", uuid: decision.id };
  }

  // Several candidates: let the user pick. Closing the dialog resolves to null and opens nothing.
  const label = ({ id, hints }) => {
    const name = actors.get(id).name;
    if (!hints.length) return name;
    return `${name} (${hints.map((h) => game.i18n.localize(`PFM.Character.Hint.${h}`)).join(", ")})`;
  };
  const picked = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("PFM.Character.PickTitle") },
    content: `<p>${game.i18n.localize("PFM.Character.PickHint")}</p>`,
    buttons: decision.choices.map((choice, i) => ({ action: choice.id, label: label(choice), default: i === 0 })),
    rejectClose: false
  });
  if (picked) await showSheet(actors.get(picked));
  return { mode: "pick", uuid: picked ?? undefined };
}

// Crucible Tongs replaces Foundry's hotbar: its HotBarActor sets ui.hotbar.element.hidden at the end of
// every render. ApplicationV2 fires the renderHotBarActor hook after that, so un-hiding here keeps both.
const TONGS_HOTBAR_ID = "actor-hud";

function applyCoreHotbarVisibility() {
  const element = ui.hotbar?.element;
  if (!element) return;
  const tongsShowsActor = !!foundry.applications.instances.get(TONGS_HOTBAR_ID)?.actor;
  element.hidden = tongsShowsActor && !game.settings.get(MODULE_ID, "keepCoreHotbar");
}

Hooks.on("renderHotBarActor", () => applyCoreHotbarVisibility());

// Chat interaction: typing "/hello" posts the greeting instead of the raw text.
// v14 rejects unknown slash commands unless they are in ChatLog.CHAT_COMMANDS, so register there.
// v13 has no such registry, so it uses the chatMessage hook. Only one path is active, or the greeting posts twice.
Hooks.once("init", () => {
  const ChatLog = foundry.applications.sidebar.tabs.ChatLog;
  if (Number(game.version.split(".")[0]) >= 14 && ChatLog?.CHAT_COMMANDS) {
    ChatLog.CHAT_COMMANDS.hello = {
      rgx: HELLO_PATTERN,
      fn: async () => {
        if (game.settings.get(MODULE_ID, "enabled")) await sayHello();
        return false; // We created our own message, so ChatLog must not create one.
      }
    };
    return;
  }
  Hooks.on("chatMessage", (_log, message) => {
    if (!game.settings.get(MODULE_ID, "enabled")) return true;
    if (!isHelloCommand(message)) return true;
    sayHello();
    return false;
  });
});

// UI interaction: decorate our messages as they render.
Hooks.on("renderChatMessageHTML", (_message, html) => {
  if (html.querySelector(".pfm-message")) html.classList.add("pfm-chat-message");
});

// In-Foundry tests. This hook fires only when the Quench module is active, so players never load the tests.
Hooks.on("quenchReady", async (quench) => {
  const { registerQuenchBatches } = await import("./quench/batches.mjs");
  registerQuenchBatches(quench, MODULE_ID);
});
