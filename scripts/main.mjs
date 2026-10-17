import { greetingContent, HELLO_PATTERN, isHelloCommand } from "./lib/hello.mjs";
import { OPEN_PARTY_KEY, partyOpenDecision } from "./lib/party.mjs";

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

  // Public API, used by macros and by the Quench tests.
  game.modules.get(MODULE_ID).api = { sayHello, openParty };
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
