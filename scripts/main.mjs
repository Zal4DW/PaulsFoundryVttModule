import { greetingContent, HELLO_PATTERN, isHelloCommand } from "./lib/hello.mjs";

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

  // Public API, used by macros and by the Quench tests.
  game.modules.get(MODULE_ID).api = { sayHello };
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
