import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../../module.json", import.meta.url), "utf8"));

// Foundry validates a manifest strictly when it installs from a URL. A local folder install is more forgiving,
// so these mistakes only show up on a real install. v0.2.0 failed with "type: optional is not a valid choice".
describe("module.json", () => {
  it("downloads the zip of its own version", () => {
    expect(manifest.download).toBe(`https://github.com/Zal4DW/PaulsFoundryVttModule/releases/download/v${manifest.version}/module.zip`);
    expect(manifest.manifest).toBe("https://github.com/Zal4DW/PaulsFoundryVttModule/releases/latest/download/module.json");
  });

  it("uses only package types Foundry accepts in relationships", () => {
    const allowed = { systems: ["system"], requires: ["module", "system", "world"], recommends: ["module", "system", "world"], conflicts: ["module", "system", "world"] };
    for (const [group, list] of Object.entries(manifest.relationships ?? {})) {
      for (const rel of list) if (rel.type !== undefined) expect(allowed[group]).toContain(rel.type);
    }
  });

  it("lists files that exist", () => {
    for (const path of [...manifest.esmodules, ...manifest.styles, ...manifest.languages.map((l) => l.path)]) {
      expect(() => readFileSync(new URL(`../../${path}`, import.meta.url))).not.toThrow();
    }
  });

  it("gives each Item pack a system and a JSON source folder to build it from", () => {
    // Foundry requires a system on Actor, Item and Adventure packs. The LevelDB folder itself is built, not committed.
    for (const pack of manifest.packs ?? []) {
      if (["Actor", "Item", "Adventure"].includes(pack.type)) expect(pack.system).toBe("crucible");
      expect(pack.path).toBe(`packs/${pack.name}`);
      expect(() => readdirSync(new URL(`../../packs/_source/${pack.name}`, import.meta.url))).not.toThrow();
    }
  });
});
