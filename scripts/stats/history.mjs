// Import a world's past chat history into the stats log, for a world that installed the module late.
// Grouping is pure (lib/history.mjs); this file builds metadata from the world and saves.
import { actorKey, extractRecords, isHazardKey } from "../lib/stats.mjs";
import { groupHistory, journalTargets, reportRows } from "../lib/history.mjs";
import { chronicleJournal, metaFor, writeFightJournal } from "./recorder.mjs";
import { flushLog, readLog, updateLog } from "./store.mjs";

const actorIdOf = (uuid) => /Actor\.([^.]+)$/.exec(uuid ?? "")?.[1] ?? null;

/** Names (and actor ids) for keys, taken from the cards themselves, since old tokens may be gone. */
function namesFrom(messages) {
  const names = {};
  const put = (key, name, actorId) => { if (key && name && !names[key]) names[key] = { name, actorId }; };
  for (const m of messages) {
    const c = m.flags?.crucible ?? {};
    if (c.actor) put(actorKey(c.actor), m.speaker?.alias, actorIdOf(c.actor));
    for (const t of c.targets ?? []) {
      const id = actorIdOf(t.actor);
      put(actorKey(t.actor), game.actors.get(id)?.name, id);
    }
    if (c.isInitiativeReport) for (const r of reportRows(m.content)) put(`combatant:${r.combatantId}`, r.name, game.actors.getName(r.name)?.id ?? null);
  }
  return names;
}

/** Every key a record mentions. */
function keysOf(records) {
  const keys = new Set();
  for (const r of records) for (const k of [r.actor, ...(r.attacks ?? []).map((a) => a.target), ...(r.effects ?? []).map((e) => e.target), ...(r.heals ?? []).map((h) => h.target)]) {
    if (k && !isHazardKey(k)) keys.add(k);
  }
  return keys;
}

/** Metadata for an old fight: names from the cards, and no end state, since the actors have moved on since. */
function buildMeta(keys, names) {
  const meta = {};
  for (const key of keys) {
    const m = metaFor(key, null);
    const known = names[key];
    if (known && (m.name === key || !m.actorId)) {
      const actor = game.actors.get(known.actorId ?? "");
      Object.assign(m, { name: known.name, actorId: known.actorId ?? m.actorId, type: m.type ?? actor?.type ?? null });
    }
    Object.assign(m, { dead: false, statuses: [], state: null, combatantId: m.combatantId ?? null });
    meta[key] = m;
  }
  return meta;
}

/**
 * Point initiative rows ("combatant:<id>") at the creature's token key. Same-named creatures (three
 * drakelings) are paired in order: their rows in the first initiative report, with their tokens in the order
 * each first acts, since creatures act in initiative order.
 */
function mergeInitiativeKeys(records, meta) {
  const tokensByName = {};
  const firstAct = {};
  for (const r of records) if (r.kind === "action" && r.actor && !(r.actor in firstAct)) firstAct[r.actor] = r.ts ?? 0;
  for (const m of Object.values(meta)) if (!m.key.startsWith("combatant:")) (tokensByName[m.name] ??= []).push(m.key);
  for (const list of Object.values(tokensByName)) list.sort((a, b) => (firstAct[a] ?? Infinity) - (firstAct[b] ?? Infinity));
  const firstRound = Math.min(...records.filter((r) => r.kind === "initiative").map((r) => r.round ?? Infinity));
  const rowsByName = {};
  for (const r of records.filter((x) => x.kind === "initiative" && x.round === firstRound).sort((a, b) => a.position - b.position)) {
    if (r.actor?.startsWith("combatant:")) (rowsByName[meta[r.actor]?.name] ??= []).push(r.actor);
  }
  const map = {};
  for (const [name, rows] of Object.entries(rowsByName)) rows.forEach((row, i) => { const token = tokensByName[name]?.[i]; if (token) map[row] = token; });
  for (const r of records) {
    const token = map[r.actor];
    if (!token) continue;
    meta[token].combatantId ??= r.actor.slice(10);
    r.actor = token;
  }
  for (const key of Object.keys(meta)) if (key.startsWith("combatant:") && !records.some((r) => r.actor === key)) delete meta[key];
}

/**
 * Who died in an old fight. An adversary is dead when the health damage it took reaches its maximum health.
 * Heroes are never inferred dead: a hero at 0 health is only Weakened.
 */
function markDead(records, meta) {
  const taken = {};
  for (const r of records) {
    for (const a of r.attacks ?? []) taken[a.target] = (taken[a.target] ?? 0) + Math.max(0, a.health ?? 0);
    for (const h of r.heals ?? []) taken[h.target] = (taken[h.target] ?? 0) - Math.max(0, h.health ?? 0);
  }
  for (const [key, dmg] of Object.entries(taken)) {
    const m = meta[key];
    if (!m || m.type === "hero") continue;
    const max = game.actors.get(m.actorId ?? "")?.system?.resources?.health?.max;
    if (max && dmg >= max) m.dead = true;
  }
}

/** Records and metadata for one group of old messages. */
function build(messages, { combat = false } = {}) {
  const names = namesFrom(messages);
  const seed = buildMeta(new Set(Object.keys(names).filter((k) => !k.startsWith("combatant:"))), names);
  let records = extractRecords(messages, { meta: seed });
  const meta = buildMeta(keysOf(records), names);
  if (combat) {
    mergeInitiativeKeys(records, meta);
    // Who died, from the damage on the cards: the actors' statuses today say nothing about this old fight.
    markDead(records, meta);
  }
  records = records.map((r) => ({ ...r, imported: true }));
  return { records, meta };
}

/**
 * Read past chat history into the stats log.
 * @param {string} moduleId
 * @param {object} [options]
 * @param {number} [options.since]    Earliest message timestamp to read (ms).
 * @param {number} [options.until]    Latest message timestamp to read (ms).
 * @param {boolean} [options.dryRun]  Only report what would be added (the default).
 * @returns {Promise<{fights: object[], sessions: object[], skipped: number, saved: boolean}>}
 */
export async function importHistory(moduleId, { since = 0, until = Infinity, dryRun = true } = {}) {
  if (!game.user.isGM) throw new Error("Only a GM can import chat history into the stats.");
  const log = readLog(moduleId);
  const knownIds = new Set(Object.values(log.fights).flatMap((f) => f.records.map((r) => r.id)));
  const messages = game.messages.contents.filter((m) => m.timestamp >= since && m.timestamp <= until).map((m) => m.toObject());
  const grouped = groupHistory(messages, { knownIds });

  const fights = grouped.fights.map((g) => {
    const sceneId = g.messages.find((m) => m.speaker?.scene)?.speaker.scene;
    const scene = game.scenes.get(sceneId ?? "");
    const { records, meta } = build(g.messages, { combat: true });
    const date = new Date(g.started).toLocaleDateString();
    return {
      id: g.id, name: `${scene?.name ?? "Combat"} (${date})`, scene: scene?.name ?? null, started: g.started, ended: g.ended, imported: true,
      grid: { gridSize: scene?.grid?.size ?? 100, gridDistance: scene?.grid?.distance ?? 5 }, meta, records, cards: g.messages.length
    };
  });
  const sessions = grouped.sessions.map((g) => ({ id: g.id, cards: g.messages.length, ...build(g.messages) }));
  const summary = {
    fights: fights.map((f) => ({ id: f.id, name: f.name, started: f.started, cards: f.cards, records: f.records.length })),
    sessions: sessions.map((s) => ({ id: s.id, cards: s.cards, records: s.records.length })),
    skipped: grouped.skipped, saved: false, pages: 0
  };
  summary.pagesMissing = (await journalPlan(moduleId, [])).length;
  if (dryRun) return summary;
  if (!fights.length && !sessions.length) {
    summary.pages = await writeJournalPages(moduleId, []);
    return summary;
  }

  updateLog(moduleId, (l) => {
    for (const fight of fights) {
      const f = { ...fight };
      delete f.cards; // only for the preview
      const existing = l.fights[f.id];
      if (!existing) { l.fights[f.id] = f; continue; }
      Object.assign(existing.meta, Object.fromEntries(Object.entries(f.meta).filter(([k]) => !existing.meta[k])));
      existing.records = [...existing.records, ...f.records].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    }
    for (const s of sessions) {
      const day = s.id.slice(8);
      const target = (l.fights[s.id] ??= { id: s.id, started: Date.parse(day), ended: null, scene: null, name: `Out of combat (${new Date(Date.parse(day)).toLocaleDateString()})`, grid: { gridSize: 100, gridDistance: 5 }, meta: {}, records: [] });
      Object.assign(target.meta, Object.fromEntries(Object.entries(s.meta).filter(([k]) => !target.meta[k])));
      target.records = [...target.records, ...s.records].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      target.started = Math.min(target.started ?? Infinity, s.records[0]?.ts ?? Infinity);
    }
  });
  await flushLog(moduleId);
  summary.saved = true;
  summary.pages = await writeJournalPages(moduleId, fights.map((f) => f.id));
  return summary;
}

/** The fights to give a Roll of Valour page: see journalTargets. */
async function journalPlan(moduleId, imported) {
  const journal = await chronicleJournal(moduleId, { create: false });
  const withPages = journal?.pages.map((p) => p.getFlag(moduleId, "fightId")).filter(Boolean) ?? [];
  return journalTargets({ imported, stored: Object.keys(readLog(moduleId).fights), withPages });
}

/** Write (or rewrite) the Roll of Valour pages after an import. Returns how many pages were written. */
async function writeJournalPages(moduleId, imported) {
  let written = 0;
  for (const id of await journalPlan(moduleId, imported)) {
    await writeFightJournal(moduleId, id);
    written++;
  }
  return written;
}
