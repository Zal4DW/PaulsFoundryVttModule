import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("lang/en.json", () => {
  const keys = Object.keys(JSON.parse(readFileSync(new URL("../../lang/en.json", import.meta.url), "utf8")));

  // A missing key shows as raw text, such as an effect named "PFM.Dose.Addicted". Keys built at run time are skipped.
  it("has every key the scripts name in full", () => {
    const files = readdirSync(new URL("../../scripts/", import.meta.url), { recursive: true }).filter((f) => f.endsWith(".mjs"));
    const used = new Set(files.flatMap((f) => [...readFileSync(new URL(`../../scripts/${f}`, import.meta.url), "utf8")
      .matchAll(/["'`](PFM\.[A-Za-z0-9.]+[A-Za-z0-9])["'`]/g)].map((m) => m[1])));
    expect([...used].filter((k) => !keys.includes(k))).toEqual([]);
  });

  // Foundry expands dotted keys into nested objects. "A.B" and "A.B.C" cannot both exist,
  // and one clash stops the whole file from loading.
  it("has no key that is also the prefix of another key", () => {
    const clashes = keys.filter((k) => keys.some((other) => other.startsWith(`${k}.`)));
    expect(clashes).toEqual([]);
  });
});
