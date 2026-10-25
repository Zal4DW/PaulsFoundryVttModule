import { describe, expect, it } from "vitest";
import { allows, laneOffsets, outcome, stopGap, targetGaps } from "../e2e/move-sweep-model.mjs";

describe("move sweep model", () => {
  it("lets a wall stop the footprint at the face but the centre half a token later", () => {
    expect(stopGap({ obstacle: "wall", size: 10 })).toEqual({ footprint: 0, centre: -5 });
  });

  it("blocks an aligned token lane in both models", () => {
    expect(stopGap({ obstacle: "token", size: 4, dy: 0, blockerSize: 4 })).toEqual({ footprint: 0, centre: -2 });
  });

  it("lets the centre model miss a lane where only the footprint overlaps", () => {
    // A 10 ft mover whose bottom 1 ft overlaps a 4 ft blocker: centre line is 4 ft above the blocker.
    expect(stopGap({ obstacle: "token", size: 10, dy: -9, blockerSize: 4 })).toEqual({ footprint: 0, centre: null });
  });

  it("treats a touching lane as clear in both models", () => {
    expect(stopGap({ obstacle: "token", size: 4, dy: -4, blockerSize: 4 })).toEqual({ footprint: null, centre: null });
  });

  it("dedupes lanes and gaps", () => {
    expect(laneOffsets(4, 4).map((l) => l.dy)).toEqual([-4, -3, -2, -1, 0]);
    expect(laneOffsets(2, 4).map((l) => l.dy)).toEqual([-2, -1, 0, 1]);
    expect(targetGaps(4)).toEqual([4, 2, 1, 0, -1, -2, -3]);
  });

  it("allows a move up to the limit and not past it", () => {
    expect(allows(0, 0)).toBe(true);
    expect(allows(0, -1)).toBe(false);
    expect(allows(null, -10)).toBe(true);
  });

  it("classifies a move by its final position", () => {
    const origin = { x: 0, y: 0 };
    expect(outcome({ origin, planned: { x: 5, y: 0 }, final: { x: 5, y: 0 } })).toBe("completed");
    expect(outcome({ origin, planned: { x: 5, y: 0 }, final: { x: 0, y: 0 } })).toBe("rejected");
    expect(outcome({ origin, planned: { x: 5, y: 0 }, final: { x: 3, y: 0 } })).toBe("truncated");
  });
});
