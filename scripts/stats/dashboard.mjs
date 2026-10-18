// Stats dashboard: party view, player view, adversaries and play-by-play. Read-only for players.
import { aggregate, aggregateToDate, estimateMoves } from "../lib/stats.mjs";
import { esc, fateLine, fightReport, leaderboards, num, pct, rankOf } from "../lib/stats-view.mjs";
import { listFights } from "./store.mjs";

const { ApplicationV2 } = foundry.applications.api;
/** The fight picker's value for the to-date view. */
const TO_DATE = "__toDate__";
/** A tooltip naming the token, when a hero's token has a different name. */
const tokenHint = (stats, s) => {
  const token = s.tokenName ?? stats.meta?.[s.key]?.tokenName;
  return token && token !== s.name ? ` data-tooltip="${esc(game.i18n.format("PFM.Stats.TokenName", { token }))}"` : "";
};
const L = (key, data) => (data ? game.i18n.format(`PFM.Stats.${key}`, data) : game.i18n.localize(`PFM.Stats.${key}`));
/** Wins and losses: "1–3" in a table cell, or "1 won, 3 lost, 1 undecided" in a banner. */
const recordText = (r, long = false) => {
  const other = (r.undecided ?? 0) + (r.withdrawn ?? 0);
  if (long) return L("RecordLong", { won: r.victory ?? 0, lost: r.defeat ?? 0, other });
  return `${r.victory ?? 0}–${r.defeat ?? 0}${other ? ` <small>(+${other})</small>` : ""}`;
};

export class StatsDashboard extends ApplicationV2 {
  constructor(moduleId, options = {}) {
    super(options);
    this.moduleId = moduleId;
    this.tab = options.tab ?? "party";
    this.fightId = null;
    this.heroKey = null;
  }

  static DEFAULT_OPTIONS = {
    id: "pfm-stats",
    classes: ["pfm-stats"],
    window: { title: "PFM.Stats.Title", icon: "fa-solid fa-chart-column", resizable: true },
    position: { width: 1040, height: 720 },
    actions: {
      view: StatsDashboard.#onView,
      hero: StatsDashboard.#onHero,
      fight: StatsDashboard.#onFight,
      journal: StatsDashboard.#onJournal
    }
  };

  static #onView(_event, target) { this.tab = target.dataset.tab; this.render(); }
  static #onFight(_event, target) { this.fightId = target.dataset.fight; this.heroKey = null; this.tab = "party"; this.render(); }
  static #onJournal() { game.modules.get(this.moduleId).api.openChronicle(); }
  static #onHero(_event, target) { this.heroKey = target.dataset.key; this.tab = "player"; this.render(); }

  /** The hero a player sees by default: their assigned character, else the first hero they own. */
  #defaultHero(stats, fight) {
    const heroes = stats.heroes;
    if (game.user.isGM) return heroes[0]?.key ?? null;
    const actorOf = (s) => s.actorId ?? fight?.meta?.[s.key]?.actorId;
    const mine = heroes.find((s) => actorOf(s) === game.user.character?.id)
      ?? heroes.find((s) => game.actors.get(actorOf(s))?.isOwner);
    return mine?.key ?? heroes[0]?.key ?? null;
  }

  /** A hero's status now: dead or insane from the actor, else active in the party or benched. */
  static #statusOf(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return null;
    if (actor.statuses.has("dead")) return "dead";
    if (actor.statuses.has("insane")) return "insane";
    const members = globalThis.crucible?.party?.system?.members;
    if (!Array.isArray(members)) return null;
    return members.some((m) => (m.actor?.id ?? m.actorId) === actorId) ? "active" : "benched";
  }

  async _prepareContext() {
    const fights = listFights(this.moduleId);
    if (this.fightId === TO_DATE && fights.length) {
      const stats = aggregateToDate(fights, {
        statusOf: (id) => StatsDashboard.#statusOf(id),
        prepare: (records, f) => estimateMoves(foundry.utils.deepClone(records), f.grid ?? {})
      });
      if (this.tab === "plays") this.tab = "party";
      if (!stats.combatants[this.heroKey] || stats.combatants[this.heroKey].side !== "hero") this.heroKey = this.#defaultHero(stats, null);
      return { fights, fight: { id: TO_DATE, name: L("ToDate") }, stats };
    }
    const fight = fights.find((f) => f.id === this.fightId) ?? fights[0] ?? null;
    if (!fight) return { fights, fight: null };
    this.fightId = fight.id;
    const records = estimateMoves(foundry.utils.deepClone(fight.records), fight.grid ?? {});
    const stats = aggregate(records, fight.meta, { outcome: fight.outcome });
    stats.meta = fight.meta; // for token names in tooltips
    if (!stats.combatants[this.heroKey] || stats.combatants[this.heroKey].side !== "hero") this.heroKey = this.#defaultHero(stats, fight);
    return { fights, fight, stats };
  }

  async _renderHTML(context) {
    const { fights, fight, stats } = context;
    if (!fight) return `<div class="pfm-empty">${esc(L("Empty"))}</div>`;
    const toDate = !!stats.toDate;
    const tabs = ["party", "player", "adversaries", "plays", "roll"].filter((t) => !(toDate && t === "plays")).map((t) => `<button type="button" class="pfm-tab ${t === this.tab ? "active" : ""}" data-action="view" data-tab="${t}">${esc(L(`Tab.${t}`))}</button>`).join("");
    const options = [{ id: TO_DATE, name: L("ToDate") }, ...fights];
    const picker = `<select class="pfm-fight">${options.map((f) => `<option value="${esc(f.id)}" ${f.id === fight.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select>`;
    const body = { party: () => this.#party(stats), player: () => this.#player(stats), adversaries: () => this.#adversaries(stats), plays: () => this.#plays(stats), roll: () => (toDate ? this.#fightList(stats) : this.#roll(stats, fight)) }[this.tab]();
    return `<header class="pfm-head">${picker}<nav class="pfm-tabs">${tabs}</nav></header><section class="pfm-body">${body}</section>`;
  }

  _replaceHTML(result, content) { content.innerHTML = result; }

  async _onRender() {
    this.element.querySelector(".pfm-fight")?.addEventListener("change", (e) => { this.fightId = e.target.value; this.heroKey = null; this.render(); });
  }

  /* ---------- Party (group view) ---------- */

  #party(stats) {
    const { summary, heroes, party, adversaries, kills } = stats;
    const mvp = stats.combatants[summary.mvp];
    const score = `<div class="pfm-score">
      ${stats.toDate ? `<div><span class="pfm-big">${summary.fights}</span><label>${esc(L("Fights"))}</label></div>` : ""}
      <div><span class="pfm-big">${summary.heroKills}</span><label>${esc(L("PartyKills"))}</label></div>
      <div><span class="pfm-big">${summary.adversaryKills}</span><label>${esc(L("AdversaryKills"))}</label></div>
      <div><span class="pfm-big">${summary.rounds}</span><label>${esc(L("Rounds"))}</label></div>
      <div><span class="pfm-big">${pct(party.hitRate)}</span><label>${esc(L("PartyHitRate"))}</label></div>
      <div class="pfm-mvp"><span class="pfm-big">${esc(mvp?.name ?? "–")}</span><label>${esc(L("MVP"))}</label></div>
    </div>`;
    const awards = `<div class="pfm-awards">${leaderboards(heroes).map((b) => `<div class="pfm-award" data-tooltip="${esc(b.hint)}"><label>${esc(b.label)}</label><strong>${esc(b.name)}</strong><span>${esc(b.value)}</span></div>`).join("")}</div>`;
    const career = stats.toDate ? [
      ["Status", (s) => (s.status ? `<span class="pfm-status pfm-status-${esc(s.status)}">${esc(L(`Status.${s.status}`))}</span>` : "–")],
      ["Fights", (s) => s.fights ?? "–"],
      ["Record", (s) => (s.record ? recordText(s.record) : "–")]
    ] : [];
    const cols = [
      ...career,
      ["Turns", (s) => s.turns], ["Attacks", (s) => s.attacks], ["HitRate", (s) => pct(s.hitRate)], ["Crits", (s) => s.combatRolls.critSuccesses], ["CritFails", (s) => s.combatRolls.critFailures], ["AvgAtk", (s) => num(s.combatRolls.avg, 1)],
      ["Damage", (s) => s.damageDealt + s.woundsDealt], ["DmgPerHit", (s) => (s.hitDamage.count ? `${num(s.hitDamage.avg, 1)} <small>(${s.hitDamage.min}–${s.hitDamage.max})</small>` : "–")], ["Kills", (s) => `${s.kills}${s.killsStolen ? ` <small>(${s.killsStolen} ${esc(L("Stolen"))})</small>` : ""}`],
      ["Assists", (s) => s.assists], ["Taken", (s) => s.damageTaken + s.woundsTaken], ["Healing", (s) => s.healingDone],
      ["Focus", (s) => s.focusSpent], ["Heroism", (s) => `${s.heroismGained}/${s.heroismSpent}${s.heroismLostAtEnd ? ` <small>(-${s.heroismLostAtEnd})</small>` : ""}`],
      ["Feet", (s) => `${s.feetMoved}${s.feetEstimated ? "*" : ""}`], ["AvgPos", (s) => num(s.avgPosition, 1)], ["Checks", (s) => `${s.checkRolls.successes}/${s.checkRolls.count}`], ["AvgChk", (s) => num(s.checkRolls.avg, 1)], ["ChkCrits", (s) => `${s.checkRolls.critSuccesses}/${s.checkRolls.critFailures}`]
    ];
    const table = `<table class="pfm-table"><thead><tr><th>${esc(L("Hero"))}</th>${cols.map(([k]) => `<th data-tooltip="${esc(L(`Hint.${k}`))}">${esc(L(`Col.${k}`))}</th>`).join("")}</tr></thead><tbody>
      ${heroes.map((s) => `<tr><td><a data-action="hero" data-key="${esc(s.key)}"${tokenHint(stats, s)}>${esc(s.name)}</a></td>${cols.map(([, f]) => `<td>${f(s)}</td>`).join("")}</tr>`).join("")}
      <tr class="pfm-total"><td>${esc(L("Party"))}</td>${cols.map(([, f]) => `<td>${f(party)}</td>`).join("")}</tr>
      <tr class="pfm-foe"><td>${esc(L("Adversaries"))}</td>${cols.map(([, f]) => `<td>${f(adversaries)}</td>`).join("")}</tr>
    </tbody></table>`;
    const killList = `<h3>${esc(L("KillLog"))}</h3><ul class="pfm-kills">${kills.map((k) => {
      const bars = Object.entries(k.share).sort((a, b) => b[1].damage - a[1].damage).map(([key, v]) => `<span class="pfm-share ${key === k.by ? "finisher" : ""}" style="flex:${v.percent}" data-tooltip="${esc(stats.combatants[key]?.name)}: ${v.damage} (${v.percent}%)">${esc(stats.combatants[key]?.name)} ${v.percent}%</span>`).join("");
      return `<li><span class="pfm-kill-head">${k.fightName ? `${esc(k.fightName)} · ` : ""}R${k.round ?? "?"} · <strong>${esc(stats.combatants[k.by]?.name)}</strong> ${esc(L(`Kill.${k.kind}`))} <strong>${esc(k.targetName)}</strong>${k.important ? ` <i class="fa-solid fa-star" data-tooltip="${esc(L("Major"))}"></i>` : ""}</span><div class="pfm-sharebar">${bars}</div></li>`;
    }).join("")}</ul>`;
    const note = heroes.some((s) => s.feetEstimated) ? `<p class="pfm-note">* ${esc(L("FeetEstimated"))}</p>` : "";
    const o = stats.outcome;
    const banner = stats.toDate ? `<div class="pfm-result pfm-result-todate"><strong>${esc(L("ToDate"))}</strong> · ${esc(recordText(stats.results, true))}</div>` : o ?`<div class="pfm-result pfm-result-${esc(o.result)}"><strong>${esc(L(`Result.${o.result}`))}</strong>${o.reason ? ` · ${esc(o.reason)}` : ""}${o.by === "gm" ? ` <em>(${esc(L("GmRuling"))})</em>` : ""}</div>` : "";
    return banner + score + awards + table + note + killList;
  }

  /* ---------- Player view ---------- */

  #player(stats) {
    const heroes = stats.heroes;
    const s = stats.combatants[this.heroKey];
    if (!s) return `<div class="pfm-empty">${esc(L("NoHero"))}</div>`;
    const pick = `<div class="pfm-heroes">${heroes.map((h) => `<button type="button" class="${h.key === s.key ? "active" : ""}" data-action="hero" data-key="${esc(h.key)}"${tokenHint(stats, h)}>${esc(h.name)}</button>`).join("")}</div>`;
    const rank = (f) => { const r = rankOf(heroes, s.key, f); return r ? `<em>#${r.rank} of ${r.of}</em>` : ""; };
    const tile = (label, value, r = "") => `<div class="pfm-tile"><label>${esc(label)}</label><strong>${value}</strong>${r}</div>`;
    const tiles = `<div class="pfm-tiles">
      ${tile(L("Col.Damage"), s.damageDealt + s.woundsDealt, rank((x) => x.damageDealt + x.woundsDealt))}
      ${tile(L("Col.Kills"), `${s.kills} <small>(${s.killsSolo} ${esc(L("Solo"))} · ${s.killsEarned} ${esc(L("Earned"))} · ${s.killsStolen} ${esc(L("Stolen"))})</small>`, rank((x) => x.kills))}
      ${tile(L("Col.Assists"), s.assists, rank((x) => x.assists))}
      ${tile(L("Col.HitRate"), `${pct(s.hitRate)} <small>${s.hits}+${s.glances}g / ${s.attacks}</small>`, rank((x) => x.attacks ? x.hitRate : null))}
      ${tile(L("Col.Crits"), `${s.crits} <small>${esc(L("Fumbles"))} ${s.fumbles}</small>`)}
      ${tile(L("DamagePerHit"), `${num(s.hitDamage.avg, 1)} <small>${esc(L("Range"))} ${s.hitDamage.count ? `${s.hitDamage.min} – ${s.hitDamage.max}` : "–"}</small>`, rank((x) => x.hitDamage.avg))}
      ${tile(L("Col.Taken"), s.damageTaken + s.woundsTaken, rank((x) => x.damageTaken + x.woundsTaken))}
      ${tile(L("Avoided"), `${s.avoided}/${s.attacksReceived}`)}
      ${tile(L("Col.Healing"), `${s.healingDone} <small>${esc(L("Received"))} ${s.healingReceived}${s.healCasts ? ` · ${esc(L("HealCasts", { ok: s.healSuccesses, of: s.healCasts }))}` : ""}</small>`, rank((x) => x.healingDone))}
      ${tile(L("Col.Focus"), `${s.focusSpent} <small>${esc(L("Refocus"))} ${s.refocuses} · ${esc(L("Spells"))} ${s.spellsCast}</small>`)}
      ${tile(L("Col.Heroism"), `+${s.heroismGained} / -${s.heroismSpent}${s.heroismLostAtEnd ? ` <small>${esc(L("LostAtEnd"))} ${s.heroismLostAtEnd}</small>` : ""}`)}
      ${tile(L("Col.Feet"), `${s.feetMoved}${s.feetEstimated ? "*" : ""}`, rank((x) => x.feetMoved))}
      ${tile(L("Initiative"), `${num(s.avgInitiative, 1)} <small>${esc(L("Col.AvgPos"))} #${num(s.avgPosition, 1)}</small>`)}
      ${tile(L("ApSpent"), s.apSpent)}
      ${tile(L("Progression"), `${s.milestones} ${esc(L("Milestones"))}${s.levelsGained ? ` · +${s.levelsGained} ${esc(L("Levels"))}` : ""}${s.attunementPoints ? ` · ${s.attunementPoints} ${esc(L("Attunement"))}` : ""}`)}
    </div>`;
    const conds = Object.entries(s.conditions ?? {}).map(([k, v]) => `${k}${v > 1 ? ` ×${v}` : ""}`).join(", ");
    const fate = stats.toDate
      ? `<strong>${esc(L(`Status.${s.status}`))}</strong> · ${esc(L("FightsRecord", { fights: s.fights }))} ${recordText(s.record)}`
      : `<strong>${esc(L("Fate"))}:</strong> ${esc(fateLine(s, stats))}`;
    const fateHtml = `<p class="pfm-fate">${fate}${conds ? ` · ${esc(L("Conditions"))}: ${esc(conds)}` : ""}</p>`;
    const avoided = Object.entries(s.avoidedBy).map(([k, v]) => `<li>${esc(k)}: ${v}</li>`).join("") || `<li>${esc(L("None"))}</li>`;
    const skills = Object.entries(s.checksBySkill).map(([k, v]) => `<li>${esc(k)}: ${v.successes}/${v.checks}</li>`).join("") || `<li>${esc(L("None"))}</li>`;
    const row = (label, f) => `<tr><td>${esc(L(label))}</td><td>${f(s.combatRolls)}</td><td>${f(s.checkRolls)}</td></tr>`;
    const rolls = `<div class="pfm-luck"><h3>${esc(L("Rolls"))}</h3><table class="pfm-table">
      <tr><th></th><th>${esc(L("Combat"))}</th><th>${esc(L("SkillChecksShort"))}</th></tr>
      ${row("RollCount", (g) => g.count)}
      ${row("AvgRoll", (g) => num(g.avg, 1))}
      ${row("RollRange", (g) => (g.count ? `${g.min} – ${g.max}` : "–"))}
      ${row("Successes", (g) => `${g.successes} <small>(${pct(g.successRate)})</small>`)}
      ${row("Failures", (g) => g.failures)}
      ${row("CritSuccesses", (g) => g.critSuccesses)}
      ${row("CritFailures", (g) => g.critFailures)}
    </table><p class="pfm-note">${esc(L("AvgMargin"))}: ${num(s.avgMargin, 1)}</p></div>`;
    return `${pick}${fateHtml}${tiles}<div class="pfm-cols"><div><h3>${esc(L("MissedBecause"))}</h3><ul>${avoided}</ul><h3>${esc(L("SkillChecks"))}</h3><ul>${skills}</ul></div>${rolls}</div>`;
  }

  /* ---------- Adversaries ---------- */

  #adversaries(stats) {
    const row = (s, label) => `<tr><td>${esc(label ?? s.name)}${s.members ? ` <small>×${s.members}</small>` : ""}</td><td>${s.attacks}</td><td>${pct(s.hitRate)}</td><td>${s.damageDealt + s.woundsDealt}</td><td>${s.kills}</td><td>${s.damageTaken}</td><td>${s.woundsTaken}</td><td>${s.feetMoved}${s.feetEstimated ? "*" : ""}</td></tr>`;
    const head = `<tr><th></th>${["Attacks", "HitRate", "Damage", "Kills", "Taken", "Wounds", "Feet"].map((k) => `<th>${esc(L(`Col.${k}`))}</th>`).join("")}</tr>`;
    const majors = stats.majorAdversaries.map((s) => {
      const fate = fateLine(s, stats);
      return `<div class="pfm-major"><h4><i class="fa-solid fa-star"></i> ${esc(s.name)}${s.rank ? ` <small>${esc(s.rank)}</small>` : ""}</h4><p>${esc(fate)}</p><table class="pfm-table">${head}${row(s)}</table></div>`;
    }).join("");
    return `<h3>${esc(L("Adversaries"))}</h3><table class="pfm-table">${head}${row(stats.adversaries, L("Minions"))}</table>${majors ? `<h3>${esc(L("Majors"))}</h3>${majors}` : ""}`;
  }

  /* ---------- Roll of Valour: the write-up for this fight ---------- */

  #roll(stats, fight) {
    const journal = game.journal.find((j) => j.getFlag(this.moduleId, "chronicle"));
    const button = journal ? `<p><button type="button" class="pfm-journal" data-action="journal"><i class="fa-solid fa-book-open"></i> ${esc(L("OpenJournal", { name: journal.name }))}</button></p>` : "";
    return `<div class="pfm-roll">${fightReport(stats, fight)}</div>${button}`;
  }

  /* ---------- Roll of Valour to date: every fight and its result ---------- */

  #fightList(stats) {
    const rows = [...stats.fights].reverse().map((f) => `<tr>
      <td><a data-action="fight" data-fight="${esc(f.id)}">${esc(f.name)}</a></td>
      <td>${f.started ? esc(new Date(f.started).toLocaleDateString()) : "–"}</td>
      <td><span class="pfm-result-tag pfm-result-${esc(f.outcome.result)}">${esc(L(`Result.${f.outcome.result}`))}</span></td>
      <td>${f.rounds}</td><td>${esc(f.mvp ?? "–")}</td><td>${esc(f.heroes.join(", "))}</td></tr>`).join("");
    const head = ["Fight", "Date", "Result", "Rounds", "MVP", "Heroes"].map((k) => `<th>${esc(L(`FightCol.${k}`))}</th>`).join("");
    const journal = game.journal.find((j) => j.getFlag(this.moduleId, "chronicle"));
    const button = journal ? `<p><button type="button" class="pfm-journal" data-action="journal"><i class="fa-solid fa-book-open"></i> ${esc(L("OpenJournal", { name: journal.name }))}</button></p>` : "";
    return `<div class="pfm-result pfm-result-todate"><strong>${esc(L("ToDate"))}</strong> · ${esc(recordText(stats.results, true))}</div>
      <table class="pfm-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>${button}`;
  }

  /* ---------- Play-by-play ---------- */

  #plays(stats) {
    const byRound = new Map();
    for (const l of stats.timeline) { const r = l.round ?? "—"; if (!byRound.has(r)) byRound.set(r, []); byRound.get(r).push(l); }
    return [...byRound].map(([r, lines]) => `<h3>${r === "—" ? esc(L("OutOfCombat")) : esc(L("Round", { round: r }))}</h3><ol class="pfm-plays">${lines.map((l) => `<li class="${l.kill ? "kill" : ""}">${esc(l.text)}</li>`).join("")}</ol>`).join("");
  }
}
