// Airborne tokens: core's elevation tooltip is small plain text, easy to miss on a dark map.
// This draws a badge behind that tooltip and a soft shadow on the ground under the token, offset so it shows past the art.

const SHADOW = Symbol("pfm-elevation-shadow");
const BADGE = Symbol("pfm-elevation-badge");

/** Height above the viewed level's floor, as core's elevation tooltip measures it. */
const heightOf = (token) => token.document.elevation - (canvas.level?.elevation?.base ?? 0);

export function registerElevationBadge(moduleId) {
  game.settings.register(moduleId, "elevationBadge", {
    name: "PFM.Settings.ElevationBadge.Name",
    hint: "PFM.Settings.ElevationBadge.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => canvas.tokens?.placeables.forEach((t) => t.renderFlags.set({ refreshState: true, refreshPosition: true }))
  });

  Hooks.on("refreshToken", (token) => refresh(token, game.settings.get(moduleId, "elevationBadge")));
}

function refresh(token, enabled) {
  const show = enabled && heightOf(token) > 0 && token.visible && !token.document.isSecret;
  refreshShadow(token, show);
  refreshBadge(token, show);
}

function refreshShadow(token, show) {
  let shadow = token[SHADOW];
  if (!show) {
    if (shadow) shadow.visible = false;
    return;
  }
  const { width, height } = token.document.getSize();
  if (!shadow || shadow.destroyed) {
    // A child of the placeable, drawn first so the border, bars and tooltip sit on top. The placeable is above the
    // token's art, so this is an outline ring and a dark wash rather than a solid shadow.
    shadow = token[SHADOW] = new PIXI.Graphics();
    shadow.eventMode = "none";
    token.addChildAt(shadow, 0);
  }
  // The ring falls below the token's centre: the higher the token, the further, up to a third of its height.
  const drop = Math.min(height / 3, (heightOf(token) / canvas.grid.distance) * canvas.grid.size * 0.5);
  const rx = width * 0.42;
  const ry = height * 0.2;
  shadow.clear()
    .beginFill(0x000000, 0.35).drawEllipse(width / 2, (height / 2) + drop, rx, ry).endFill()
    .lineStyle(Math.max(2, width / 80), 0x7fd4ff, 0.8).drawEllipse(width / 2, (height / 2) + drop, rx, ry);
  shadow.visible = true;
}

function refreshBadge(token, show) {
  const tooltip = token.tooltip;
  if (!tooltip) return;
  let badge = token[BADGE];
  if (!badge || badge.destroyed) {
    badge = token[BADGE] = new PIXI.Graphics();
    badge.eventMode = "none";
  }
  if (badge.parent !== token) token.addChildAt(badge, token.getChildIndex(tooltip));
  badge.clear();
  badge.visible = show && tooltip.visible && !!tooltip.text;
  if (!badge.visible) return;
  // The tooltip's local bounds include its anchor offset, so scaling them gives its box in the token's space.
  const lb = tooltip.getLocalBounds(new PIXI.Rectangle());
  const { x: sx, y: sy } = tooltip.scale;
  const x = tooltip.x + (lb.x * sx);
  const y = tooltip.y + (lb.y * sy);
  const w = lb.width * sx;
  const h = lb.height * sy;
  const pad = h * 0.2;
  badge.lineStyle(Math.max(2, h / 12), 0x7fd4ff, 1)
    .beginFill(0x0b2233, 0.85)
    .drawRoundedRect(x - (pad * 2), y - (pad / 2), w + (pad * 4), h + pad, (h + pad) / 2)
    .endFill();
}
