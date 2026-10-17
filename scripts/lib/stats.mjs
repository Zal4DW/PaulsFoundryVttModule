// Combat stats from Crucible chat data. Pure functions with no Foundry globals, so Vitest can test them in Node.
//
// Two stages:
//   extractRecords(messages, ctx)  -> flat, compact records (what happened, in order)
//   aggregate(records, meta)       -> per-combatant stats, party and adversary rollups, kills, timeline
// The GM recorder stores the records. Every client can then run aggregate() to draw the dashboard.

/** Crucible AttackRoll.RESULT_TYPES, by code. */
export const ATTACK_RESULTS = { 0: "miss", 1: "dodge", 2: "parry", 3: "block", 4: "armor", 5: "resist", 6: "glance", 7: "hit" };

/** Crucible's crit thresholds default to 6 when a roll does not set them. */
const CRIT = 6;

const parseRoll = (r) => (typeof r === "string" ? JSON.parse(r) : r);

/** The d8 (or other die) faces rolled, in order. */
export function diceFaces(roll) {
  const r = parseRoll(roll);
  return (r?.terms ?? []).filter((t) => t.class === "Die").flatMap((t) => (t.results ?? []).filter((x) => x.active !== false).map((x) => x.result));
}

/** Crucible check outcome: success needs total > DC, crit success total > DC + 6, crit failure total <= DC - 6. */
export function checkOutcome(total, dc, { critSuccess = CRIT, critFailure = CRIT } = {}) {
  if (dc === null || dc === undefined) return { success: null, critSuccess: false, critFailure: false };
  return { success: total > dc, critSuccess: total > dc + critSuccess, critFailure: total <= dc - critFailure };
}

/**
 * Resolve a Crucible actor uuid to a combatant key (the token id where possible).
 * "Scene.S.Token.T.Actor.A" -> "T". "Actor.A" (a linked actor) -> the token key whose actorId is A.
 */
export function actorKey(uuid, meta = {}) {
  if (!uuid) return null;
  const token = /Token\.([^.]+)/.exec(uuid)?.[1];
  if (token) return token;
  const actorId = /Actor\.([^.]+)$/.exec(uuid)?.[1];
  const hit = Object.values(meta).find((m) => m.actorId === actorId && m.linked !== false);
  return hit?.key ?? (actorId ? `actor:${actorId}` : null);
}

const keyForActorId = (actorId, meta) => Object.values(meta).find((m) => m.actorId === actorId)?.key ?? `actor:${actorId}`;

/** Sum resource deltas from a list of Crucible resource changes. */
function sumResources(resources = []) {
  const out = {};
  for (const r of resources) out[r.resource] = (out[r.resource] ?? 0) + (r.delta ?? 0);
  return out;
}

/**
 * Turn chat messages (Foundry ChatMessage data, as from toObject()) into records.
 * @param {object[]} messages
 * @param {object} ctx
 * @param {Record<string, object>} ctx.meta     Combatant metadata by key: {key, name, type, important, actorId, combatantId, linked}.
 * @param {Record<string, {round:number, turn:number}>} [ctx.rounds]  Combat position by message id (from Crucible actionHistory).
 * @param {Record<string, number>} [ctx.moveFeet]  Exact move distances by movement id, if the recorder captured them.
 */
export function extractRecords(messages, { meta = {}, rounds = {}, moveFeet = {} } = {}) {
  const records = [];
  let initRound = 1;
  let currentRound = null; // set by each "Initiative - Round N" report, used when ctx.rounds has no entry
  const positions = {}; // turn position by round and key, from the initiative reports

  for (const m of messages) {
    const c = m.flags?.crucible ?? {};
    const pos = rounds[m._id] ?? {};
    const noncombat = (c.action?.tags ?? []).includes("noncombat");
    const round = noncombat ? null : pos.round ?? currentRound;
    const actorKeyHere = c.action ? actorKey(c.actor, meta) : null;
    const base = { id: m._id, ts: m.timestamp, round, turn: noncombat ? null : pos.turn ?? positions[round]?.[actorKeyHere] ?? null };

    // Per-round initiative report: one roll per combatant, rows in turn order.
    if (c.isInitiativeReport) {
      const round = Number(/Round\s+(\d+)/i.exec(m.speaker?.alias ?? "")?.[1]) || initRound;
      const rows = [...String(m.content).matchAll(/data-combatant-id="([^"]+)"/g)].map((x) => x[1]);
      const rolls = (m.rolls ?? []).map(parseRoll);
      rows.forEach((combatantId, i) => {
        const key = Object.values(meta).find((x) => x.combatantId === combatantId)?.key ?? `combatant:${combatantId}`;
        const roll = rolls[i];
        records.push({ ...base, kind: "initiative", round, turn: null, actor: key, total: roll?.total ?? null, dice: roll ? diceFaces(roll) : [], position: i + 1, of: rows.length });
        (positions[round] ??= {})[key] = i + 1;
      });
      initRound = round + 1;
      currentRound = round;
      continue;
    }
    if (m.flags?.core?.initiativeRoll) continue; // individual rolls are repeated in the round report

    // Group checks (and single requested checks): one roll per actor.
    if (c.groupCheck) {
      const gc = c.groupCheck;
      for (const raw of m.rolls ?? []) {
        const r = parseRoll(raw);
        const actorId = r.data?.actorId;
        const skill = gc.actors?.[actorId]?.skillId ?? Object.keys(gc.skills ?? {})[0] ?? null;
        records.push({ ...base, kind: "check", group: gc.checkId, aggregate: !!gc.aggregate, actor: keyForActorId(actorId, meta), skill, total: r.total, dc: r.data?.dc ?? null, dice: diceFaces(r), boons: r.data?.totalBoons ?? 0, banes: r.data?.totalBanes ?? 0, ...checkOutcome(r.total, r.data?.dc, { critSuccess: r.data?.criticalSuccessThreshold ?? CRIT, critFailure: r.data?.criticalFailureThreshold ?? CRIT }) });
      }
      continue;
    }

    // Crucible action cards.
    if (c.action) {
      const actor = actorKey(c.actor, meta);
      const action = c.action;
      const events = c.events ?? [];
      const rolls = (m.rolls ?? []).map(parseRoll);
      const activation = events.find((e) => e.type === "activation");
      const spentRaw = sumResources(activation?.resources);
      const spent = {}, restored = {};
      for (const [k, v] of Object.entries(spentRaw)) (v < 0 ? spent : restored)[k] = Math.abs(v);

      const rec = { ...base, kind: "action", actor, actionId: action.id, actionName: action.name, tags: action.tags ?? [], confirmed: !!c.confirmed, spent, restored, attacks: [], effects: [] };

      // Attack rolls, matched to their events by rollIndex.
      for (const e of events.filter((x) => x.rollIndex !== undefined || x.type === "strike" || x.type === "attack")) {
        const r = rolls[e.rollIndex ?? 0];
        const res = sumResources((e.resources ?? []).filter((x) => x.resource !== "action"));
        const damageType = (e.resources ?? []).find((x) => x.damageType)?.damageType ?? r?.data?.damageType ?? null;
        const outcome = r ? checkOutcome(r.total, r.data?.dc, { critSuccess: r.data?.criticalSuccessThreshold ?? CRIT, critFailure: r.data?.criticalFailureThreshold ?? CRIT }) : {};
        rec.attacks.push({
          target: actorKey(e.target, meta),
          result: r ? ATTACK_RESULTS[r.data?.result] ?? String(r.data?.result) : null,
          total: r?.total ?? null, dc: r?.data?.dc ?? null, dice: r ? diceFaces(r) : [],
          critSuccess: !!outcome.critSuccess, critFailure: !!outcome.critFailure,
          flanked: !!r?.data?.flanked, boons: r?.data?.totalBoons ?? 0, banes: r?.data?.totalBanes ?? 0,
          health: -(res.health ?? 0), morale: -(res.morale ?? 0), wounds: res.wounds ?? 0, madness: res.madness ?? 0, damageType
        });
      }

      // Resource changes that are not attacks: healing, restoration, buffs, heroism awards.
      for (const e of events.filter((x) => x.type !== "activation" && x.rollIndex === undefined && x.type !== "strike" && x.type !== "attack")) {
        const res = sumResources(e.resources);
        if (Object.keys(res).length) rec.effects.push({ target: actorKey(e.target, meta), type: e.type, ...res });
      }

      // Movement: exact feet if captured live, otherwise estimated later from consecutive move origins.
      const mv = events.find((e) => e.type === "movement")?.movement;
      if (mv) rec.move = { id: mv.id, origin: mv.origin ?? null, feet: moveFeet[mv.id] ?? null, estimated: moveFeet[mv.id] === undefined };

      records.push(rec);
      continue;
    }

    // Resource records written by the live recorder (heroism gained, heroism lost at combat end, ...).
    if (m.flags?.["pauls-foundry-module"]?.statRecord) records.push({ ...base, ...m.flags["pauls-foundry-module"].statRecord });
  }
  return records;
}

/**
 * Estimate move distances (in feet) where the live recorder did not capture them:
 * the distance from one move's origin to the same actor's next move origin (or its final position).
 * @param {object[]} records
 * @param {{gridSize:number, gridDistance:number}} grid  Pixels per grid space and feet per grid space.
 * @param {Record<string, {x:number, y:number}>} [finalPositions]  Last known token position by key.
 */
export function estimateMoves(records, { gridSize = 100, gridDistance = 5 } = {}, finalPositions = {}) {
  const byActor = {};
  for (const r of records) if (r.kind === "action" && r.move) (byActor[r.actor] ??= []).push(r);
  for (const [key, moves] of Object.entries(byActor)) {
    moves.forEach((r, i) => {
      if (!r.move.estimated || !r.move.origin) return;
      const to = moves[i + 1]?.move.origin ?? finalPositions[key];
      if (!to) return;
      const px = Math.max(Math.abs(to.x - r.move.origin.x), Math.abs(to.y - r.move.origin.y));
      r.move.feet = Math.round((px / gridSize) * gridDistance);
    });
  }
  return records;
}

const blank = () => ({
  turns: 0, actions: 0,
  attacks: 0, hits: 0, glances: 0, misses: 0, crits: 0, fumbles: 0, avoidedBy: {},
  damageDealt: 0, moraleDamageDealt: 0, biggestHit: 0, woundsDealt: 0,
  attacksReceived: 0, avoided: 0, damageTaken: 0, moraleDamageTaken: 0, woundsTaken: 0,
  kills: 0, killsEarned: 0, killsStolen: 0, killsSolo: 0, assists: 0, deaths: 0,
  healingDone: 0, healingReceived: 0, buffs: 0,
  spellsCast: 0, focusSpent: 0, focusRestored: 0, refocuses: 0,
  heroismSpent: 0, heroismGained: 0, heroismLostAtEnd: 0,
  milestones: 0, levelsGained: 0, level: null, attunementPoints: 0, attunementRanks: 0, attunements: {},
  apSpent: 0, feetMoved: 0, feetEstimated: false, moves: 0,
  initiativeTotal: 0, initiativeRolls: 0, positionTotal: 0,
  checks: 0, checkSuccesses: 0, checkCrits: 0, checkFumbles: 0, checksBySkill: {},
  dice: { count: 0, sum: 0, faces: {} }, marginTotal: 0, marginCount: 0
});

const addDice = (s, faces) => { for (const f of faces) { s.dice.count++; s.dice.sum += f; s.dice.faces[f] = (s.dice.faces[f] ?? 0) + 1; } };
const isHealingAction = (r) => r.tags.includes("healing") || /heal|bloom|mend|restor/i.test(r.actionId);

/**
 * Aggregate records into stats.
 * @param {object[]} records  From extractRecords (and estimateMoves).
 * @param {Record<string, object>} meta  Combatant metadata by key: {key, name, type, important, dead}.
 */
export function aggregate(records, meta = {}) {
  const stats = {};
  const S = (key) => (stats[key] ??= { key, ...blank() });
  const side = (key) => (meta[key]?.type === "hero" ? "hero" : meta[key]?.type ? "adversary" : "unknown");

  // Damage ledger per target, in order, for kill attribution.
  const ledger = {};
  const turnsSeen = new Set();

  for (const r of records) {
    if (r.kind === "initiative") { const s = S(r.actor); s.initiativeTotal += r.total ?? 0; s.initiativeRolls++; s.positionTotal += r.position; addDice(s, r.dice); continue; }
    if (r.kind === "check") {
      const s = S(r.actor); s.checks++; addDice(s, r.dice);
      if (r.success) s.checkSuccesses++; if (r.critSuccess) s.checkCrits++; if (r.critFailure) s.checkFumbles++;
      if (r.dc !== null) { s.marginTotal += r.total - r.dc; s.marginCount++; }
      const b = (s.checksBySkill[r.skill] ??= { checks: 0, successes: 0 }); b.checks++; if (r.success) b.successes++;
      continue;
    }
    if (r.kind === "milestone") { S(r.actor).milestones += r.amount; continue; }
    if (r.kind === "attunement") { const s = S(r.actor); s.attunementPoints += r.amount; s.attunementRanks += r.ranksGained ?? 0; const a = (s.attunements[r.attunement] ??= { points: 0, rank: null }); a.points += r.amount; a.rank = r.rank ?? a.rank; continue; }
    if (r.kind === "levelUp") { const s = S(r.actor); s.levelsGained += r.amount; s.level = Math.max(s.level ?? 0, r.level ?? 0) || null; continue; }
    if (r.kind === "heroism") { const s = S(r.actor); if (r.reason === "combatEnd") s.heroismLostAtEnd += r.amount; else if (r.amount > 0) s.heroismGained += r.amount; continue; }
    if (r.kind !== "action") continue;

    const s = S(r.actor);
    s.actions++;
    if (r.round !== null) { const t = `${r.actor}:${r.round}`; if (!turnsSeen.has(t)) { turnsSeen.add(t); s.turns++; } }
    s.apSpent += r.spent.action ?? 0;
    s.focusSpent += r.spent.focus ?? 0;
    s.heroismSpent += r.spent.heroism ?? 0;
    s.focusRestored += r.restored.focus ?? 0;
    if (r.actionId === "refocus") s.refocuses++;
    if (r.tags.includes("spell") || r.actionId === "cast" || r.actionId?.startsWith("spell")) s.spellsCast++;
    if (r.move) { s.moves++; s.feetMoved += r.move.feet ?? 0; if (r.move.estimated) s.feetEstimated = true; }

    for (const a of r.attacks) {
      const t = S(a.target);
      s.attacks++; t.attacksReceived++;
      addDice(s, a.dice);
      if (a.dc !== null && a.total !== null) { s.marginTotal += a.total - a.dc; s.marginCount++; }
      if (a.critSuccess) s.crits++; if (a.critFailure) s.fumbles++;
      const dmg = Math.max(0, a.health) + Math.max(0, a.wounds);
      // A glance falls short of the defence but still deals reduced damage, so it counts as landed.
      if (a.result === "hit") s.hits++;
      else if (dmg > 0 || a.morale > 0) s.glances++;
      else { s.misses++; t.avoided++; s.avoidedBy[a.result] = (s.avoidedBy[a.result] ?? 0) + 1; }
      s.damageDealt += Math.max(0, a.health); t.damageTaken += Math.max(0, a.health);
      s.moraleDamageDealt += Math.max(0, a.morale); t.moraleDamageTaken += Math.max(0, a.morale);
      s.woundsDealt += Math.max(0, a.wounds); t.woundsTaken += Math.max(0, a.wounds);
      s.biggestHit = Math.max(s.biggestHit, dmg);
      if (dmg > 0) (ledger[a.target] ??= []).push({ by: r.actor, amount: dmg, round: r.round });
    }

    for (const e of r.effects) {
      const gain = Math.max(0, e.health ?? 0) + Math.max(0, e.morale ?? 0);
      if (gain && e.target) { if (e.target !== r.actor || isHealingAction(r)) { s.healingDone += gain; S(e.target).healingReceived += gain; } }
      if (e.heroism > 0) S(e.target).heroismGained += e.heroism;
    }
    if (!r.attacks.length && r.effects.some((e) => e.target && e.target !== r.actor) && !r.effects.some((e) => (e.health ?? 0) > 0)) s.buffs++;
    if (r.actionId === "inspireHeroism") s.buffs++;
  }

  // Kills: the final blow on each target that ended dead, with each attacker's share of its damage.
  const kills = [];
  for (const [target, hits] of Object.entries(ledger)) {
    if (!meta[target]?.dead) continue;
    const finisher = hits.at(-1).by;
    const share = {};
    for (const h of hits) share[h.by] = (share[h.by] ?? 0) + h.amount;
    const total = Object.values(share).reduce((a, b) => a + b, 0);
    const top = Object.entries(share).sort((a, b) => b[1] - a[1])[0][0];
    const kind = Object.keys(share).length === 1 ? "solo" : share[finisher] >= share[top] ? "earned" : "stolen";
    kills.push({ target, targetName: meta[target]?.name, important: !!meta[target]?.important, by: finisher, round: hits.at(-1).round, kind, topDamage: top, share: Object.fromEntries(Object.entries(share).map(([k, v]) => [k, { damage: v, percent: Math.round((v / total) * 100) }])) });
    const f = S(finisher); f.kills++;
    if (kind === "solo") f.killsSolo++; if (kind === "earned") f.killsEarned++; if (kind === "stolen") f.killsStolen++;
    for (const k of Object.keys(share)) if (k !== finisher) S(k).assists++;
    S(target).deaths++;
  }
  for (const [key, m] of Object.entries(meta)) if (m.dead && !kills.some((k) => k.target === key)) S(key).deaths++;

  // Derived values.
  for (const s of Object.values(stats)) {
    const m = meta[s.key] ?? {};
    Object.assign(s, { name: m.name ?? s.key, side: side(s.key), important: !!m.important });
    s.hitRate = s.attacks ? (s.hits + s.glances) / s.attacks : null;
    s.cleanHitRate = s.attacks ? s.hits / s.attacks : null;
    s.critRate = s.attacks ? s.crits / s.attacks : null;
    s.checkSuccessRate = s.checks ? s.checkSuccesses / s.checks : null;
    s.avgInitiative = s.initiativeRolls ? s.initiativeTotal / s.initiativeRolls : null;
    s.avgPosition = s.initiativeRolls ? s.positionTotal / s.initiativeRolls : null;
    s.avgDie = s.dice.count ? s.dice.sum / s.dice.count : null;
    s.ones = s.dice.faces[1] ?? 0;
    s.avgMargin = s.marginCount ? s.marginTotal / s.marginCount : null;
    s.mvp = mvpScore(s);
  }

  const heroes = Object.values(stats).filter((s) => s.side === "hero").sort((a, b) => b.mvp - a.mvp);
  const adversaryRows = Object.values(stats).filter((s) => s.side === "adversary");
  const majors = adversaryRows.filter((s) => s.important);
  const rollup = rollUp(adversaryRows.filter((s) => !s.important), "Adversaries");
  const rounds = Math.max(0, ...records.map((r) => r.round ?? 0));

  return {
    heroes, majorAdversaries: majors, adversaries: rollup, combatants: stats, kills,
    party: rollUp(heroes, "Party"),
    summary: { rounds, mvp: heroes[0]?.key ?? null, heroKills: kills.filter((k) => side(k.by) === "hero").length, adversaryKills: kills.filter((k) => side(k.by) === "adversary").length, heroDeaths: heroes.reduce((a, s) => a + s.deaths, 0) },
    timeline: timeline(records, meta, kills)
  };
}

/** MVP score: damage and kills first, then healing, support and accuracy. Documented in docs/stats.md. */
export function mvpScore(s) {
  return s.damageDealt + s.moraleDamageDealt + s.woundsDealt * 3 + s.killsSolo * 10 + s.killsEarned * 8 + s.killsStolen * 4 + s.assists * 3 + s.healingDone + s.buffs * 3 - s.deaths * 10;
}

const SUM_FIELDS = ["initiativeTotal", "initiativeRolls", "positionTotal", "marginTotal", "marginCount", "turns", "actions", "attacks", "hits", "glances", "misses", "crits", "fumbles", "damageDealt", "moraleDamageDealt", "woundsDealt", "attacksReceived", "avoided", "damageTaken", "moraleDamageTaken", "woundsTaken", "kills", "killsEarned", "killsStolen", "killsSolo", "assists", "deaths", "healingDone", "healingReceived", "buffs", "spellsCast", "focusSpent", "focusRestored", "refocuses", "heroismSpent", "heroismGained", "heroismLostAtEnd", "milestones", "levelsGained", "attunementPoints", "attunementRanks", "apSpent", "feetMoved", "moves", "checks", "checkSuccesses", "checkCrits", "checkFumbles"];

/** Sum a set of combatant stats into one row (used for the party and for minion adversaries). */
export function rollUp(rows, name) {
  const out = { key: name.toLowerCase(), name, members: rows.length };
  for (const f of SUM_FIELDS) out[f] = rows.reduce((a, s) => a + (s[f] ?? 0), 0);
  out.biggestHit = Math.max(0, ...rows.map((s) => s.biggestHit));
  out.hitRate = out.attacks ? (out.hits + out.glances) / out.attacks : null;
  out.cleanHitRate = out.attacks ? out.hits / out.attacks : null;
  out.avgInitiative = out.initiativeRolls ? out.initiativeTotal / out.initiativeRolls : null;
  out.avgPosition = out.initiativeRolls ? out.positionTotal / out.initiativeRolls : null;
  out.avgMargin = out.marginCount ? out.marginTotal / out.marginCount : null;
  const faces = {}; let count = 0, sum = 0;
  for (const s of rows) for (const [f, n] of Object.entries(s.dice?.faces ?? {})) { faces[f] = (faces[f] ?? 0) + n; count += n; sum += Number(f) * n; }
  out.dice = { count, sum, faces }; out.avgDie = count ? sum / count : null; out.ones = faces[1] ?? 0;
  out.feetEstimated = rows.some((s) => s.feetEstimated);
  const avoidedBy = {};
  for (const s of rows) for (const [k, v] of Object.entries(s.avoidedBy ?? {})) avoidedBy[k] = (avoidedBy[k] ?? 0) + v;
  out.avoidedBy = avoidedBy;
  return out;
}

/** Play-by-play lines, grouped by round. */
export function timeline(records, meta, kills) {
  const name = (k) => meta[k]?.name ?? k;
  const killAt = new Map(kills.map((k) => [k.target, k]));
  const lines = [];
  for (const r of records) {
    if (r.kind === "check") { lines.push({ round: r.round, text: `${name(r.actor)} rolls ${r.skill} ${r.total} vs DC ${r.dc}: ${r.critSuccess ? "critical success" : r.critFailure ? "critical failure" : r.success ? "success" : "failure"}` }); continue; }
    if (r.kind !== "action") continue;
    if (r.move) { lines.push({ round: r.round, text: `${name(r.actor)} moves${r.move.feet ? ` ${r.move.feet} ft${r.move.estimated ? " (est.)" : ""}` : ""}` }); continue; }
    if (r.attacks.length) {
      for (const a of r.attacks) {
        const k = killAt.get(a.target);
        const fatal = k && k.by === r.actor && a.health + a.wounds > 0 && !records.slice(records.indexOf(r) + 1).some((x) => x.attacks?.some((y) => y.target === a.target && y.health + y.wounds > 0));
        lines.push({ round: r.round, kill: !!fatal, text: `${name(r.actor)} ${r.actionName} → ${name(a.target)}: ${a.result}${a.health > 0 ? ` for ${a.health}` : ""}${a.morale > 0 ? ` (${a.morale} morale)` : ""}${a.critSuccess ? " CRIT" : ""}${fatal ? `: ${k.kind === "stolen" ? "KILL (stolen)" : "KILL"}` : ""}` });
      }
      continue;
    }
    lines.push({ round: r.round, text: `${name(r.actor)} ${r.actionName}` });
  }
  return lines;
}

/**
 * Build a stored fight from an exported fight file (see tools and test/fixtures): metadata, combat positions and
 * records, with move distances estimated from move origins and final token positions.
 */
export function fightFromExport(d, { id = d.combat?._id ?? "imported", name = null } = {}) {
  const meta = {};
  const rounds = {};
  for (const a of Object.values(d.actors ?? {})) {
    meta[a.tokenId] = {
      key: a.tokenId, name: a.name, type: a.type, important: !!a.important, actorId: a.actorId,
      combatantId: a.combatantId, linked: a.type === "hero", dead: (a.statuses ?? []).includes("dead") || !!a.defeated,
      owners: [], img: null
    };
    for (const h of a.actionHistory ?? []) if (h.combat) rounds[h.messageId] = { round: h.combat.round, turn: h.combat.turn };
  }
  const grid = { gridSize: d.gridSize ?? 100, gridDistance: d.gridDistance ?? 5 };
  const records = estimateMoves(extractRecords(d.messages ?? [], { meta, rounds }), grid, d.finalPositions ?? {});
  for (const [name2, amount] of Object.entries(d.heroismAtCombatEnd ?? {})) {
    const key = Object.values(meta).find((m) => m.name === name2 && m.type === "hero")?.key;
    if (key && amount > 0) records.push({ id: `heroism-end-${key}`, ts: null, round: null, turn: null, kind: "heroism", actor: key, amount, reason: "combatEnd" });
  }
  const times = (d.messages ?? []).map((m) => m.timestamp).filter(Boolean);
  return { id, name: name ?? `${d.scene ?? "Fight"} (imported)`, scene: d.scene ?? null, started: Math.min(...times), ended: Math.max(...times), grid, meta, records, imported: true };
}
