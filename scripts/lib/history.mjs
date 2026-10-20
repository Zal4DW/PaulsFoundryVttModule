// Read a world's past chat history into stats: split old chat cards into fights and per-day sessions.
// Pure logic: no Foundry globals. scripts/stats/history.mjs builds metadata and saves the result.

/** How long after a combat's last card a further action card still counts as part of that combat. */
export const COMBAT_TAIL_MS = 10 * 60 * 1000;

/** A chat message the stats engine reads (the same set the live recorder keeps). */
export function isStatsCard(m) {
  const c = m.flags?.crucible ?? {};
  return !!(c.action || c.groupCheck || c.skill || c.isInitiativeReport || m.flags?.ember?.attunementAward);
}

/** The combat an "Initiative - Round N" report belongs to, from its table's data-combat-id. */
export function reportCombatId(m) {
  return /data-combat-id="([^"]+)"/.exec(String(m.content ?? ""))?.[1] ?? null;
}

/** The rows of an initiative report: each combatant's id and name, in turn order. */
export function reportRows(content) {
  const rows = [];
  for (const [, row] of String(content ?? "").matchAll(/<tr[^>]*data-combatant-id="[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)) rows.push(row);
  return [...String(content ?? "").matchAll(/data-combatant-id="([^"]+)"/g)].map((x, i) => ({
    combatantId: x[1],
    name: /initiative-name[^>]*>([^<]+)</.exec(rows[i] ?? "")?.[1]?.trim() ?? null
  }));
}

/** The session bucket for a timestamp, matching the live recorder ("session-YYYY-MM-DD", UTC). */
export const sessionIdFor = (ts) => `session-${new Date(ts).toISOString().slice(0, 10)}`;

/** True for an out-of-combat session bucket, which gets no Roll of Valour page (live play writes pages only for combats). */
export const isSessionId = (id) => String(id).startsWith("session-");

/**
 * Which fights need a Roll of Valour page written after an import: every combat just imported (its page may be stale),
 * and every stored combat that has no page yet. That backfills worlds whose fights all came from an import, without
 * writing a page twice: a fight's page is found by its fightId flag and rewritten in place.
 * @param {{imported?: string[], stored?: string[], withPages?: string[]}} ids
 * @returns {string[]}
 */
export function journalTargets({ imported = [], stored = [], withPages = [] } = {}) {
  const paged = new Set(withPages);
  const out = new Set(imported.filter((id) => !isSessionId(id)));
  for (const id of stored) if (!isSessionId(id) && !paged.has(id)) out.add(id);
  return [...out];
}

/**
 * Split chat messages into fights and sessions.
 * A combat starts at its first initiative report. Action cards (not tagged noncombat) and checks follow it
 * while the gap since the combat's last action is at most `tailMs`. Anything else (a Recover after the
 * fight, cards outside any combat) goes to the session for its day.
 * @param {object[]} messages                Chat message data (toObject()).
 * @param {object} [options]
 * @param {Set<string>} [options.knownIds]   Message ids already in the stats log. These are skipped.
 * @param {number} [options.tailMs]
 * @returns {{fights: {id: string, messages: object[], started: number, ended: number}[],
 *            sessions: {id: string, messages: object[]}[], skipped: number}}
 */
export function groupHistory(messages, { knownIds = new Set(), tailMs = COMBAT_TAIL_MS } = {}) {
  const sorted = messages.filter(isStatsCard).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const fights = new Map();
  const sessions = new Map();
  let current = null; // {id, lastTs}
  let skipped = 0;

  for (const m of sorted) {
    const ts = m.timestamp ?? 0;
    const c = m.flags?.crucible ?? {};
    let fightId = null;
    if (c.isInitiativeReport) {
      fightId = reportCombatId(m) ?? current?.id ?? `import-${m._id}`;
      current = { id: fightId, lastTs: ts };
    } else if (c.action && current && ts - current.lastTs <= tailMs && !(c.action.tags ?? []).includes("noncombat")) {
      fightId = current.id;
      current.lastTs = ts;
    } else if (!c.action && current && ts - current.lastTs <= tailMs) {
      // A check rolled mid-fight. The live recorder files it with the running combat, so do the same,
      // but don't let a check extend the combat window.
      fightId = current.id;
    } else if (current && ts - current.lastTs > tailMs) {
      current = null;
    }
    if (knownIds.has(m._id)) { skipped++; continue; }

    if (fightId) {
      const f = fights.get(fightId) ?? { id: fightId, messages: [], started: ts, ended: ts };
      f.messages.push(m);
      f.ended = ts;
      fights.set(fightId, f);
    } else {
      const id = sessionIdFor(ts);
      const s = sessions.get(id) ?? { id, messages: [] };
      s.messages.push(m);
      sessions.set(id, s);
    }
  }
  return { fights: [...fights.values()], sessions: [...sessions.values()], skipped };
}
