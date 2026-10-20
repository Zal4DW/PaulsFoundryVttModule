// Registers the Crucible integration with Item Piles (see scripts/lib/item-piles.mjs for the why).
import { crucibleItemPilesConfig } from "./lib/item-piles.mjs";

export function registerItemPiles(moduleId) {
  game.settings.register(moduleId, "itemPilesIntegration", {
    name: "PFM.Settings.ItemPilesIntegration.Name",
    hint: "PFM.Settings.ItemPilesIntegration.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true
  });

  // Item Piles fires this once its API is ready, on every client. "latest" applies it to any Crucible version.
  Hooks.once("item-piles-ready", async (api) => {
    if (!game.settings.get(moduleId, "itemPilesIntegration")) return;
    await (api ?? game.itempiles.API).addSystemIntegration(crucibleItemPilesConfig(), "latest");
  });
}
