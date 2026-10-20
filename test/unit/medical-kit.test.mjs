import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WOUND_KIT_ACTION, WOUND_KIT_HEALING, woundsHealed } from "../../scripts/lib/medical-kit.mjs";

const source = new URL("../../packs/_source/items/", import.meta.url);
const kit = readdirSync(source).map((f) => JSON.parse(readFileSync(new URL(f, source), "utf8"))).find((d) => d.system?.identifier === "pfmWoundKit");

describe("woundsHealed", () => {
  it("heals 5 Wounds at standard quality, the same as Briannon's temple service", () => {
    expect(woundsHealed(0, 20)).toBe(5);
  });

  it("halves at shoddy (rounded up) and doubles for each tier above standard", () => {
    expect([-2, 0, 1, 2, 3].map((bonus) => woundsHealed(bonus, 100))).toEqual([3, 5, 10, 20, 40]);
  });

  it("never heals more Wounds than the target has", () => {
    expect(woundsHealed(3, 7)).toBe(7);
    expect(woundsHealed(0, 0)).toBe(0);
    expect(woundsHealed(0, undefined)).toBe(0);
  });

  it("treats an unknown quality bonus as standard", () => {
    expect(woundsHealed(9, 20)).toBe(WOUND_KIT_HEALING[0]);
  });
});

describe("Wound Medical Kit item", () => {
  it("exists in the items pack source", () => {
    expect(kit).toBeDefined();
  });

  it("is a standard kit consumable priced at 3 gp", () => {
    expect(kit.type).toBe("consumable");
    expect(kit.system.category).toBe("kit");
    expect(kit.system.quality).toBe("standard");
    expect(kit.system.price).toBe(300); // Crucible prices are in copper: 100 cp = 1 gp.
  });

  it("has one action, hooked by id, that is consumed and can only follow a Rest", () => {
    expect(kit.system.actions).toHaveLength(1);
    const [action] = kit.system.actions;
    expect(action.id).toBe(WOUND_KIT_ACTION);
    expect(action.tags).toEqual(expect.arrayContaining(["consume", "rest"]));
  });

  it("lists the same Wounds per quality in its description as the hook heals", () => {
    const text = kit.system.actions[0].description;
    for (const amount of Object.values(WOUND_KIT_HEALING)) expect(text).toContain(`Recover ${amount} <strong>Wounds`);
  });

  it("tells players in its flavour text that it treats Wounds after a Rest", () => {
    expect(kit.system.description.public).toContain("after a Rest to treat <strong>Wounds</strong>");
  });

  it("uses an icon that ships with the module", () => {
    for (const img of [kit.img, kit.system.actions[0].img]) {
      expect(img.startsWith("modules/pauls-foundry-module/")).toBe(true);
      expect(() => readFileSync(new URL(`../../${img.slice("modules/pauls-foundry-module/".length)}`, import.meta.url))).not.toThrow();
    }
  });

  it("has a Foundry id of 16 letters and digits that matches its LevelDB key", () => {
    expect(kit._id).toMatch(/^[a-zA-Z0-9]{16}$/);
    expect(kit._key).toBe(`!items!${kit._id}`);
  });
});
