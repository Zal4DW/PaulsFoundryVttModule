import { describe, expect, it } from "vitest";
import { HELD_FLAG, holdForPlayer, isHeldMove, isPendingMove, MOVE_ACTION, pendingMovesFor } from "../../scripts/lib/move-confirm.mjs";

describe("holdForPlayer", () => {
  it("holds a Move card for a player who turned on Confirm my own movement", () => {
    expect(holdForPlayer({ actionId: MOVE_ACTION, authorIsGM: false, authorHolds: true })).toBe(true);
  });

  it("leaves every other card to the GM's normal auto-confirm", () => {
    expect(holdForPlayer({ actionId: MOVE_ACTION, authorIsGM: false, authorHolds: false })).toBe(false);
    expect(holdForPlayer({ actionId: "strike", authorIsGM: false, authorHolds: true })).toBe(false);
    expect(holdForPlayer({ actionId: MOVE_ACTION, authorIsGM: true, authorHolds: true })).toBe(false);
  });
});

describe("isPendingMove", () => {
  it("is true only for an unconfirmed Move card", () => {
    expect(isPendingMove({ action: { id: "move" }, confirmed: false })).toBe(true);
    expect(isPendingMove({ action: { id: "move" }, confirmed: true })).toBe(false);
    expect(isPendingMove({ action: { id: "strike" }, confirmed: false })).toBe(false);
    expect(isPendingMove(undefined)).toBe(false);
  });
});

describe("isHeldMove", () => {
  it("is true only for a pending Move card the module held back", () => {
    expect(isHeldMove({ action: { id: "move" }, confirmed: false }, { [HELD_FLAG]: true })).toBe(true);
    expect(isHeldMove({ action: { id: "move" }, confirmed: true }, { [HELD_FLAG]: true })).toBe(false);
  });

  it("leaves a pending card with no marker to the GM, as when the GM turned auto-confirm off to review moves", () => {
    expect(isHeldMove({ action: { id: "move" }, confirmed: false }, undefined)).toBe(false);
    expect(isHeldMove({ action: { id: "move" }, confirmed: false }, {})).toBe(false);
  });
});

describe("pendingMovesFor", () => {
  const card = (id, authorId, actorUuid, actionId, confirmed, held = true) =>
    ({ id, authorId, actorUuid, flags: { action: { id: actionId }, confirmed }, moduleFlags: held ? { [HELD_FLAG]: true } : {} });

  it("finds this user's held, unconfirmed Move cards for this actor, and nothing else", () => {
    const messages = [
      card("a", "player", "Actor.hero", "move", false),
      card("b", "player", "Actor.hero", "move", true),
      card("c", "player", "Actor.other", "move", false),
      card("d", "someone", "Actor.hero", "move", false),
      card("e", "player", "Actor.hero", "strike", false),
      card("f", "player", "Actor.hero", "move", false, false)
    ];
    expect(pendingMovesFor(messages, { userId: "player", actorUuid: "Actor.hero" }).map((m) => m.id)).toEqual(["a"]);
  });
});
