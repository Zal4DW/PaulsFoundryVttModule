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

/**
 * True when a roll has dice. A defeated combatant's initiative row has an empty "0" roll and must not count.
 * Only roll totals are tracked, not individual die faces.
 */
export function hasDice(roll) {
  const r = parseRoll(roll);
  return (r?.terms ?? []).some((t) => t.class === "Die" && (t.results ?? []).length > 0);
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
/** The stats key for a hazard, from its name: "Caustic Slime" -> "hazard:caustic-slime". */
export const hazardKey = (name) => `hazard:${String(name ?? "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
export const isHazardKey = (key) => String(key ?? "").startsWith("hazard:");

/** Display names for hazard keys, from the records that carry them. */
function hazardNames(records) {
  const names = {};
  for (const r of records) if (r.hazard) names[r.actor] = r.actionName;
  return names;
}

export function actorKey(uuid, meta = {}) {
  if (!uuid) return null;
  const token = /Token\.([^.]+)/.exec(uuid)?.[1];
  if (token) return token;
  const actorId = /Actor\.([^.]+)$/.exec(uuid)?.[1];
  const hit = Object.values(meta).find((m) => m.actorId === actorId && m.linked !== false);
  return hit?.key ?? (actorId ? `actor:${actorId}` : null);
}

/** A readable name for a composed spell, whose card has no name: "spell.life.ray" -> "Ray of Life". */
export function spellName(id) {
  const [kind, rune, gesture] = String(id ?? "").split(".");
  if (kind !== "spell" || !rune || !gesture) return id ?? null;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(gesture)} of ${cap(rune)}`;
}

const keyForActorId =(actorId, meta) => Object.values(meta).find((m) => m.actorId === actorId)?.key ?? `actor:${actorId}`;

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
      // Defeated combatants keep a row with an empty roll. Leave them out, and rank the rest among themselves.
      const active = rows.map((combatantId, i) => ({ combatantId, roll: rolls[i] })).filter((x) => x.roll && hasDice(x.roll));
      active.forEach(({ combatantId, roll }, i) => {
        const key = Object.values(meta).find((x) => x.combatantId === combatantId)?.key ?? `combatant:${combatantId}`;
        records.push({ ...base, kind: "initiative", round, turn: null, actor: key, total: roll.total ?? null, position: i + 1, of: active.length });
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
        records.push({ ...base, kind: "check", group: gc.checkId, aggregate: !!gc.aggregate, actor: keyForActorId(actorId, meta), skill, total: r.total, dc: r.data?.dc ?? null, ...checkOutcome(r.total, r.data?.dc, { critSuccess: r.data?.criticalSuccessThreshold ?? CRIT, critFailure: r.data?.criticalFailureThreshold ?? CRIT }) });
      }
      continue;
    }

    // Ember's attunement award card: flags.ember.attunementAward, the hero as speaker, "<Type> Attunement" and "+N" in the table.
    // Read from the card because Ember changes the actor flag in place, so an actor update shows no change.
    if (m.flags?.ember?.attunementAward) {
      const type = /<th[^>]*>\s*([^<]+?)\s+Attunement\s*</i.exec(m.content ?? "")?.[1];
      const amount = Number(/report-value[^>]*>(?:\s*<i[^>]*><\/i>)?\s*([+-]?\d+)/.exec(m.content ?? "")?.[1]);
      if (m.speaker?.actor && type && amount) records.push({ ...base, round: null, turn: null, kind: "attunement", actor: keyForActorId(m.speaker.actor, meta), attunement: type.toLowerCase(), amount, rank: null, ranksGained: 0 });
      continue;
    }

    // A single skill check a hero rolls from their own sheet (or a journal check link): flags.crucible.skill, no group.
    if (c.skill && !c.action) {
      for (const raw of m.rolls ?? []) {
        const r = parseRoll(raw);
        if (!r?.data?.actorId && !m.speaker?.actor) continue;
        records.push({ ...base, kind: "check", actor: keyForActorId(r.data?.actorId ?? m.speaker.actor, meta), skill: c.skill, total: r.total, dc: r.data?.dc ?? null, ...checkOutcome(r.total, r.data?.dc, { critSuccess: r.data?.criticalSuccessThreshold ?? CRIT, critFailure: r.data?.criticalFailureThreshold ?? CRIT }) });
      }
      continue;
    }

    // Crucible action cards.
    if (c.action) {
      const action = c.action;
      // A hazard card (Caustic Slime, a rockfall) has no actor. Credit it to the hazard itself.
      const hazard = !c.actor && (action.tags ?? []).includes("hazard");
      const actor = hazard ? hazardKey(action.name) : actorKey(c.actor, meta);
      const events = c.events ?? [];
      const rolls = (m.rolls ?? []).map(parseRoll);
      const activation = events.find((e) => e.type === "activation");
      const spentRaw = sumResources(activation?.resources);
      const spent = {}, restored = {};
      for (const [k, v] of Object.entries(spentRaw)) (v < 0 ? spent : restored)[k] = Math.abs(v);

      const rec = { ...base, kind: "action", actor, ...(hazard ? { hazard: true } : {}), actionId: action.id, actionName: action.name ?? spellName(action.id), tags: action.tags ?? [], confirmed: !!c.confirmed, spent, restored, attacks: [], heals: [], effects: [] };

      // Attack rolls, matched to their events by rollIndex.
      for (const e of events.filter((x) => x.rollIndex !== undefined || x.type === "strike" || x.type === "attack")) {
        const r = rolls[e.rollIndex ?? 0];
        const res = sumResources((e.resources ?? []).filter((x) => x.resource !== "action"));
        const damageType = (e.resources ?? []).find((x) => x.damageType)?.damageType ?? r?.data?.damageType ?? null;
        const outcome = r ? checkOutcome(r.total, r.data?.dc, { critSuccess: r.data?.criticalSuccessThreshold ?? CRIT, critFailure: r.data?.criticalFailureThreshold ?? CRIT }) : {};
        // A healing spell (Rune of Life) is rolled like an attack but restores instead of damaging.
        if (r?.data?.restoration || (e.resources ?? []).some((x) => x.restoration)) {
          rec.heals.push({
            target: actorKey(e.target, meta), total: r?.total ?? null, dc: r?.data?.dc ?? null,
            result: r ? ATTACK_RESULTS[r.data?.result] ?? String(r.data?.result) : null,
            health: Math.max(0, res.health ?? 0), morale: Math.max(0, res.morale ?? 0),
            critSuccess: !!(e.isCriticalSuccess ?? outcome.critSuccess), critFailure: !!outcome.critFailure
          });
          continue;
        }
        rec.attacks.push({
          target: actorKey(e.target, meta),
          result: r ? ATTACK_RESULTS[r.data?.result] ?? String(r.data?.result) : null,
          total: r?.total ?? null, dc: r?.data?.dc ?? null,
          critSuccess: !!outcome.critSuccess, critFailure: !!outcome.critFailure,
          flanked: !!r?.data?.flanked,
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
  conditions: {}, healingDone: 0, healingReceived: 0, healCasts: 0, healSuccesses: 0, healCrits: 0, buffs: 0,
  spellsCast: 0, focusSpent: 0, focusRestored: 0, refocuses: 0,
  heroismSpent: 0, heroismGained: 0, heroismLostAtEnd: 0,
  milestones: 0, levelsGained: 0, level: null, attunementPoints: 0, attunementRanks: 0, attunements: {},
  apSpent: 0, feetMoved: 0, feetEstimated: false, moves: 0,
  initiativeTotal: 0, initiativeRolls: 0, positionTotal: 0,
  checks: 0, checkSuccesses: 0, checkCrits: 0, checkFumbles: 0, checksBySkill: {},
  combatRolls: blankRolls(), checkRolls: blankRolls(), hitDamage: blankRolls(),
  marginTotal: 0, marginCount: 0
});

/** Roll totals for one group: combat (attacks) or skill checks. Kept apart, because they mean different things. */
export function blankRolls() {
  return { count: 0, sum: 0, min: null, max: null, successes: 0, failures: 0, critSuccesses: 0, critFailures: 0 };
}

/**
 * Tally one attack or check roll by its total and outcome. Die faces are not tracked.
 * Rolls without a DC count toward the average, lowest and highest, but not toward successes or failures.
 */
function addRoll(g, roll) {
  if (roll.total === null || roll.total === undefined) return;
  g.count++; g.sum += roll.total;
  g.min = g.min === null ? roll.total : Math.min(g.min, roll.total);
  g.max = g.max === null ? roll.total : Math.max(g.max, roll.total);
  if (roll.dc === null || roll.dc === undefined) return;
  const success = roll.success ?? roll.total > roll.dc;
  if (success) g.successes++; else g.failures++;
  if (roll.critSuccess) g.critSuccesses++;
  if (roll.critFailure) g.critFailures++;
}

/** Add the average and success rate to a roll group. */
function finishRolls(g) {
  const decided = g.successes + g.failures;
  return Object.assign(g, { avg: g.count ? g.sum / g.count : null, successRate: decided ? g.successes / decided : null });
}

/** Merge roll groups, for the party and adversary rollups. */
function mergeRolls(groups) {
  const out = blankRolls();
  for (const g of groups) {
    if (!g?.count) continue;
    for (const k of ["count", "sum", "successes", "failures", "critSuccesses", "critFailures"]) out[k] += g[k];
    out.min = out.min === null ? g.min : Math.min(out.min, g.min);
    out.max = out.max === null ? g.max : Math.max(out.max, g.max);
  }
  return finishRolls(out);
}
const isHealingAction = (r) => r.tags.includes("healing") || /heal|bloom|mend|restor/i.test(r.actionId);

/**
 * Aggregate records into stats.
 * @param {object[]} records  From extractRecords (and estimateMoves).
 * @param {Record<string, object>} meta  Combatant metadata by key: {key, name, type, important, dead}.
 */
/** A major adversary: marked important, or ranked boss or elite. Major adversaries are listed on their own. */
export const isMajor = (m) => !!m?.important || ["boss", "elite"].includes(m?.rank);

/**
 * True when a non-hero fights for the party: a member of the party group (Ember adds its companions this way),
 * a token set to Friendly, or an actor flagged as a hero's companion. Crucible has no companion actor type,
 * so companions are adversary actors.
 */
export const isAlly = ({ type, partyMember = false, friendly = false, companion = false }) => !!type && type !== "hero" && (partyMember || friendly || companion);

/** Which side a key is on: "hero", "ally" (a companion), "adversary", "hazard" or "unknown". */
export function sideOf(key, m) {
  if (isHazardKey(key)) return "hazard";
  if (!m?.type) return "unknown";
  if (m.type === "hero") return "hero";
  return m.ally ? "ally" : "adversary";
}

/**
 * A combatant out of the fight: dead, insane, (for minions and ordinary adversaries) defeated, or fled.
 * A GM marks a fleeing adversary from the combat tracker (scripts/stats/fled.mjs). It left the fight, so it counts as beaten.
 */
export const isOut = (m) => !!m?.dead || !!m?.fled || (m?.statuses ?? []).some((x) => x === "dead" || x === "insane");

/**
 * The result of a fight from who is left standing. A GM override wins.
 * Defeat: every hero is dead or insane. Victory: every major adversary (or, with none, every adversary) is out.
 * @returns {{result: "victory"|"defeat"|"withdrawn"|"undecided", reason: string, by: "gm"|"auto"}}
 */
export function fightOutcome(meta, override = null) {
  if (override?.result) return { result: override.result, reason: override.note ?? "", by: "gm" };
  // Only combatants count. Heroes can be in a fight's data just for a milestone or level-up recorded after it.
  const fought = (m) => !!m.combatantId;
  const all = Object.values(meta);
  const pool = all.some(fought) ? all.filter(fought) : all;
  const heroes = pool.filter((m) => m.type === "hero");
  const foes = pool.filter((m) => sideOf(m.key ?? "", m) === "adversary"); // companions never decide a result
  const targets = foes.some(isMajor) ? foes.filter(isMajor) : foes;
  if (heroes.length && heroes.every(isOut)) return { result: "defeat", reason: "every hero is dead or insane", by: "auto" };
  if (targets.length && targets.every(isOut)) {
    const who = foes.some(isMajor) ? "every major adversary" : "every adversary";
    return { result: "victory", reason: `${who} is ${targets.some((m) => m.fled) ? "down or fled" : "down"}`, by: "auto" };
  }
  return { result: "undecided", reason: "both sides still had fighters standing when combat ended", by: "auto" };
}

/**
 * Aggregate records into stats.
 * @param {object} [options]
 * @param {object} [options.outcome]  A GM override for the fight result: {result, note}.
 */
export function aggregate(records, meta = {}, { outcome = null } = {}) {
  const stats = {};
  const S = (key) => (stats[key] ??= { key, ...blank() });
  const side = (key) => sideOf(key, meta[key]);
  const hazards = hazardNames(records);

  // Damage ledger per target, in order, for kill attribution.
  const ledger = {};
  const turnsSeen = new Set();

  for (const r of records) {
    if (r.kind === "initiative") { const s = S(r.actor); s.initiativeTotal += r.total ?? 0; s.initiativeRolls++; s.positionTotal += r.position; continue; }
    if (r.kind === "check") {
      const s = S(r.actor); s.checks++; addRoll(s.checkRolls, r);
      if (r.success) s.checkSuccesses++; if (r.critSuccess) s.checkCrits++; if (r.critFailure) s.checkFumbles++;
      if (r.dc !== null) { s.marginTotal += r.total - r.dc; s.marginCount++; }
      const b = (s.checksBySkill[r.skill] ??= { checks: 0, successes: 0 }); b.checks++; if (r.success) b.successes++;
      continue;
    }
    if (r.kind === "milestone") { S(r.actor).milestones += r.amount; continue; }
    if (r.kind === "attunement") { const s = S(r.actor); s.attunementPoints += r.amount; s.attunementRanks += r.ranksGained ?? 0; const a = (s.attunements[r.attunement] ??= { points: 0, rank: null }); a.points += r.amount; a.rank = r.rank ?? a.rank; continue; }
    if (r.kind === "levelUp") { const s = S(r.actor); s.levelsGained += r.amount; s.level = Math.max(s.level ?? 0, r.level ?? 0) || null; continue; }
    if (r.kind === "condition") { const s = S(r.actor); if (r.on) s.conditions[r.status] = (s.conditions[r.status] ?? 0) + 1; continue; }
    if (r.kind === "note") continue;
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
      addRoll(s.combatRolls, a);
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
      // Damage per hit: health plus wounds, over the attacks that dealt any.
      if (dmg > 0) addRoll(s.hitDamage, { total: dmg, dc: null });
      if (dmg > 0) (ledger[a.target] ??= []).push({ by: r.actor, amount: dmg, round: r.round });
    }

    // Healing spells: not attacks, so they stay out of hit rates, combat rolls and the kill ledger.
    for (const h of r.heals ?? []) {
      const gain = h.health + h.morale;
      s.healCasts++;
      if (gain > 0) { s.healSuccesses++; if (h.target !== r.actor) s.healingDone += gain; S(h.target).healingReceived += gain; }
      if (h.critSuccess) s.healCrits++;
    }

    for (const e of r.effects) {
      const gain = Math.max(0, e.health ?? 0) + Math.max(0, e.morale ?? 0);
      // Healing an ally is healing done. A healing action on yourself (a potion you drink) is only healing received.
      if (gain && e.target) {
        if (e.target !== r.actor) { s.healingDone += gain; S(e.target).healingReceived += gain; }
        else if (isHealingAction(r)) s.healingReceived += gain;
      }
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
    kills.push({ target, targetName: meta[target]?.name, important: isMajor(meta[target]), by: finisher, round: hits.at(-1).round, kind, topDamage: top, share: Object.fromEntries(Object.entries(share).map(([k, v]) => [k, { damage: v, percent: Math.round((v / total) * 100) }])) });
    const f = S(finisher); f.kills++;
    if (kind === "solo") f.killsSolo++; if (kind === "earned") f.killsEarned++; if (kind === "stolen") f.killsStolen++;
    for (const k of Object.keys(share)) if (k !== finisher) S(k).assists++;
    S(target).deaths++;
  }
  for (const [key, m] of Object.entries(meta)) if (m.dead && !kills.some((k) => k.target === key)) S(key).deaths++;
  // The ledger is keyed by target, so kills come out in no useful order. List them as they happened.
  kills.sort((a, b) => (a.round ?? Infinity) - (b.round ?? Infinity));

  // Derived values.
  for (const s of Object.values(stats)) {
    const m = meta[s.key] ?? {};
    Object.assign(s, { name: m.name ?? hazards[s.key] ?? s.key, side: side(s.key), important: !!m.important, major: isMajor(m), rank: m.rank ?? null, finalState: m.state ?? null, finalStatuses: m.statuses ?? [], fled: !!m.fled, out: isOut(m) });
    s.hitRate = s.attacks ? (s.hits + s.glances) / s.attacks : null;
    s.cleanHitRate = s.attacks ? s.hits / s.attacks : null;
    s.critRate = s.attacks ? s.crits / s.attacks : null;
    s.checkSuccessRate = s.checks ? s.checkSuccesses / s.checks : null;
    s.avgInitiative = s.initiativeRolls ? s.initiativeTotal / s.initiativeRolls : null;
    s.avgPosition = s.initiativeRolls ? s.positionTotal / s.initiativeRolls : null;
    finishRolls(s.combatRolls);
    finishRolls(s.checkRolls);
    finishRolls(s.hitDamage);
    s.avgMargin = s.marginCount ? s.marginTotal / s.marginCount : null;
    s.mvp = mvpScore(s);
  }

  // Heroes who took part: in the combat, or acted, rolled or were attacked. Not those only given a milestone afterwards.
  const tookPart = (s) => !!meta[s.key]?.combatantId || s.actions || s.initiativeRolls || s.checks || s.attacksReceived;
  const heroes = Object.values(stats).filter((s) => s.side === "hero" && tookPart(s)).sort((a, b) => b.mvp - a.mvp);
  const allies = Object.values(stats).filter((s) => s.side === "ally" && tookPart(s)).sort((a, b) => b.mvp - a.mvp);
  const onParty = (key) => ["hero", "ally"].includes(side(key));
  const adversaryRows = Object.values(stats).filter((s) => s.side === "adversary");
  const majors = adversaryRows.filter((s) => s.major);
  const rollup = rollUp(adversaryRows.filter((s) => !s.major), "Adversaries");
  const rounds = Math.max(0, ...records.map((r) => r.round ?? 0));

  return {
    heroes, allies, majorAdversaries: majors, adversaries: rollup, combatants: stats, kills,
    hazards: Object.values(stats).filter((s) => s.side === "hazard"),
    party: rollUp(heroes, "Party"),
    outcome: fightOutcome(meta, outcome),
    notes: records.filter((r) => r.kind === "note").map((r) => ({ actor: r.actor ? meta[r.actor]?.name ?? r.actor : null, text: r.text })),
    // Party kills include the companions' kills.
    summary: { rounds, mvp: heroes[0]?.key ?? null, heroKills: kills.filter((k) => onParty(k.by)).length, adversaryKills: kills.filter((k) => side(k.by) === "adversary").length, heroDeaths: heroes.reduce((a, s) => a + s.deaths, 0) },
    timeline: timeline(records, meta, kills)
  };
}

/** MVP score: damage and kills first, then healing, support and accuracy. Documented in docs/stats.md. */
export function mvpScore(s) {
  return s.damageDealt + s.moraleDamageDealt + s.woundsDealt * 3 + s.killsSolo * 10 + s.killsEarned * 8 + s.killsStolen * 4 + s.assists * 3 + s.healingDone + s.buffs * 3 - s.deaths * 10;
}

const SUM_FIELDS = ["initiativeTotal", "initiativeRolls", "positionTotal", "marginTotal", "marginCount", "turns", "actions", "attacks", "hits", "glances", "misses", "crits", "fumbles", "damageDealt", "moraleDamageDealt", "woundsDealt", "attacksReceived", "avoided", "damageTaken", "moraleDamageTaken", "woundsTaken", "kills", "killsEarned", "killsStolen", "killsSolo", "assists", "deaths", "healingDone", "healingReceived", "healCasts", "healSuccesses", "healCrits", "buffs", "spellsCast", "focusSpent", "focusRestored", "refocuses", "heroismSpent", "heroismGained", "heroismLostAtEnd", "milestones", "levelsGained", "attunementPoints", "attunementRanks", "apSpent", "feetMoved", "moves", "checks", "checkSuccesses", "checkCrits", "checkFumbles"];

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
  out.combatRolls = mergeRolls(rows.map((s) => s.combatRolls));
  out.checkRolls = mergeRolls(rows.map((s) => s.checkRolls));
  out.hitDamage = mergeRolls(rows.map((s) => s.hitDamage));
  out.feetEstimated = rows.some((s) => s.feetEstimated);
  const avoidedBy = {};
  for (const s of rows) for (const [k, v] of Object.entries(s.avoidedBy ?? {})) avoidedBy[k] = (avoidedBy[k] ?? 0) + v;
  out.avoidedBy = avoidedBy;
  out.checksBySkill = {};
  for (const s of rows) {
    for (const [k, v] of Object.entries(s.checksBySkill ?? {})) {
      const b = (out.checksBySkill[k] ??= { checks: 0, successes: 0 });
      b.checks += v.checks; b.successes += v.successes;
    }
  }
  return out;
}

/** Merge one combatant's rows from several fights into one row, with the per-hero fields rollUp leaves out. */
function mergeCombatant(rows, key, name) {
  const out = rollUp(rows, name);
  out.key = key;
  delete out.members;
  out.biggestHit = Math.max(0, ...rows.map((s) => s.biggestHit ?? 0));
  out.critRate = out.attacks ? out.crits / out.attacks : null;
  out.checkSuccessRate = out.checks ? out.checkSuccesses / out.checks : null;
  out.level = Math.max(0, ...rows.map((s) => s.level ?? 0)) || null;
  out.conditions = {};
  for (const s of rows) {
    for (const [k, v] of Object.entries(s.conditions ?? {})) out.conditions[k] = (out.conditions[k] ?? 0) + v;
  }
  out.mvp = mvpScore(out);
  return out;
}

/** A fight that came from a combat, not the out-of-combat bucket for one session. */
export const isCombatFight = (f) => !String(f?.id ?? "").startsWith("session-");

/**
 * Stats to date: every fight added up. Heroes merge across fights by actor, so a hero keeps one row
 * when their token changes. Major adversaries merge by name. Other adversaries are rolled up into one row.
 * @param {object[]} fights  Stored fights: {id, name, started, records, meta, outcome, grid}.
 * @param {object} [options]
 * @param {(actorId: string) => string|null} [options.statusOf]  The hero's current status from the world
 *   ("active", "benched", "dead", "insane"). Without it, or when it returns null, the status comes from the fights.
 * @param {(records: object[], fight: object) => object[]} [options.prepare]  Adjust a fight's records first (move estimates).
 */
export function aggregateToDate(fights, { statusOf = null, prepare = (r) => r } = {}) {
  const ordered = [...fights].sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
  const combats = ordered.filter(isCombatFight);
  const latest = combats.at(-1)?.id ?? null;
  const heroes = new Map();
  const allies = new Map();
  const majors = new Map();
  const minions = [];
  const names = {};
  const kills = [];
  const results = { victory: 0, defeat: 0, withdrawn: 0, undecided: 0 };
  const fightList = [];
  const sessions = []; // out-of-combat buckets that hold skill checks
  let rounds = 0;

  for (const f of ordered) {
    const meta = f.meta ?? {};
    const stats = aggregate(prepare(f.records ?? [], f), meta, { outcome: f.outcome });
    const combat = isCombatFight(f);
    if (combat) {
      results[stats.outcome.result] = (results[stats.outcome.result] ?? 0) + 1;
      rounds += stats.summary.rounds;
      fightList.push({ id: f.id, name: f.name, started: f.started ?? null, outcome: stats.outcome, rounds: stats.summary.rounds, mvp: stats.combatants[stats.summary.mvp]?.name ?? null, heroes: stats.heroes.map((s) => s.name) });
    } else if (stats.party.checks) {
      sessions.push({ id: f.id, name: f.name, started: f.started ?? null, checks: stats.party.checkRolls, heroes: stats.heroes.map((s) => s.name) });
    }
    // Map this fight's keys to the to-date keys.
    const keyMap = {};
    for (const s of stats.heroes) {
      const m = meta[s.key] ?? {};
      const key = m.actorId ? `actor:${m.actorId}` : s.key;
      keyMap[s.key] = key;
      const h = heroes.get(key) ?? { key, actorId: m.actorId ?? null, name: s.name, tokenName: m.tokenName ?? null, rows: [], fights: 0, record: { victory: 0, defeat: 0, withdrawn: 0, undecided: 0 }, last: null, lastFight: null };
      h.rows.push(s);
      h.last = s;
      if (combat) { h.fights++; h.record[stats.outcome.result]++; h.lastFight = f.id; }
      heroes.set(key, h);
    }
    // Companions merge by actor, like heroes.
    for (const s of stats.allies) {
      const m = meta[s.key] ?? {};
      const key = m.actorId ? `ally:${m.actorId}` : `ally:${s.name}`;
      keyMap[s.key] = key;
      const g = allies.get(key) ?? { key, name: s.name, rows: [], fights: 0, last: null };
      g.rows.push(s); g.last = s;
      if (combat) g.fights++;
      allies.set(key, g);
    }
    for (const s of Object.values(stats.combatants)) {
      if (s.side !== "adversary") continue;
      if (s.major) {
        const key = `major:${s.name}`;
        keyMap[s.key] = key;
        const g = majors.get(key) ?? { key, name: s.name, rows: [], fights: 0, last: null };
        g.rows.push(s); g.last = s;
        if (combat) g.fights++; // The out-of-combat bucket is not a fight, for adversaries as for heroes.
        majors.set(key, g);
      } else {
        keyMap[s.key] = `${f.id}:${s.key}`;
        names[keyMap[s.key]] = { key: keyMap[s.key], name: s.name, side: "adversary" };
        minions.push(s);
      }
    }
    const remap = (k) => keyMap[k] ?? `${f.id}:${k}`;
    for (const k of stats.kills) {
      for (const key of [k.by, k.target]) names[remap(key)] ??= { key: remap(key), name: stats.combatants[key]?.name ?? meta[key]?.name ?? key, side: stats.combatants[key]?.side ?? "unknown" };
      kills.push({ ...k, by: remap(k.by), target: remap(k.target), topDamage: remap(k.topDamage), fightId: f.id, fightName: f.name, share: Object.fromEntries(Object.entries(k.share).map(([key, v]) => [remap(key), v])) });
    }
  }

  const statusFromFights = (h) => {
    const st = h.last?.finalStatuses ?? [];
    if (st.includes("dead")) return "dead";
    if (st.includes("insane")) return "insane";
    return h.lastFight === latest ? "active" : "benched";
  };
  const heroRows = [...heroes.values()].map((h) => Object.assign(mergeCombatant(h.rows, h.key, h.name), {
    side: "hero", actorId: h.actorId, tokenName: h.tokenName, fights: h.fights, record: h.record,
    status: (h.actorId && statusOf?.(h.actorId)) || statusFromFights(h),
    finalState: h.last?.finalState ?? null, finalStatuses: h.last?.finalStatuses ?? [], out: !!h.last?.out
  })).filter((s) => s.fights > 0 || s.checks > 0).sort((a, b) => b.mvp - a.mvp); // a Rest outside combat is not taking part
  // Two actors with one name (a pregenerated copy, say): tell them apart by token name, else by level.
  const clashes = () => new Set(heroRows.map((s) => s.name).filter((n, i, all) => all.indexOf(n) !== i));
  let shared = clashes();
  for (const s of heroRows) if (shared.has(s.name) && s.tokenName && s.tokenName !== s.name) s.name = s.tokenName;
  shared = clashes();
  for (const name of shared) heroRows.filter((s) => s.name === name).slice(1).forEach((s, i) => { s.name = `${name} (${s.level ? `L${s.level}` : i + 2})`; });
  const majorRows = [...majors.values()].map((g) => Object.assign(mergeCombatant(g.rows, g.key, g.name), {
    side: "adversary", major: true, important: g.rows.some((s) => s.important), rank: g.last?.rank ?? null, fights: g.fights,
    finalState: g.last?.finalState ?? null, finalStatuses: g.last?.finalStatuses ?? [], out: !!g.last?.out
  }));
  const allyRows = [...allies.values()].map((g) => Object.assign(mergeCombatant(g.rows, g.key, g.name), {
    side: "ally", fights: g.fights, finalState: g.last?.finalState ?? null, finalStatuses: g.last?.finalStatuses ?? [], out: !!g.last?.out
  })).sort((a, b) => b.mvp - a.mvp);
  const combatants = { ...names };
  for (const s of [...heroRows, ...allyRows, ...majorRows]) combatants[s.key] = s;
  const side = (key) => combatants[key]?.side;
  const onParty = (key) => ["hero", "ally"].includes(side(key));

  return {
    toDate: true,
    heroes: heroRows, allies: allyRows, majorAdversaries: majorRows, adversaries: rollUp(minions, "Adversaries"), combatants, kills,
    party: rollUp(heroRows, "Party"),
    outcome: null,
    notes: [],
    fights: fightList,
    sessions,
    results,
    summary: { fights: fightList.length, sessions: sessions.length, rounds, mvp: heroRows[0]?.key ?? null, heroKills: kills.filter((k) => onParty(k.by)).length, adversaryKills: kills.filter((k) => side(k.by) === "adversary").length, heroDeaths: heroRows.reduce((a, s) => a + s.deaths, 0) },
    timeline: []
  };
}

/** Play-by-play lines, grouped by round. */
export function timeline(records, meta, kills) {
  const hazards = hazardNames(records);
  const name = (k) => meta[k]?.name ?? hazards[k] ?? k;
  const killAt = new Map(kills.map((k) => [k.target, k]));
  const lines = [];
  for (const r of records) {
    if (r.kind === "condition") { if (r.on) lines.push({ round: r.round, condition: r.status, text: `${name(r.actor)} is ${r.status === "dead" ? "dead" : r.status}` }); continue; }
    if (r.kind === "check") { lines.push({ round: r.round, text: `${name(r.actor)} rolls ${r.skill} ${r.total} vs DC ${r.dc}: ${r.critSuccess ? "critical success" : r.critFailure ? "critical failure" : r.success ? "success" : "failure"}` }); continue; }
    if (r.kind !== "action") continue;
    if (r.move) { lines.push({ round: r.round, text: `${name(r.actor)} moves${r.move.feet ? ` ${r.move.feet} ft${r.move.estimated ? " (est.)" : ""}` : ""}` }); continue; }
    if (r.heals?.length) {
      for (const h of r.heals) lines.push({ round: r.round, text: `${name(r.actor)} ${r.actionName} → ${name(h.target)}: ${h.health + h.morale > 0 ? `heals ${h.health + h.morale}` : "no healing"}${h.critSuccess ? " CRIT" : ""}` });
      continue;
    }
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
      key: a.tokenId, name: a.name, tokenName: a.tokenName ?? null, type: a.type, important: !!a.important, actorId: a.actorId,
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
