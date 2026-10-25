import { describe, expect, it } from "vitest";
import { hasOwnLight, isRevealConfirm, planTosslight, revealSelfTargetHooks, tosslightTokenUuid, TOSSLIGHT_LIGHT } from "../../scripts/lib/tosslight.mjs";

const DARK = { bright: 0, dim: 0 };
const reveal = (extra = {}) => ({ action: { id: "reveal" }, token: "Scene.s.Token.lyra", targets: [], ...extra });

describe("Reveal's tosslight", () => {
  it("sheds bright light to 20 ft and dim to 40 ft, as the spell says", () => {
    expect([TOSSLIGHT_LIGHT.bright, TOSSLIGHT_LIGHT.dim]).toEqual([20, 40]);
  });

  it("acts only when the GM confirms a Reveal card", () => {
    const confirm = { flags: { crucible: { confirmed: true } } };
    expect(isRevealConfirm(reveal(), confirm)).toBe(true);
    expect(isRevealConfirm(reveal(), { content: "<p>edit</p>" })).toBe(false);
    expect(isRevealConfirm(reveal(), { flags: { crucible: { confirmed: false } } })).toBe(false);
    expect(isRevealConfirm({ action: { id: "spell.life.ray" } }, confirm)).toBe(false);
  });

  it("goes on the target, or on the caster when nothing was targeted", () => {
    expect(tosslightTokenUuid(reveal({ targets: [{ actor: "Actor.b", token: "Scene.s.Token.brannoc" }] }))).toBe("Scene.s.Token.brannoc");
    expect(tosslightTokenUuid(reveal())).toBe("Scene.s.Token.lyra");
    expect(tosslightTokenUuid({})).toBe(null);
  });

  it("treats any light radius as the token's own light", () => {
    expect(hasOwnLight(DARK)).toBe(false);
    expect(hasOwnLight({ bright: 0, dim: 15 })).toBe(true);
    expect(hasOwnLight(undefined)).toBe(false);
  });

  it("places a tosslight on an unlit token", () => {
    expect(planTosslight({ uuid: "T1", light: DARK, tosslight: null }, "Actor.lyra", [])).toEqual({ place: true, clear: [] });
  });

  it("moves the caster's tosslight, since a caster has only one", () => {
    const lit = [{ uuid: "T1", caster: "Actor.lyra" }, { uuid: "T2", caster: "Actor.vex" }];
    expect(planTosslight({ uuid: "T3", light: DARK, tosslight: null }, "Actor.lyra", lit)).toEqual({ place: true, clear: ["T1"] });
  });

  it("does not replace a light the token already has", () => {
    expect(planTosslight({ uuid: "T1", light: { bright: 15, dim: 30 }, tosslight: null }, "Actor.lyra", [])).toEqual({ place: false, clear: [], reason: "ownLight" });
  });

  it("keeps the light when the caster recasts on the same token", () => {
    const lit = [{ uuid: "T1", caster: "Actor.lyra" }];
    expect(planTosslight({ uuid: "T1", light: TOSSLIGHT_LIGHT, tosslight: { caster: "Actor.lyra" } }, "Actor.lyra", lit)).toEqual({ place: false, clear: [] });
  });

  it("leaves another caster's tosslight alone", () => {
    const lit = [{ uuid: "T1", caster: "Actor.vex" }];
    expect(planTosslight({ uuid: "T1", light: TOSSLIGHT_LIGHT, tosslight: { caster: "Actor.vex" } }, "Actor.lyra", lit)).toEqual({ place: false, clear: [], reason: "taken" });
  });

  it("goes on the caster's token when the caster targets themselves", () => {
    const self = { actor: "Scene.s.Token.lyra.Actor.lyra", token: "Scene.s.Token.lyra" };
    expect(tosslightTokenUuid(reveal({ targets: [self] }))).toBe("Scene.s.Token.lyra");
  });
});

describe("Reveal's self-target hook", () => {
  // Crucible's Reveal action as it comes from the talent pack: one target, never the caster.
  const action = () => ({ id: "reveal", target: { type: "single", number: 1, scope: 4, self: false } });

  it("lets Reveal target its caster", () => {
    const a = action();
    revealSelfTargetHooks().prepare.call(a);
    expect(a.target.self).toBe(true);
    expect(a.target.type).toBe("single");
  });

  it("leaves Reveal alone while the setting is off", () => {
    const a = action();
    revealSelfTargetHooks({}, () => false).prepare.call(a);
    expect(a.target.self).toBe(false);
  });

  it("keeps hooks already registered for Reveal, and runs their prepare first", () => {
    const calls = [];
    const roll = () => {};
    const hooks = revealSelfTargetHooks({ roll, prepare() { calls.push(this.target.self); } });
    const a = action();
    hooks.prepare.call(a);
    expect(calls).toEqual([false]);
    expect(a.target.self).toBe(true);
    expect(hooks.roll).toBe(roll);
  });
});
