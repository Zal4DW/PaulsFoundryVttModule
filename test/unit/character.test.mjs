import { describe, expect, it } from "vitest";
import { chooseCharacter, OPEN_CHARACTER_KEY } from "../../scripts/lib/character.mjs";

describe("chooseCharacter", () => {
  it("opens the active-turn actor first, whatever else is selected", () => {
    expect(chooseCharacter({ activeTurn: "a", selected: ["b"], assigned: "c", owned: ["d"] })).toEqual({
      mode: "open",
      id: "a",
      reason: "turn"
    });
  });

  it("opens a single selected token's actor", () => {
    expect(chooseCharacter({ selected: ["b"], assigned: "c", owned: ["c", "d"] })).toEqual({
      mode: "open",
      id: "b",
      reason: "selected"
    });
  });

  it("treats the same actor selected twice as one selection", () => {
    expect(chooseCharacter({ selected: ["b", "b"], owned: ["c"] })).toMatchObject({ mode: "open", id: "b" });
  });

  it("opens the only candidate without a list", () => {
    expect(chooseCharacter({ assigned: "c", owned: ["c"] })).toEqual({ mode: "open", id: "c", reason: "assigned" });
    expect(chooseCharacter({ owned: ["d"] })).toEqual({ mode: "open", id: "d", reason: "owned" });
  });

  it("lists several owned characters", () => {
    expect(chooseCharacter({ owned: ["a", "b"] })).toEqual({
      mode: "pick",
      choices: [
        { id: "a", hints: [] },
        { id: "b", hints: [] }
      ]
    });
  });

  it("puts targeted, then assigned, before plain owned characters", () => {
    const result = chooseCharacter({ targeted: ["t"], assigned: "s", owned: ["o", "s", "t"] });
    expect(result.mode).toBe("pick");
    expect(result.choices).toEqual([
      { id: "t", hints: ["targeted"] },
      { id: "s", hints: ["assigned"] },
      { id: "o", hints: [] }
    ]);
  });

  it("lists every selected token when more than one is selected, with merged hints", () => {
    const result = chooseCharacter({ selected: ["a", "b"], targeted: ["b"], owned: ["c"] });
    expect(result.choices).toEqual([
      { id: "a", hints: ["selected"] },
      { id: "b", hints: ["selected", "targeted"] },
      { id: "c", hints: [] }
    ]);
  });

  it("returns none when the user has nothing", () => {
    expect(chooseCharacter({})).toEqual({ mode: "none" });
    expect(chooseCharacter()).toEqual({ mode: "none" });
  });
});

describe("OPEN_CHARACTER_KEY", () => {
  it("is the KeyboardEvent.code for C", () => {
    expect(OPEN_CHARACTER_KEY).toBe("KeyC");
  });
});
