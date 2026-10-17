import { describe, expect, it } from "vitest";
import { OPEN_PARTY_KEY, partyOpenDecision } from "../../scripts/lib/party.mjs";

describe("partyOpenDecision", () => {
  const party = { name: "Party" };

  it("opens when a party is set and the user can view it", () => {
    expect(partyOpenDecision(party, true)).toBe("open");
  });

  it("denies when the user cannot view the party", () => {
    expect(partyOpenDecision(party, false)).toBe("denied");
  });

  it.each([null, undefined])("reports a missing party for %j", (missing) => {
    expect(partyOpenDecision(missing, true)).toBe("missing");
  });
});

describe("OPEN_PARTY_KEY", () => {
  it("is the KeyboardEvent.code for P", () => {
    expect(OPEN_PARTY_KEY).toBe("KeyP");
  });
});
