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
});

Hooks.once("ready", () => {
  if (!game.settings.get(MODULE_ID, "enabled")) return;
  console.log(`${MODULE_ID} | ready (system: ${game.system.id})`);
  ui.notifications.info(game.i18n.localize("PFM.Ready"));
});

/** Post the greeting to chat. Works with any system (Crucible, etc.). */
async function sayHello() {
  const greeting = foundry.utils.escapeHTML(game.settings.get(MODULE_ID, "greeting"));
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: `<p class="pfm-message">${greeting}</p>`
  });
}

// Chat interaction: typing "/hello" posts the greeting instead of the raw text.
Hooks.on("chatMessage", (_log, message) => {
  if (!game.settings.get(MODULE_ID, "enabled")) return true;
  if (message.trim().toLowerCase() !== "/hello") return true;
  sayHello();
  return false;
});

// UI interaction: decorate our messages as they render.
Hooks.on("renderChatMessageHTML", (_message, html) => {
  if (html.querySelector(".pfm-message")) html.classList.add("pfm-chat-message");
});
