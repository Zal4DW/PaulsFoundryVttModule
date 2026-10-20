import { WOUND_KIT_ACTION, woundsHealed } from "./lib/medical-kit.mjs";

/**
 * Register the Wound Medical Kit's action hook with Crucible.
 * Crucible reads crucible.api.hooks.action[actionId] when it prepares an action, the same way its own
 * healingElixir hook works. The kit item (packs/_source/items) carries the action, with the "consume" and "rest" tags.
 */
export function registerMedicalKit() {
  const hooks = globalThis.crucible?.api?.hooks?.action;
  if (!hooks) return;
  hooks[WOUND_KIT_ACTION] = {
    postActivate() {
      const bonus = this.usage.consumable?.config?.quality?.bonus ?? 0;
      for (const [target] of this.targets) {
        const delta = woundsHealed(bonus, target.system.resources.wounds?.value);
        if (delta > 0) this.recordEvent({ target, resources: [{ resource: "wounds", delta: -delta }] });
      }
    }
  };
}
