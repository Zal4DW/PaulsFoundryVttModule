import { greetingContent, HELLO_PATTERN, isHelloCommand } from "./lib/hello.mjs";
import { OPEN_PARTY_KEY, partyOpenDecision } from "./lib/party.mjs";
import { chooseCharacter, OPEN_CHARACTER_KEY } from "./lib/character.mjs";
import { fightFromExport } from "./lib/stats.mjs";
import { StatsDashboard } from "./stats/dashboard.mjs";
import { addFightNote, chronicleJournal, rebuildFight, setFightOutcome, startRecorder, writeFightJournal } from "./stats/recorder.mjs";
import { registerStatsSettings, updateLog, flushLog } from "./stats/store.mjs";
import { registerGripToggle, toggleGrip } from "./grip.mjs";
import { importHistory } from "./stats/history.mjs";
import { dismissTosslight, placeTosslight, registerTosslight } from "./tosslight.mjs";
import { registerMedicalKit } from "./medical-kit.mjs";
import { getAddiction, registerDose, setAddiction } from "./dose.mjs";
import { registerMoveConfirm, syncMoveConfirmFlag } from "./move-confirm.mjs";
import { registerItemPiles } from "./item-piles.mjs";
import { registerFled } from "./stats/fled.mjs";

const MODULE_ID = "pauls-foundry-module";
const STATS_PATTERN = /^\/stats\s*$/i;
const STATS_IMPORT_PATTERN = /^\/stats\s+import\s*$/i;

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

  // The journal of fight write-ups. Renaming here renames the journal itself.
  game.settings.register(MODULE_ID, "chronicleName", {
    name: "PFM.Settings.ChronicleName.Name",
    hint: "PFM.Settings.ChronicleName.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "Roll of Valour",
    onChange: async (name) => { if (game.user.isGM) await (await chronicleJournal(MODULE_ID, { create: false }))?.update({ name }); }
  });

  // K opens the fight stats dashboard, L the same window on its Roll of Valour tab. Both work for players and the GM.
  // (V would suit "valour", but Crucible Tongs uses it for the previous combat turn.)
  game.keybindings.register(MODULE_ID, "openChronicle", {
    name: "PFM.Keybindings.OpenChronicle.Name",
    hint: "PFM.Keybindings.OpenChronicle.Hint",
    editable: [{ key: "KeyL" }],
    onDown: () => { openStats({ tab: "roll" }); return true; },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });
  game.keybindings.register(MODULE_ID, "openStats", {
    name: "PFM.Keybindings.OpenStats.Name",
    hint: "PFM.Keybindings.OpenStats.Hint",
    editable: [{ key: "KeyK" }],
    onDown: () => { openStats(); return true; },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });

  // Fight stats. Every user can read them; the GM client records them. A change re-draws open dashboards.
  registerStatsSettings(MODULE_ID, () => { if (statsApp?.rendered) statsApp.render(); });
  // GM-only "Mark as fled" in the combat tracker's row menu: a fled adversary counts as out of the fight.
  registerFled(MODULE_ID);

  // Crucible only: a grip toggle for Versatile weapons on actor sheets, Reveal's tosslight as real token light,
  // the Wound Medical Kit and the Dose of It'll Be Alright... with its addiction.
  if (game.system.id === "crucible") {
    registerGripToggle();
    registerTosslight(MODULE_ID);
    registerMedicalKit();
    registerDose(MODULE_ID);
    registerMoveConfirm(MODULE_ID);
    registerItemPiles(MODULE_ID);
    game.settings.register(MODULE_ID, "itemsAsEquipment", {
      name: "PFM.Settings.ItemsAsEquipment.Name",
      hint: "PFM.Settings.ItemsAsEquipment.Hint",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      requiresReload: true
    });
  }

  // Public API, used by macros and by the Quench tests.
  game.modules.get(MODULE_ID).api = { sayHello, openParty, openCharacter, openStats, openChronicle, importFight, toggleGrip,
    importHistory: (options) => importHistory(MODULE_ID, options), promptImportHistory,
    placeTosslight: (token, casterUuid) => placeTosslight(MODULE_ID, token, casterUuid),
    dismissTosslight: (token) => dismissTosslight(MODULE_ID, token),
    getAddiction: (actor) => getAddiction(MODULE_ID, actor).level,
    setAddiction: (actor, level) => {
      if (!Number.isFinite(level)) throw new Error(`setAddiction needs a finite number for the level, not ${level}`);
      return setAddiction(MODULE_ID, actor, { level: Math.max(0, Math.floor(level)), dosed: false });
    },
    rebuildFight: (fightId) => rebuildFight(MODULE_ID, fightId),
    addFightNote: (fightId, actorName, text) => addFightNote(MODULE_ID, fightId, actorName, text),
    setFightOutcome: (fightId, result, note) => setFightOutcome(MODULE_ID, fightId, result, note),
    writeFightJournal: (fightId) => writeFightJournal(MODULE_ID, fightId) };
});

// Add "Paul's Items" to Crucible's equipment packs, so Crucible Shop's default shop and character creation list them.
// Crucible fills crucible.CONFIG.packs from its Compendium Sources setting in its own setup hook, which is registered
// before this one, so the pack is added after Crucible has built the list. The GM's setting itself is not changed, and
// turning this module setting off does not remove the pack if the GM listed it there: Crucible's own setting wins.
Hooks.once("setup", () => {
  if (game.system.id !== "crucible" || !game.settings.get(MODULE_ID, "itemsAsEquipment")) return;
  const pack = `${MODULE_ID}.items`;
  if (game.packs.has(pack)) globalThis.crucible?.CONFIG?.packs?.equipment?.add(pack);
});

Hooks.once("ready", () => {
  if (game.system.id === "crucible") syncMoveConfirmFlag(MODULE_ID);
  startRecorder(MODULE_ID);
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

let statsApp = null;

/** Open the fight stats dashboard, or bring it to the front. */
async function openStats(options = {}) {
  statsApp ??= new StatsDashboard(MODULE_ID, options);
  if (options.tab) statsApp.tab = options.tab;
  if (statsApp.rendered) { statsApp.bringToFront(); if (options.tab) await statsApp.render(); }
  else await statsApp.render({ force: true });
  return statsApp;
}

/** Open the Roll of Valour journal, or tell the user it has no entries yet. */
async function openChronicle() {
  const journal = await chronicleJournal(MODULE_ID, { create: false });
  if (!journal) return ui.notifications.info(game.i18n.localize("PFM.Stats.NoChronicle"));
  if (!journal.testUserPermission(game.user, "OBSERVER")) return ui.notifications.warn(game.i18n.localize("PFM.Stats.NoChronicleAccess"));
  return journal.sheet.render({ force: true });
}

/**
 * Add a fight from an exported fight file (the shape of test/fixtures/day1-ring-of-valor.json). GM only.
 * @param {object|string} data  The export, or a URL to fetch it from.
 */
/**
 * "/stats import": read the world's past chat history into the stats. Shows what it would add, and saves only
 * when the GM confirms. Running it again adds nothing, because messages already in the log are skipped.
 */
async function promptImportHistory() {
  if (!game.user.isGM) { ui.notifications.warn(game.i18n.localize("PFM.Stats.History.GmOnly")); return null; }
  const preview = await importHistory(MODULE_ID, { dryRun: true });
  if (!preview.fights.length && !preview.sessions.length) {
    // Nothing new to import, but fights imported before the journal existed may still lack a Roll of Valour page.
    if (preview.pagesMissing) {
      const result = await importHistory(MODULE_ID, { dryRun: false });
      ui.notifications.info(game.i18n.format("PFM.Stats.History.PagesOnly", { pages: result.pages }));
      return result;
    }
    ui.notifications.info(game.i18n.format("PFM.Stats.History.Nothing", { skipped: preview.skipped }));
    return preview;
  }
  const esc = foundry.utils.escapeHTML;
  const line = (label, n) => `<li>${esc(label)}: ${esc(game.i18n.format("PFM.Stats.History.Cards", { cards: n }))}</li>`;
  const content = `<p>${esc(game.i18n.format("PFM.Stats.History.Preview", { fights: preview.fights.length, sessions: preview.sessions.length, skipped: preview.skipped }))}</p>
    <ul>${preview.fights.map((f) => line(f.name, f.cards)).join("")}${preview.sessions.map((s) => line(s.id, s.cards)).join("")}</ul>`;
  const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: game.i18n.localize("PFM.Stats.History.Title") }, content, rejectClose: false });
  if (!ok) return preview;
  const result = await importHistory(MODULE_ID, { dryRun: false });
  ui.notifications.info(game.i18n.format("PFM.Stats.History.Done", { fights: result.fights.length, sessions: result.sessions.length, pages: result.pages }));
  return result;
}

async function importFight(data, { id, name } = {}) {
  if (!game.user.isGM) throw new Error("Only a GM can import fights.");
  if (typeof data === "string") {
    const res = await fetch(data);
    if (!res.ok) throw new Error(`Could not load fight export ${data}: HTTP ${res.status}`);
    data = await res.json();
  }
  const fight = fightFromExport(data, { id, name });
  updateLog(MODULE_ID, (log) => { log.fights[fight.id] = fight; });
  await flushLog(MODULE_ID);
  ui.notifications.info(game.i18n.format("PFM.Stats.Import.Done", { name: fight.name }));
  return fight;
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
    ChatLog.CHAT_COMMANDS.stats = {
      rgx: STATS_PATTERN,
      fn: () => { openStats(); return false; }
    };
    ChatLog.CHAT_COMMANDS.statsImport = {
      rgx: STATS_IMPORT_PATTERN,
      fn: () => { promptImportHistory(); return false; }
    };
    return;
  }
  Hooks.on("chatMessage", (_log, message) => {
    if (STATS_PATTERN.test(message.trim())) { openStats(); return false; }
    if (STATS_IMPORT_PATTERN.test(message.trim())) { promptImportHistory(); return false; }
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
