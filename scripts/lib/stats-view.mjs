// View helpers for the stats dashboard. Pure functions, so Vitest can test them in Node.

export const pct = (x) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);
export const num = (x, digits = 0) => (x === null || x === undefined ? "–" : Number(x).toFixed(digits));

/**
 * Party awards, NFL-style. Each entry names the hero who leads one category.
 * Ties go to the hero listed first. Categories with no qualifying hero are left out.
 * @param {object[]} heroes  Hero stats from aggregate().
 */
export function leaderboards(heroes) {
  const boards = [
    { id: "damage", label: "Heavy Hitter", hint: "Most damage dealt", value: (s) => s.damageDealt + s.woundsDealt, show: (v) => `${v} dmg` },
    { id: "kills", label: "Finisher", hint: "Most kills that were earned or solo", value: (s) => s.killsSolo + s.killsEarned, show: (v) => `${v} kills` },
    { id: "stolen", label: "Kill Thief", hint: "Most final blows on enemies someone else had softened up", value: (s) => s.killsStolen, show: (v) => `${v} stolen` },
    { id: "assists", label: "Setup Artist", hint: "Most assists (damage on enemies a teammate finished)", value: (s) => s.assists, show: (v) => `${v} assists` },
    { id: "accuracy", label: "Sharpshooter", hint: "Best hit rate, at least 2 attacks", value: (s) => (s.attacks >= 2 ? s.hitRate : null), show: (v) => pct(v) },
    { id: "tank", label: "Punching Bag", hint: "Most damage taken", value: (s) => s.damageTaken + s.woundsTaken, show: (v) => `${v} taken` },
    { id: "healer", label: "Medic", hint: "Most healing given", value: (s) => s.healingDone, show: (v) => `${v} healed` },
    { id: "support", label: "Cheerleader", hint: "Most buffs and inspiring actions", value: (s) => s.buffs, show: (v) => `${v} buffs` },
    { id: "mover", label: "Road Runner", hint: "Most feet moved", value: (s) => s.feetMoved, show: (v, s) => `${v} ft${s.feetEstimated ? " (est.)" : ""}` },
    { id: "speed", label: "First Off the Line", hint: "Best average turn position", value: (s) => (s.avgPosition === null ? null : -s.avgPosition), show: (v) => `#${num(-v, 1)} avg` },
    { id: "lucky", label: "Hot Hand", hint: "Highest average attack total, at least 3 attacks", value: (s) => (s.combatRolls.count >= 3 ? s.combatRolls.avg : null), show: (v) => `${num(v, 1)} avg attack` },
    { id: "unlucky", label: "Butterfingers", hint: "Most critical failures on attacks", value: (s) => s.combatRolls.critFailures, show: (v) => `${v} crit fails` },
    { id: "skilled", label: "Know-It-All", hint: "Best skill check success rate, at least 2 checks", value: (s) => (s.checkRolls.successes + s.checkRolls.failures >= 2 ? s.checkRolls.successRate : null), show: (v) => pct(v) }
  ];
  const out = [];
  for (const b of boards) {
    let best = null;
    for (const s of heroes) {
      const v = b.value(s);
      if (v === null || v === undefined || v <= 0 && b.id !== "speed") continue;
      if (!best || v > best.v) best = { s, v };
    }
    if (best) out.push({ id: b.id, label: b.label, hint: b.hint, key: best.s.key, name: best.s.name, value: b.show(best.v, best.s) });
  }
  return out;
}

/** Rank of each hero on a stat (1 = best), for "you vs the party" on the player view. */
export function rankOf(heroes, key, value) {
  const vals = heroes.map((s) => ({ key: s.key, v: value(s) })).filter((x) => x.v !== null && x.v !== undefined);
  vals.sort((a, b) => b.v - a.v);
  const i = vals.findIndex((x) => x.key === key);
  return i === -1 ? null : { rank: i + 1, of: vals.length };
}

/** Escape text for safe use in HTML. */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);

const RESULT_LABEL = { victory: "Victory", defeat: "Defeat", withdrawn: "Withdrawn", undecided: "Undecided" };

/**
 * How a combatant's fight ended, in words: for major adversaries and heroes on the dashboard and in the Roll of Valour.
 * @param {object} s       Combatant stats from aggregate().
 * @param {object} stats   The whole aggregate() result, for kills and the fight result.
 */
export function fateLine(s, stats) {
  const killed = stats.kills.find((k) => k.target === s.key);
  const st = s.finalState;
  const wounds = st?.wounds?.max ? ` with ${st.wounds.value} of ${st.wounds.max} wounds` : "";
  const kills = s.kills ? `, ${s.kills} kill${s.kills === 1 ? "" : "s"}` : "";
  if (killed) return `Defeated by ${stats.combatants[killed.by]?.name ?? "?"} in round ${killed.round ?? "?"}`;
  if (s.finalStatuses?.includes("dead")) return "Dead";
  if (s.finalStatuses?.includes("insane")) return `Insane${wounds}`;
  if (s.side === "adversary" && stats.outcome?.result === "defeat") return `Victorious${st?.health?.value === 0 ? `: fought on at 0 health${wounds}` : ""}${kills}`;
  if (st?.health && st.health.value === 0) return `Still fighting at 0 health${wounds}${kills}`;
  if (st?.health) return `Standing at ${st.health.value} of ${st.health.max} health${kills}`;
  return s.out ? "Down" : "Survived";
}

/**
 * The Roll of Valour page for one fight, as HTML: result, MVP, heroes, major adversaries, kills, conditions and notes.
 * @param {object} stats  aggregate() result.
 * @param {object} fight  The stored fight: {name, scene, started, ended}.
 */
export function fightReport(stats, fight) {
  const o = stats.outcome ?? { result: "undecided", reason: "" };
  const date = fight.started ? new Date(fight.started).toLocaleDateString() : "";
  const mvp = stats.combatants[stats.summary.mvp];
  const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  const heroRows = stats.heroes.map((s) => row([esc(s.name), s.damageDealt + s.woundsDealt, `${s.kills}${s.killsStolen ? ` (${s.killsStolen} stolen)` : ""}`, s.healingDone, s.damageTaken + s.woundsTaken, esc(fateLine(s, stats))])).join("");
  const majors = stats.majorAdversaries.map((s) => `<li><strong>${esc(s.name)}</strong>${s.rank ? ` (${esc(s.rank)})` : ""}: ${esc(fateLine(s, stats))}. Dealt ${s.damageDealt + s.woundsDealt}, took ${s.damageTaken + s.woundsTaken}.</li>`).join("");
  const kills = stats.kills.map((k) => `<li>Round ${k.round ?? "?"}: ${esc(stats.combatants[k.by]?.name)} ${k.kind === "stolen" ? "stole the kill on" : k.kind === "solo" ? "killed" : "finished"} ${esc(k.targetName)}${k.important ? " ★" : ""}</li>`).join("");
  const conditions = stats.timeline.filter((l) => ["broken", "insane", "dead", "frightened"].includes(l.condition)).map((l) => `<li>Round ${l.round ?? "?"}: ${esc(l.text)}</li>`).join("");
  const notes = (stats.notes ?? []).map((n) => `<li>${n.actor ? `<strong>${esc(n.actor)}</strong>: ` : ""}${esc(n.text)}</li>`).join("");
  const boards = leaderboards(stats.heroes).slice(0, 6).map((b) => `<li><strong>${esc(b.label)}</strong>: ${esc(b.name)} (${esc(b.value)})</li>`).join("");
  return [
    `<h2>${esc(fight.name)}</h2>`,
    `<p><em>${esc(fight.scene ?? "")}${date ? ` · ${esc(date)}` : ""} · ${stats.summary.rounds} rounds</em></p>`,
    `<h3>Result: ${RESULT_LABEL[o.result] ?? esc(o.result)}</h3>`,
    o.reason ? `<p>${esc(o.reason)}${o.by === "gm" ? " (GM ruling)" : ""}</p>` : "",
    mvp ? `<p><strong>MVP:</strong> ${esc(mvp.name)}</p>` : "",
    `<h3>Heroes</h3><table><thead><tr><th>Hero</th><th>Damage</th><th>Kills</th><th>Healing</th><th>Taken</th><th>Fate</th></tr></thead><tbody>${heroRows}</tbody></table>`,
    majors ? `<h3>Major adversaries</h3><ul>${majors}</ul>` : "",
    `<p>Other adversaries: ${stats.adversaries.members} (${stats.adversaries.damageDealt + stats.adversaries.woundsDealt} damage dealt, ${stats.adversaries.kills} kills).</p>`,
    kills ? `<h3>Kills</h3><ul>${kills}</ul>` : "",
    conditions ? `<h3>Broken, insane and fallen</h3><ul>${conditions}</ul>` : "",
    boards ? `<h3>Honours</h3><ul>${boards}</ul>` : "",
    notes ? `<h3>Notes</h3><ul>${notes}</ul>` : ""
  ].filter(Boolean).join("\n");
}
