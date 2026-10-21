// Crucible's token collision lets players move through Secret-disposition tokens, but not through hidden ones.
// So a player bumps into an invisible wall where the GM has hidden a token, and finds the ambush.
// This makes hidden tokens exempt from collision for players, the same as Secret ones. The GM's moves still collide.

export function registerHiddenCollision() {
  Hooks.once("ready", () => {
    if (game.user.isGM) return;
    const Polygon = globalThis.crucible?.api?.canvas?.CrucibleMovementPolygon;
    if (!Polygon) return;
    const initialize = Polygon.prototype.initialize;
    // testCollision builds a new polygon and calls initialize, so this covers rulers, drags and paths.
    Polygon.prototype.initialize = function (origin, config = {}) {
      const test = config.excludeTokenTest;
      config.excludeTokenTest = (token) => token.document.hidden || !!test?.(token);
      return initialize.call(this, origin, config);
    };
  });
}
