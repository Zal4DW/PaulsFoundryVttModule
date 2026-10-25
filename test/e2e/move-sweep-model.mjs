// Expected outcomes for the token movement sweep (test/e2e/move-sweep.spec.mjs). Pure logic, no Foundry globals.
//
// Every case is a straight move along +x towards an obstacle. All lengths are in feet, which on Crucible's microgrid
// are grid cells. The obstacle's left face is at x = 0. A token's position is its top-left corner.
//
// Two models predict where the mover stops:
// - "footprint": the mover's whole square footprint may not cross the obstacle. This is what players expect.
// - "centre": only the mover's centre point may not cross the obstacle. Foundry core tests the movement origin
//   (TokenDocument#getMovementOrigin, the token centre) against walls, and Crucible's token collision adds the blocker's
//   footprint as walls, so this is the model the code implements.

/**
 * The lanes (vertical offsets) to test a mover of this size against a token blocker. `dy` is the mover's top edge
 * relative to the blocker's top edge.
 * @param {number} size          Mover size in feet
 * @param {number} blockerSize   Blocker size in feet
 * @returns {{dy: number, label: string}[]}
 */
export function laneOffsets(size, blockerSize) {
  const half = size / 2;
  const lanes = [
    { dy: -size, label: "touching, no overlap" },
    { dy: -size + 1, label: "1 ft footprint overlap, centre outside" },
    { dy: Math.floor(-half), label: "centre on the blocker's top edge" },
    { dy: Math.floor(-half) + 1, label: "centre 1 ft inside" },
    { dy: Math.round((blockerSize - size) / 2), label: "centres aligned" }
  ];
  const seen = new Set();
  return lanes.filter(({ dy }) => !seen.has(dy) && seen.add(dy));
}

/**
 * The target gaps for the stepped approach, furthest first. The gap is the distance from the mover's right edge to
 * the obstacle's left face at the planned destination. A negative gap means the plan overlaps the obstacle.
 * @param {number} size   Mover size in feet
 */
export function targetGaps(size) {
  const half = Math.ceil(size / 2);
  const gaps = [4, 2, 1, 0, -1, -2, -half + 1, -half, -half - 1];
  return [...new Set(gaps)].sort((a, b) => b - a);
}

/**
 * The furthest right edge each model allows, as a gap (0 = touching the obstacle). Null means the model does not
 * block this lane at all.
 * @param {{obstacle: "wall"|"token", size: number, dy?: number, blockerSize?: number}} c
 * @returns {{footprint: number|null, centre: number|null}}
 */
export function stopGap({ obstacle, size, dy = 0, blockerSize = 0 }) {
  if (obstacle === "wall") return { footprint: 0, centre: -size / 2 };
  const top = dy;
  const bottom = dy + size;
  const centreY = dy + size / 2;
  const footprintOverlaps = top < blockerSize && bottom > 0;
  // A centre that lands on the blocker's edge counts as a hit, as it does in the sweep data.
  const centreInside = centreY >= 0 && centreY <= blockerSize;
  return { footprint: footprintOverlaps ? 0 : null, centre: centreInside ? -size / 2 : null };
}

/**
 * Whether a model lets a move to this gap complete.
 * @param {number|null} limit  The model's stop gap, from stopGap
 * @param {number} gap         The planned destination gap
 * @param {{touchBlocks?: boolean}} [options]  touchBlocks: reaching the limit exactly is a hit. True for the centre
 *   model, where a centre on a wall face or blocker edge stops the move. The footprint model allows touching.
 */
export const allows = (limit, gap, { touchBlocks = false } = {}) =>
  limit === null || (touchBlocks ? gap > limit : gap >= limit);

/**
 * Classify one recorded move.
 * @param {{planned: {x: number, y: number}, origin: {x: number, y: number}, final: {x: number, y: number}}} move
 * @returns {"completed"|"truncated"|"rejected"}
 */
export function outcome({ planned, origin, final }) {
  const same = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
  if (same(final, planned)) return "completed";
  if (same(final, origin)) return "rejected";
  return "truncated";
}
