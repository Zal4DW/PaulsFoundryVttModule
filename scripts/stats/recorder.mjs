// GM-side recorder: turns chat cards into stats records as they happen, and stores them for every user to read.
// Runs only on the active GM's client, so records are written once.
import { aggregate, estimateMoves, extractRecords, isAlly, isHazardKey, mergeMeta } from "../lib/stats.mjs";
import { fightReport } from "../lib/stats-view.mjs";
import { flushLog, readLog, updateLog } from "./store.mjs";

/** Conditions worth a line in the stats: what a hero or adversary suffered, not every short buff. */
export const TRACKED_CONDITIONS = ["dead", "insane", "broken", "weakened", "frightened", "enraged", "restrained", "prone", "slowed", "staggered", "incapacitated",
  "blinded", "deafened", "disoriented", "exposed", "confused", "diseased", "bleeding", "burning"];

const isRecorder = () => game.user.isGM && game.users.activeGM?.id === game.user.id;

/** The fight a record belongs to: the running combat, or a per-day "session" bucket outside combat. */
function currentFightId() {
  const combat = game.combat;
  if (combat?.started) return combat.id;
  return `session-${new Date().toISOString().slice(0, 10)}`;
}

function fightShell(id) {
  const combat = game.combats.get(id);
  const scene = combat?.scene ?? canvas.scene;
  const date = new Date();
  return {
    id, started: Date.now(), ended: null, scene: scene?.name ?? null,
    grid: { gridSize: scene?.grid?.size ?? 100, gridDistance: scene?.grid?.distance ?? 5 },
    name: combat ? `${scene?.name ?? "Combat"} (${date.toLocaleDateString()})` : `Out of combat (${date.toLocaleDateString()})`,
    meta: {}, records: []
  };
}

/** Metadata for one token key (or "actor:<id>" for an actor with no token). */
export function metaFor(key, combat = game.combat) {
  const isActor = key.startsWith("actor:");
  const tokenDoc = isActor ? null : combat?.combatants.find((c) => c.tokenId === key)?.token ?? canvas.scene?.tokens.get(key) ?? game.scenes.find((s) => s.tokens.has(key))?.tokens.get(key) ?? null;
  const actor = isActor ? game.actors.get(key.slice(6)) : tokenDoc?.actor ?? null;
  const combatant = combat?.combatants.find((c) => c.tokenId === key) ?? null;
  const base = game.actors.get(actor?.id ?? "") ?? actor;
  const owners = game.users.filter((u) => !u.isGM && base?.testUserPermission(u, "OWNER")).map((u) => u.id);
  // Companions are adversary actors that fight for the party: party members (Ember adds its companions with
  // addMember), Friendly tokens, or actors this module flagged as a hero's companion.
  const ally = isAlly({
    type: actor?.type,
    partyMember: !!(base && globalThis.crucible?.party?.system?.members?.ids?.has(base.id)),
    friendly: (tokenDoc?.disposition ?? base?.prototypeToken?.disposition) === CONST.TOKEN_DISPOSITIONS.FRIENDLY,
    companion: !!base?.getFlag?.("pauls-foundry-module", "companionOf")
  });
  return {
    // Heroes show their own name. A token can be renamed (Ignis's token was "Anne"), so keep that as a mapping.
    key, name: (actor?.type === "hero" ? base?.name ?? actor.name : tokenDoc?.name ?? actor?.name) ?? key,
    tokenName: tokenDoc?.name ?? null, type: actor?.type ?? null, ally,
    important: !!actor?.system?.advancement?.important, rank: actor?.system?.advancement?.rank ?? null, actorId: actor?.id ?? null,
    combatantId: combatant?.id ?? null, linked: tokenDoc ? !!tokenDoc.actorLink : true,
    dead: !!(actor?.statuses?.has("dead") || combatant?.isDefeated), owners,
    // A GM marked it as fled from the combat tracker (scripts/stats/fled.mjs). It counts as out of the fight.
    fled: !!combatant?.getFlag("pauls-foundry-module", "fled"),
    img: tokenDoc?.texture?.src ?? actor?.img ?? null,
    // Where each combatant stands now. Read at the end of a fight, this says how it finished.
    statuses: [...(actor?.statuses ?? [])].filter((x) => TRACKED_CONDITIONS.includes(x)),
    state: snapshot(actor)
  };
}

function snapshot(actor) {
  const r = actor?.system?.resources;
  if (!r) return null;
  const v = (k) => (r[k] ? { value: r[k].value ?? 0, max: r[k].max ?? 0 } : null);
  return { health: v("health"), wounds: v("wounds"), morale: v("morale"), madness: v("madness") };
}

/** The stats key for an actor: its token in the running combat, else its token on the scene, else "actor:<id>". */
function keyForActor(actor, combat = game.combat) {
  if (actor?.isToken) return actor.token.id;
  return combat?.combatants.find((c) => c.actorId === actor?.id)?.tokenId ?? `actor:${actor?.id}`;
}

/** Make sure every combatant of the running combat has metadata, and refresh dead / defeated flags. */
function refreshMeta(fight, combat = game.combat) {
  // A deleted token resolves to nothing, so mergeMeta keeps what was recorded, or its name and kill are lost.
  for (const c of combat?.combatants ?? []) fight.meta[c.tokenId] = mergeMeta(fight.meta[c.tokenId], metaFor(c.tokenId, combat));
  for (const key of Object.keys(fight.meta)) {
    if (combat?.combatants.some((c) => c.tokenId === key)) continue;
    fight.meta[key] = mergeMeta(fight.meta[key], metaFor(key, combat), { inCombat: false });
  }
}

/** Exact feet moved for a Crucible movement id, from the token's movement history (cleared at turn change). */
function feetForMovement(message) {
  const mv = message.flags?.crucible?.events?.find((e) => e.type === "movement")?.movement;
  if (!mv?.id) return {};
  const tokenUuid = message.flags?.crucible?.token;
  const tokenDoc = tokenUuid ? fromUuidSync(tokenUuid) : null;
  const history = tokenDoc?._source?._movementHistory ?? [];
  const steps = history.filter((w) => w.movementId === mv.id);
  if (!steps.length) return {};
  const feet = steps.reduce((sum, w) => sum + (w.cost ?? 0), 0);
  return { [mv.id]: Math.round(feet) };
}

/** Turn one chat message into records and store them, replacing earlier records from the same message. */
function recordMessage(moduleId, message) {
  const crucible = message.flags?.crucible ?? {};
  const relevant = crucible.action || crucible.groupCheck || crucible.skill || crucible.isInitiativeReport || message.flags?.ember?.attunementAward;
  if (!relevant) return;
  const fightId = currentFightId();
  updateLog(moduleId, (log) => {
    const fight = (log.fights[fightId] ??= fightShell(fightId));
    refreshMeta(fight);
    const combat = game.combat;
    const rounds = combat?.started && !(crucible.action?.tags ?? []).includes("noncombat") ? { [message.id]: { round: combat.round, turn: combat.turn } } : {};
    const records = extractRecords([message.toObject()], { meta: fight.meta, rounds, moveFeet: feetForMovement(message) });
    for (const r of records) for (const key of [r.actor, ...(r.attacks ?? []).map((a) => a.target), ...(r.effects ?? []).map((e) => e.target)]) {
      // Hazards get no metadata: they are not combatants, and fightOutcome would count a typed entry as a foe.
      if (key && !isHazardKey(key) && !fight.meta[key]) fight.meta[key] = metaFor(key);
    }
    fight.records = fight.records.filter((r) => r.id !== message.id).concat(records);
  });
}

function recordHeroism(moduleId, actor, delta, reason) {
  const combat = game.combat;
  const token = combat?.combatants.find((c) => c.actorId === actor.id)?.tokenId;
  const key = token ?? `actor:${actor.id}`;
  const fightId = currentFightId();
  updateLog(moduleId, (log) => {
    const fight = (log.fights[fightId] ??= fightShell(fightId));
    fight.meta[key] ??= metaFor(key);
    fight.records.push({ id: `heroism-${foundry.utils.randomID()}`, ts: Date.now(), round: combat?.round ?? null, turn: combat?.turn ?? null, kind: "heroism", actor: key, amount: delta, reason });
  });
}

/** Milestones and level-ups, kept with the most recent fight so the dashboard shows them alongside it. */
function recordProgress(moduleId, actor, kind, amount, level = null, extra = {}) {
  updateLog(moduleId, (log) => {
    const fights = Object.values(log.fights).sort((a, b) => (b.started ?? 0) - (a.started ?? 0));
    const fight = fights.find((f) => !f.id.startsWith("session-")) ?? (log.fights[currentFightId()] ??= fightShell(currentFightId()));
    const key = Object.values(fight.meta).find((m) => m.actorId === actor.id && m.linked)?.key ?? `actor:${actor.id}`;
    fight.meta[key] ??= metaFor(key);
    const reason = kind === "milestone" ? Object.values(globalThis.crucible?.party?.system.advancement.milestones ?? {}).at(-1)?.reason ?? null : null;
    fight.records.push({ id: `${kind}-${foundry.utils.randomID()}`, ts: Date.now(), round: null, turn: null, kind, actor: key, amount, level, reason, ...extra });
  });
}

/** Record a tracked condition starting or ending on an actor: in the running combat, else in the session bucket. */
function recordCondition(moduleId, actor, status, on) {
  const combat = game.combat?.started ? game.combat : null;
  // Outside combat only heroes count (a Kaleidoscope crystal's Blinded, say), not the GM's set dressing.
  if (!combat && actor?.type !== "hero") return;
  const key = combat ? keyForActor(actor, combat) : `actor:${actor.id}`;
  const fightId = currentFightId();
  updateLog(moduleId, (log) => {
    const fight = (log.fights[fightId] ??= fightShell(fightId));
    fight.meta[key] ??= metaFor(key);
    fight.records.push({ id: `condition-${foundry.utils.randomID()}`, ts: Date.now(), round: combat?.round ?? null, turn: combat?.turn ?? null, kind: "condition", actor: key, status, on });
  });
}

/**
 * Add a GM note to a fight, for what the cards do not show (a ritual, a ruling, a surrender).
 * @param {string} fightId
 * @param {string|null} actorName  A combatant in that fight, or null for a note about the whole fight.
 * @param {string} text
 */
export async function addFightNote(moduleId, fightId, actorName, text) {
  updateLog(moduleId, (log) => {
    const fight = log.fights[fightId];
    if (!fight) throw new Error(`No stored fight ${fightId}`);
    const key = actorName ? Object.values(fight.meta).find((m) => m.name === actorName)?.key ?? null : null;
    fight.records.push({ id: `note-${foundry.utils.randomID()}`, ts: Date.now(), round: null, turn: null, kind: "note", actor: key, text });
  });
  await flushLog(moduleId);
}

/**
 * Set a fight's result by hand, over the one worked out from who is left standing.
 * @param {"victory"|"defeat"|"withdrawn"|null} result  null clears the override.
 */
export async function setFightOutcome(moduleId, fightId, result, note = "") {
  updateLog(moduleId, (log) => {
    const fight = log.fights[fightId];
    if (!fight) throw new Error(`No stored fight ${fightId}`);
    fight.outcome = result ? { result, note, by: "gm" } : null;
  });
  await flushLog(moduleId);
}

/** The fight journal (the "Roll of Valour"), found by flag so a GM can rename it. Created when first needed. */
export async function chronicleJournal(moduleId, { create = true } = {}) {
  const name = game.settings.get(moduleId, "chronicleName") || "Roll of Valour";
  let journal = game.journal.find((j) => j.getFlag(moduleId, "chronicle"));
  if (!journal && create) journal = await JournalEntry.create({ name, ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }, flags: { [moduleId]: { chronicle: true } } });
  return journal ?? null;
}

/** Write (or rewrite) the fight's page in the Roll of Valour, which players can read. */
export async function writeFightJournal(moduleId, fightId) {
  const fight = readLog(moduleId).fights[fightId];
  if (!fight) throw new Error(`No stored fight ${fightId}`);
  const stats = aggregate(estimateMoves(foundry.utils.deepClone(fight.records), fight.grid ?? {}), fight.meta, { outcome: fight.outcome });
  const content = fightReport(stats, fight);
  const journal = await chronicleJournal(moduleId);
  const page = journal.pages.find((pg) => pg.getFlag(moduleId, "fightId") === fightId);
  const data = { name: fight.name, type: "text", text: { content, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML }, flags: { [moduleId]: { fightId } } };
  if (page) await page.update(data);
  else await journal.createEmbeddedDocuments("JournalEntryPage", [data]);
  return journal;
}

/**
 * Re-extract a stored fight's records from its chat cards, after the stats engine changes.
 * Keeps each record's round and turn and any exact move distances. Records that do not come from a card
 * (Heroism, milestones, level-ups, attunements) are kept as they are. Cards deleted from chat keep their old records.
 * @returns {Promise<{rebuilt: number, kept: number}>}
 */
export async function rebuildFight(moduleId, fightId) {
  let result = null;
  updateLog(moduleId, (log) => {
    const fight = log.fights[fightId];
    if (!fight) throw new Error(`No stored fight ${fightId}`);
    // Fill in fields added since the fight was recorded (rank), from the base actor.
    for (const m of Object.values(fight.meta)) if (m.rank === undefined && m.actorId) m.rank = game.actors.get(m.actorId)?.system?.advancement?.rank ?? null;
    const byMessage = new Map();
    for (const r of fight.records) if (game.messages.has(r.id)) (byMessage.get(r.id) ?? byMessage.set(r.id, []).get(r.id)).push(r);
    const rounds = {}, moveFeet = {};
    for (const [id, recs] of byMessage) {
      const r = recs[0];
      if (r.round !== null && r.kind !== "initiative") rounds[id] = { round: r.round, turn: r.turn };
      for (const x of recs) if (x.move?.id && !x.move.estimated && x.move.feet !== null) moveFeet[x.move.id] = x.move.feet;
    }
    // Messages in time order, so initiative reports set rounds for the cards that follow them.
    const messages = [...byMessage.keys()].map((id) => game.messages.get(id)).sort((a, b) => a.timestamp - b.timestamp).map((m) => m.toObject());
    const fresh = extractRecords(messages, { meta: fight.meta, rounds, moveFeet });
    const kept = fight.records.filter((r) => !byMessage.has(r.id));
    fight.records = [...kept, ...fresh].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    result = { rebuilt: fresh.length, kept: kept.length };
  });
  await flushLog(moduleId);
  return result;
}

export function startRecorder(moduleId) {
  Hooks.on("createChatMessage", (message) => { if (isRecorder()) recordMessage(moduleId, message); });
  Hooks.on("updateChatMessage", (message) => { if (isRecorder()) recordMessage(moduleId, message); });

  // Crucible awards Heroism, milestones and levels without action cards, so watch the actor values themselves.
  // Spending Heroism shows up on action cards.
  const WATCHED = { heroism: "system.resources.heroism.value", milestones: "system.advancement.milestones", level: "system.advancement.level" };
  Hooks.on("preUpdateActor", (actor, change, options) => {
    for (const [k, path] of Object.entries(WATCHED)) {
      if (foundry.utils.getProperty(change, path) !== undefined) (options.pfmBefore ??= {})[k] = foundry.utils.getProperty(actor, path) ?? 0;
    }
    // Ember attunements are recorded from Ember's award chat card (see extractRecords), not from the actor flag:
    // Ember changes flags.ember.attunements in place before it saves, so this hook never sees the old value.
  });
  Hooks.on("updateActor", (actor, change, options) => {
    if (!isRecorder() || !options.pfmBefore) return;
    const delta = (k) => (foundry.utils.getProperty(actor, WATCHED[k]) ?? 0) - options.pfmBefore[k];
    if (options.pfmBefore.heroism !== undefined && game.combat?.started && delta("heroism") > 0) recordHeroism(moduleId, actor, delta("heroism"), "gain");
    if (options.pfmBefore.milestones !== undefined && delta("milestones") > 0) recordProgress(moduleId, actor, "milestone", delta("milestones"));
    if (options.pfmBefore.level !== undefined && delta("level") > 0) recordProgress(moduleId, actor, "levelUp", delta("level"), foundry.utils.getProperty(actor, WATCHED.level));
  });

  // Conditions come and go as Active Effects carrying status ids.
  const onEffect = (effect, on) => {
    if (!isRecorder() || !(effect.parent instanceof Actor)) return;
    for (const status of effect.statuses ?? []) if (TRACKED_CONDITIONS.includes(status)) recordCondition(moduleId, effect.parent, status, on);
  };
  Hooks.on("createActiveEffect", (effect) => onEffect(effect, true));
  Hooks.on("deleteActiveEffect", (effect) => onEffect(effect, false));

  // When combat ends, Heroism is cleared: record what each hero still held, then close the fight.
  Hooks.on("preDeleteCombat", (combat) => {
    if (!isRecorder() || !combat.started) return;
    updateLog(moduleId, (log) => {
      const fight = (log.fights[combat.id] ??= fightShell(combat.id));
      refreshMeta(fight, combat);
      for (const c of combat.combatants) {
        const held = c.actor?.type === "hero" ? c.actor.system.resources?.heroism?.value ?? 0 : 0;
        if (held > 0) fight.records.push({ id: `heroism-end-${c.id}`, ts: Date.now(), round: combat.round, turn: null, kind: "heroism", actor: c.tokenId, amount: held, reason: "combatEnd" });
      }
      fight.ended = Date.now();
    });
    // Save, then write the journal page from the saved fight.
    flushLog(moduleId).then(() => writeFightJournal(moduleId, combat.id)).catch((err) => console.error(`${moduleId} | fight journal`, err));
  });

  // Keep dead / defeated flags current as the fight goes on.
  Hooks.on("updateCombat", (combat) => {
    if (!isRecorder() || !combat.started) return;
    updateLog(moduleId, (log) => refreshMeta((log.fights[combat.id] ??= fightShell(combat.id)), combat));
  });

  // A combatant marked or cleared as fled: record it now, before the GM removes the token.
  Hooks.on("updateCombatant", (combatant, change) => {
    const combat = combatant.parent;
    if (!isRecorder() || !combat?.started || !foundry.utils.hasProperty(change, `flags.${moduleId}`)) return;
    updateLog(moduleId, (log) => refreshMeta((log.fights[combat.id] ??= fightShell(combat.id)), combat));
  });
}
