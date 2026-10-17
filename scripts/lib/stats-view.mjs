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
    { id: "lucky", label: "Hot Dice", hint: "Luckiest rolls for the size of each die (50% is average)", value: (s) => (s.dice.count >= 3 ? s.luck : null), show: (v) => `${pct(v)} luck` },
    { id: "unlucky", label: "Snake Eyes", hint: "Most natural 1s rolled", value: (s) => s.ones, show: (v) => `${v} × 1s` }
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

/**
 * One face histogram per die size rolled, smallest die first. Boons and banes change die sizes,
 * so faces from different sizes are never mixed. Bar widths are a percentage of that die's most common face.
 */
export function diceBars(dice) {
  return Object.entries(dice?.sizes ?? {}).map(([size, b]) => {
    const counts = Array.from({ length: Number(size) }, (_, i) => b.faces[i + 1] ?? 0);
    const max = Math.max(1, ...counts);
    return { size: Number(size), count: b.count, bars: counts.map((n, i) => ({ face: i + 1, count: n, width: Math.round((n / max) * 100) })) };
  }).sort((a, b) => a.size - b.size);
}

/** Escape text for safe use in HTML. */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
