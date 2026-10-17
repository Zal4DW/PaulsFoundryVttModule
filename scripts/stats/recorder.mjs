// GM-side recorder: turns chat cards into stats records as they happen, and stores them for every user to read.
// Runs only on the active GM's client, so records are written once.
import { extractRecords } from "../lib/stats.mjs";
import { flushLog, updateLog } from "./store.mjs";

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
  return {
    key, name: tokenDoc?.name ?? actor?.name ?? key, type: actor?.type ?? null,
    important: !!actor?.system?.advancement?.important, actorId: actor?.id ?? null,
    combatantId: combatant?.id ?? null, linked: tokenDoc ? !!tokenDoc.actorLink : true,
    dead: !!(actor?.statuses?.has("dead") || combatant?.isDefeated), owners,
    img: tokenDoc?.texture?.src ?? actor?.img ?? null
  };
}

/** Make sure every combatant of the running combat has metadata, and refresh dead / defeated flags. */
function refreshMeta(fight, combat = game.combat) {
  for (const c of combat?.combatants ?? []) fight.meta[c.tokenId] = metaFor(c.tokenId, combat);
  for (const key of Object.keys(fight.meta)) {
    if (combat?.combatants.some((c) => c.tokenId === key)) continue;
    const fresh = metaFor(key, combat);
    // A deleted token (often a defeated minion) resolves to nothing. Keep what was recorded, or its kill is lost.
    if (!fresh.actorId) continue;
    fight.meta[key] = { ...fight.meta[key], ...fresh, combatantId: fight.meta[key].combatantId, dead: fight.meta[key].dead || fresh.dead };
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
  const relevant = crucible.action || crucible.groupCheck || crucible.isInitiativeReport;
  if (!relevant) return;
  const fightId = currentFightId();
  updateLog(moduleId, (log) => {
    const fight = (log.fights[fightId] ??= fightShell(fightId));
    refreshMeta(fight);
    const combat = game.combat;
    const rounds = combat?.started && !(crucible.action?.tags ?? []).includes("noncombat") ? { [message.id]: { round: combat.round, turn: combat.turn } } : {};
    const records = extractRecords([message.toObject()], { meta: fight.meta, rounds, moveFeet: feetForMovement(message) });
    for (const r of records) for (const key of [r.actor, ...(r.attacks ?? []).map((a) => a.target), ...(r.effects ?? []).map((e) => e.target)]) {
      if (key && !fight.meta[key]) fight.meta[key] = metaFor(key);
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
    // Ember attunements: flags.ember.attunements[type] = {current, rank, awards}. GMs award points; ranks follow.
    if (foundry.utils.getProperty(change, "flags.ember.attunements") !== undefined) {
      (options.pfmBefore ??= {}).attunements = foundry.utils.deepClone(actor.getFlag("ember", "attunements") ?? {});
    }
  });
  Hooks.on("updateActor", (actor, change, options) => {
    if (!isRecorder() || !options.pfmBefore) return;
    const delta = (k) => (foundry.utils.getProperty(actor, WATCHED[k]) ?? 0) - options.pfmBefore[k];
    if (options.pfmBefore.heroism !== undefined && game.combat?.started && delta("heroism") > 0) recordHeroism(moduleId, actor, delta("heroism"), "gain");
    if (options.pfmBefore.milestones !== undefined && delta("milestones") > 0) recordProgress(moduleId, actor, "milestone", delta("milestones"));
    if (options.pfmBefore.level !== undefined && delta("level") > 0) recordProgress(moduleId, actor, "levelUp", delta("level"), foundry.utils.getProperty(actor, WATCHED.level));
    if (options.pfmBefore.attunements) {
      const now = actor.getFlag("ember", "attunements") ?? {};
      for (const [type, p] of Object.entries(now)) {
        const was = options.pfmBefore.attunements[type] ?? {};
        const gained = (p?.current ?? 0) - (was.current ?? 0);
        const ranks = (p?.rank ?? 0) - (was.rank ?? 0);
        if (gained > 0 || ranks > 0) recordProgress(moduleId, actor, "attunement", Math.max(0, gained), null, { attunement: type, rank: p?.rank ?? null, ranksGained: Math.max(0, ranks) });
      }
    }
  });

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
    flushLog(moduleId);
  });

  // Keep dead / defeated flags current as the fight goes on.
  Hooks.on("updateCombat", (combat) => {
    if (!isRecorder() || !combat.started) return;
    updateLog(moduleId, (log) => refreshMeta((log.fights[combat.id] ??= fightShell(combat.id)), combat));
  });
}
