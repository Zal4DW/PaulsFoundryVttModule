// Reveal's tosslight on Crucible tokens. When the GM confirms a Reveal card, the target's token (or the caster's,
// with no target) gets the light, saved on the token so every client sees it. The token's earlier light is kept in
// a flag and comes back when the tosslight goes. A token HUD button dismisses it, as the spell lets the caster do.
// Reveal has other uses (invisible text, colour changes), so the "Reveal Light" setting turns this off.
import { isRevealConfirm, planTosslight, TOSSLIGHT_LIGHT, tosslightTokenUuid } from "./lib/tosslight.mjs";

const FLAG = "tosslight";

const isActiveGM = () => game.user.isGM && game.users.activeGM?.id === game.user.id;

/** Every token in the world that carries a tosslight. */
function litTokens(moduleId) {
  return game.scenes.contents.flatMap((s) => s.tokens.contents)
    .map((t) => ({ token: t, flag: t.getFlag(moduleId, FLAG) }))
    .filter((x) => x.flag)
    .map(({ token, flag }) => ({ uuid: token.uuid, caster: flag.caster, token }));
}

/** Put a token's earlier light back and drop the flag. */
export async function dismissTosslight(moduleId, token) {
  const flag = token?.getFlag(moduleId, FLAG);
  if (!flag) return false;
  await token.update({ light: flag.prior ?? { bright: 0, dim: 0 } });
  await token.unsetFlag(moduleId, FLAG);
  return true;
}

/** Place the caster's tosslight on a token, moving it from wherever it was before. */
export async function placeTosslight(moduleId, token, casterUuid) {
  const lit = litTokens(moduleId);
  const plan = planTosslight({ uuid: token.uuid, light: token.light, tosslight: token.getFlag(moduleId, FLAG) ?? null }, casterUuid, lit);
  for (const uuid of plan.clear) await dismissTosslight(moduleId, lit.find((t) => t.uuid === uuid)?.token);
  if (plan.reason) ui.notifications.info(game.i18n.format(`PFM.Tosslight.${plan.reason === "ownLight" ? "OwnLight" : "Taken"}`, { token: token.name }));
  if (!plan.place) return plan;
  await token.update({ light: TOSSLIGHT_LIGHT, [`flags.${moduleId}.${FLAG}`]: { caster: casterUuid, prior: token.light.toObject() } });
  return plan;
}

export function registerTosslight(moduleId) {
  game.settings.register(moduleId, "revealLight", {
    name: "PFM.Settings.RevealLight.Name",
    hint: "PFM.Settings.RevealLight.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // updateChatMessage fires on every client; only the active GM writes the token, so the light is placed once.
  Hooks.on("updateChatMessage", async (message, changed) => {
    if (!isActiveGM() || !game.settings.get(moduleId, "revealLight")) return;
    const flags = message.flags?.crucible;
    if (!isRevealConfirm(flags, changed)) return;
    const token = fromUuidSync(tosslightTokenUuid(flags) ?? "");
    if (!token || !flags.actor) return;
    await placeTosslight(moduleId, token, flags.actor);
  });

  // A "Dismiss tosslight" button on the token HUD of a lit token. TokenHUD is an ApplicationV2, so render{ClassName} fires.
  Hooks.on("renderTokenHUD", (hud, element) => {
    const token = hud.document;
    if (!token?.getFlag(moduleId, FLAG) || !token.isOwner) return;
    const column = element.querySelector(".col.right") ?? element;
    if (column.querySelector(".pfm-tosslight")) return;
    const label = game.i18n.localize("PFM.Tosslight.Dismiss");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "control-icon pfm-tosslight";
    button.dataset.tooltip = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = `<i class="fa-solid fa-lightbulb-slash"></i>`;
    button.addEventListener("click", async (event) => {
      event.preventDefault(); event.stopPropagation();
      await dismissTosslight(moduleId, token);
      hud.close();
    });
    column.append(button);
  });
}
