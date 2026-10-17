// Stats dashboard: party view, player view, adversaries and play-by-play. Read-only for players.
import { aggregate, estimateMoves } from "../lib/stats.mjs";
import { diceBars, esc, leaderboards, num, pct, rankOf } from "../lib/stats-view.mjs";
import { listFights } from "./store.mjs";

const { ApplicationV2 } = foundry.applications.api;
const L = (key, data) => (data ? game.i18n.format(`PFM.Stats.${key}`, data) : game.i18n.localize(`PFM.Stats.${key}`));

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
      hero: StatsDashboard.#onHero
    }
  };

  static #onView(_event, target) { this.tab = target.dataset.tab; this.render(); }
  static #onHero(_event, target) { this.heroKey = target.dataset.key; this.tab = "player"; this.render(); }

  /** The hero a player sees by default: their assigned character, else the first hero they own. */
  #defaultHero(stats, fight) {
    const heroes = stats.heroes;
    if (game.user.isGM) return heroes[0]?.key ?? null;
    const mine = heroes.find((s) => fight.meta[s.key]?.actorId === game.user.character?.id)
      ?? heroes.find((s) => (fight.meta[s.key]?.owners ?? []).includes(game.user.id));
    return mine?.key ?? heroes[0]?.key ?? null;
  }

  async _prepareContext() {
    const fights = listFights(this.moduleId);
    const fight = fights.find((f) => f.id === this.fightId) ?? fights[0] ?? null;
    if (!fight) return { fights, fight: null };
    this.fightId = fight.id;
    const records = estimateMoves(foundry.utils.deepClone(fight.records), fight.grid ?? {});
    const stats = aggregate(records, fight.meta);
    if (!stats.combatants[this.heroKey] || stats.combatants[this.heroKey].side !== "hero") this.heroKey = this.#defaultHero(stats, fight);
    return { fights, fight, stats };
  }

  async _renderHTML(context) {
    const { fights, fight, stats } = context;
    if (!fight) return `<div class="pfm-empty">${esc(L("Empty"))}</div>`;
    const tabs = ["party", "player", "adversaries", "plays"].map((t) => `<button type="button" class="pfm-tab ${t === this.tab ? "active" : ""}" data-action="view" data-tab="${t}">${esc(L(`Tab.${t}`))}</button>`).join("");
    const picker = `<select class="pfm-fight">${fights.map((f) => `<option value="${esc(f.id)}" ${f.id === fight.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select>`;
    const body = { party: () => this.#party(stats), player: () => this.#player(stats), adversaries: () => this.#adversaries(stats), plays: () => this.#plays(stats) }[this.tab]();
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
      <div><span class="pfm-big">${summary.heroKills}</span><label>${esc(L("PartyKills"))}</label></div>
      <div><span class="pfm-big">${summary.adversaryKills}</span><label>${esc(L("AdversaryKills"))}</label></div>
      <div><span class="pfm-big">${summary.rounds}</span><label>${esc(L("Rounds"))}</label></div>
      <div><span class="pfm-big">${pct(party.hitRate)}</span><label>${esc(L("PartyHitRate"))}</label></div>
      <div class="pfm-mvp"><span class="pfm-big">${esc(mvp?.name ?? "–")}</span><label>${esc(L("MVP"))}</label></div>
    </div>`;
    const awards = `<div class="pfm-awards">${leaderboards(heroes).map((b) => `<div class="pfm-award" data-tooltip="${esc(b.hint)}"><label>${esc(b.label)}</label><strong>${esc(b.name)}</strong><span>${esc(b.value)}</span></div>`).join("")}</div>`;
    const cols = [
      ["Turns", (s) => s.turns], ["Attacks", (s) => s.attacks], ["HitRate", (s) => pct(s.hitRate)], ["Crits", (s) => s.crits],
      ["Damage", (s) => s.damageDealt + s.woundsDealt], ["Kills", (s) => `${s.kills}${s.killsStolen ? ` <small>(${s.killsStolen} ${esc(L("Stolen"))})</small>` : ""}`],
      ["Assists", (s) => s.assists], ["Taken", (s) => s.damageTaken + s.woundsTaken], ["Healing", (s) => s.healingDone],
      ["Focus", (s) => s.focusSpent], ["Heroism", (s) => `${s.heroismGained}/${s.heroismSpent}${s.heroismLostAtEnd ? ` <small>(-${s.heroismLostAtEnd})</small>` : ""}`],
      ["Feet", (s) => `${s.feetMoved}${s.feetEstimated ? "*" : ""}`], ["AvgPos", (s) => num(s.avgPosition, 1)], ["Checks", (s) => `${s.checkSuccesses}/${s.checks}`], ["Ones", (s) => s.ones]
    ];
    const table = `<table class="pfm-table"><thead><tr><th>${esc(L("Hero"))}</th>${cols.map(([k]) => `<th data-tooltip="${esc(L(`Hint.${k}`))}">${esc(L(`Col.${k}`))}</th>`).join("")}</tr></thead><tbody>
      ${heroes.map((s) => `<tr><td><a data-action="hero" data-key="${esc(s.key)}">${esc(s.name)}</a></td>${cols.map(([, f]) => `<td>${f(s)}</td>`).join("")}</tr>`).join("")}
      <tr class="pfm-total"><td>${esc(L("Party"))}</td>${cols.map(([, f]) => `<td>${f({ ...party, avgPosition: party.avgPosition, dice: party.dice })}</td>`).join("")}</tr>
      <tr class="pfm-foe"><td>${esc(L("Adversaries"))}</td>${cols.map(([, f]) => `<td>${f(adversaries)}</td>`).join("")}</tr>
    </tbody></table>`;
    const killList = `<h3>${esc(L("KillLog"))}</h3><ul class="pfm-kills">${kills.map((k) => {
      const bars = Object.entries(k.share).sort((a, b) => b[1].damage - a[1].damage).map(([key, v]) => `<span class="pfm-share ${key === k.by ? "finisher" : ""}" style="flex:${v.percent}" data-tooltip="${esc(stats.combatants[key]?.name)}: ${v.damage} (${v.percent}%)">${esc(stats.combatants[key]?.name)} ${v.percent}%</span>`).join("");
      return `<li><span class="pfm-kill-head">R${k.round ?? "?"} · <strong>${esc(stats.combatants[k.by]?.name)}</strong> ${esc(L(`Kill.${k.kind}`))} <strong>${esc(k.targetName)}</strong>${k.important ? ` <i class="fa-solid fa-star" data-tooltip="${esc(L("Major"))}"></i>` : ""}</span><div class="pfm-sharebar">${bars}</div></li>`;
    }).join("")}</ul>`;
    const note = heroes.some((s) => s.feetEstimated) ? `<p class="pfm-note">* ${esc(L("FeetEstimated"))}</p>` : "";
    return score + awards + table + note + killList;
  }

  /* ---------- Player view ---------- */

  #player(stats) {
    const heroes = stats.heroes;
    const s = stats.combatants[this.heroKey];
    if (!s) return `<div class="pfm-empty">${esc(L("NoHero"))}</div>`;
    const pick = `<div class="pfm-heroes">${heroes.map((h) => `<button type="button" class="${h.key === s.key ? "active" : ""}" data-action="hero" data-key="${esc(h.key)}">${esc(h.name)}</button>`).join("")}</div>`;
    const rank = (f) => { const r = rankOf(heroes, s.key, f); return r ? `<em>#${r.rank} of ${r.of}</em>` : ""; };
    const tile = (label, value, r = "") => `<div class="pfm-tile"><label>${esc(label)}</label><strong>${value}</strong>${r}</div>`;
    const tiles = `<div class="pfm-tiles">
      ${tile(L("Col.Damage"), s.damageDealt + s.woundsDealt, rank((x) => x.damageDealt + x.woundsDealt))}
      ${tile(L("Col.Kills"), `${s.kills} <small>(${s.killsSolo} ${esc(L("Solo"))} · ${s.killsEarned} ${esc(L("Earned"))} · ${s.killsStolen} ${esc(L("Stolen"))})</small>`, rank((x) => x.kills))}
      ${tile(L("Col.Assists"), s.assists, rank((x) => x.assists))}
      ${tile(L("Col.HitRate"), `${pct(s.hitRate)} <small>${s.hits}+${s.glances}g / ${s.attacks}</small>`, rank((x) => x.attacks ? x.hitRate : null))}
      ${tile(L("Col.Crits"), `${s.crits} <small>${esc(L("Fumbles"))} ${s.fumbles}</small>`)}
      ${tile(L("BiggestHit"), s.biggestHit, rank((x) => x.biggestHit))}
      ${tile(L("Col.Taken"), s.damageTaken + s.woundsTaken, rank((x) => x.damageTaken + x.woundsTaken))}
      ${tile(L("Avoided"), `${s.avoided}/${s.attacksReceived}`)}
      ${tile(L("Col.Healing"), `${s.healingDone} <small>${esc(L("Received"))} ${s.healingReceived}</small>`)}
      ${tile(L("Col.Focus"), `${s.focusSpent} <small>${esc(L("Refocus"))} ${s.refocuses} · ${esc(L("Spells"))} ${s.spellsCast}</small>`)}
      ${tile(L("Col.Heroism"), `+${s.heroismGained} / -${s.heroismSpent}${s.heroismLostAtEnd ? ` <small>${esc(L("LostAtEnd"))} ${s.heroismLostAtEnd}</small>` : ""}`)}
      ${tile(L("Col.Feet"), `${s.feetMoved}${s.feetEstimated ? "*" : ""}`, rank((x) => x.feetMoved))}
      ${tile(L("Initiative"), `${num(s.avgInitiative, 1)} <small>${esc(L("Col.AvgPos"))} #${num(s.avgPosition, 1)}</small>`)}
      ${tile(L("ApSpent"), s.apSpent)}
      ${tile(L("Progression"), `${s.milestones} ${esc(L("Milestones"))}${s.levelsGained ? ` · +${s.levelsGained} ${esc(L("Levels"))}` : ""}${s.attunementPoints ? ` · ${s.attunementPoints} ${esc(L("Attunement"))}` : ""}`)}
    </div>`;
    const avoided = Object.entries(s.avoidedBy).map(([k, v]) => `<li>${esc(k)}: ${v}</li>`).join("") || `<li>${esc(L("None"))}</li>`;
    const skills = Object.entries(s.checksBySkill).map(([k, v]) => `<li>${esc(k)}: ${v.successes}/${v.checks}</li>`).join("") || `<li>${esc(L("None"))}</li>`;
    const dice = diceBars(s.dice).map((d) => `<div class="pfm-dieset"><h4>d${d.size} <small>× ${d.count}</small></h4>${d.bars.map((b) => `<div class="pfm-die"><span>${b.face}</span><div class="pfm-diebar d${d.size}" style="width:${b.width}%"></div><em>${b.count}</em></div>`).join("")}</div>`).join("");
    const luck = `<div class="pfm-luck"><h3>${esc(L("Luck"))}</h3><p>${esc(L("LuckLine", { luck: pct(s.luck), ones: s.ones, maxes: s.dice.maxes, margin: num(s.avgMargin, 1) }))}</p><p>${esc(L("BoonLine", { boons: s.boons, banes: s.banes, withBoons: s.rollsWithBoons, withBanes: s.rollsWithBanes }))}</p><div class="pfm-diesets">${dice}</div></div>`;
    return `${pick}${tiles}<div class="pfm-cols"><div><h3>${esc(L("MissedBecause"))}</h3><ul>${avoided}</ul><h3>${esc(L("SkillChecks"))}</h3><ul>${skills}</ul></div>${luck}</div>`;
  }

  /* ---------- Adversaries ---------- */

  #adversaries(stats) {
    const row = (s, label) => `<tr><td>${esc(label ?? s.name)}${s.members ? ` <small>×${s.members}</small>` : ""}</td><td>${s.attacks}</td><td>${pct(s.hitRate)}</td><td>${s.damageDealt + s.woundsDealt}</td><td>${s.kills}</td><td>${s.damageTaken}</td><td>${s.woundsTaken}</td><td>${s.feetMoved}${s.feetEstimated ? "*" : ""}</td></tr>`;
    const head = `<tr><th></th>${["Attacks", "HitRate", "Damage", "Kills", "Taken", "Wounds", "Feet"].map((k) => `<th>${esc(L(`Col.${k}`))}</th>`).join("")}</tr>`;
    const majors = stats.majorAdversaries.map((s) => {
      const k = stats.kills.find((x) => x.target === s.key);
      const fate = k ? L("FateKilled", { by: stats.combatants[k.by]?.name ?? "?", round: k.round ?? "?" }) : L("FateAlive");
      return `<div class="pfm-major"><h4><i class="fa-solid fa-star"></i> ${esc(s.name)}</h4><p>${esc(fate)}</p><table class="pfm-table">${head}${row(s)}</table></div>`;
    }).join("");
    return `<h3>${esc(L("Adversaries"))}</h3><table class="pfm-table">${head}${row(stats.adversaries, L("Minions"))}</table>${majors ? `<h3>${esc(L("Majors"))}</h3>${majors}` : ""}`;
  }

  /* ---------- Play-by-play ---------- */

  #plays(stats) {
    const byRound = new Map();
    for (const l of stats.timeline) { const r = l.round ?? "—"; if (!byRound.has(r)) byRound.set(r, []); byRound.get(r).push(l); }
    return [...byRound].map(([r, lines]) => `<h3>${r === "—" ? esc(L("OutOfCombat")) : esc(L("Round", { round: r }))}</h3><ol class="pfm-plays">${lines.map((l) => `<li class="${l.kill ? "kill" : ""}">${esc(l.text)}</li>`).join("")}</ol>`).join("");
  }
}
