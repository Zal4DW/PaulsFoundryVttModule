import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("lang/en.json", () => {
  const keys = Object.keys(JSON.parse(readFileSync(new URL("../../lang/en.json", import.meta.url), "utf8")));

  // Foundry expands dotted keys into nested objects. "A.B" and "A.B.C" cannot both exist,
  // and one clash stops the whole file from loading.
  it("has no key that is also the prefix of another key", () => {
    const clashes = keys.filter((k) => keys.some((other) => other.startsWith(`${k}.`)));
    expect(clashes).toEqual([]);
  });
});
