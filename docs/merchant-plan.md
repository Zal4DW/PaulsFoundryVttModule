# Merchant plan

A merchant window in Paul's Foundry Module to replace Crucible Shop. Item Piles stays: it runs the loot and corpse piles, the crate and lock box, and the Party Stash bridge.

Status: phase 1 (Buy) is built. Phases 2 to 4 are not started.

Until phase 3 adds a setup window, the GM sets merchants up from a macro:

```js
const api = game.modules.get("pauls-foundry-module").api;
const muskrat = game.actors.getName("Muskrat, Provider of Medicines");
await api.setMerchant(muskrat, { buyRate: 50, catalogue: [{ id: "kit", uuid: "Compendium.pauls-foundry-module.items.Item.<id>", count: 2 }] });
await api.inviteToMerchant(muskrat);           // everyone, or pass an array of user ids
api.openMerchant(muskrat);                     // the GM's own view
```

Items placed on the merchant actor also sell, as held items.

## Why replace Crucible Shop

- Crucible Shop has no stock counts. Paul sets up a separate Item Piles merchant (Muskrat) whenever an item is limited.
- Item Piles merchants show prices in copper only ("7200cp" for a 72 gp Plate Mail). Crucible keeps coin as one copper number at `system.currency`, and Item Piles can't split that into gp, sp and cp.
- Two shop addons mean two setups, two windows, and two things a Crucible or Foundry update can break between sessions.

## What the merchants are today

| Merchant | Addon | Stock | Rates | Notes |
|---|---|---|---|---|
| Clipper's Wares | Crucible Shop `clipper` | Compendium list, unlimited | sell 50% | GM approval on. Trades from the caravan, no map token |
| The Armarium | Crucible Shop `armarium` | 52 compendium items, unlimited | buy 80%, sell 50% | One-off items removed by hand after a sale |
| Muskrat, Provider of Medicines | Item Piles merchant actor | 5 stacks: Dose ×1, Wound Medical Kit ×2, Healing Elixir ×3, Healing Tonic ×1, Antitoxin ×2 | buy 50% | Thornling. Limited stock |

"Buy" is the share of the list price a hero pays. "Sell" is the share the merchant pays a hero for an item.

## What our merchant does

1. **Stock with counts.** Each line has a count, or is unlimited. The count drops as heroes buy.
2. **Rates per merchant.** A buy rate and a sell rate, both as percentages. One line can override its price.
3. **Coin shown properly.** Prices and purses show as "7PP 2GP 4SP 5CP", using Crucible's own `CrucibleItem.formatCurrency` and `CrucibleActor.allocateCurrency`.
4. **Opens without a token.** The GM posts an invite card to chat, for all players or for chosen ones, and the card has an "Open shop" button. A merchant with a token on the map also opens from its token.
5. **Optional GM approval.** When approval is on, a purchase waits until the GM clicks Approve or Decline.
6. **Selling to the merchant.** A hero drags an item from their sheet onto the window and gets the sell rate in coin.
7. **A receipt in chat.** Each trade posts who bought or sold what, and for how much. The GM can undo a trade from its receipt.

Not in scope: haggling rolls, opening times, restocking on a timer, and buying with Party Stash coin. Each could come later.

## How it works

### Data

A merchant is an adversary actor with the flag `pauls-foundry-module.merchant`. It's an adversary for the same reason as Item Piles: a hero actor needs an ancestry and background.

```js
{
  enabled: true,
  buyRate: 80,             // percent of list price a hero pays
  sellRate: 50,            // percent of list price the merchant pays
  requireApproval: false,
  catalogue: [             // items listed by compendium or world uuid
    { id: "helm", uuid: "Compendium.crucible.equipment.Item.helm000000000000", count: null, price: null }, // null count = unlimited
    { id: "dose", uuid: "Compendium.pauls-foundry-module.items.Item.dose...", count: 1, price: null }
  ],
  log: []                  // the last 50 trades, for undo
}
```

There are two kinds of stock:
- **Catalogue lines.** These are uuids with a count. The merchant doesn't hold a copy of the item, and a purchase creates a new one from the uuid. This replaces Crucible Shop's item lists.
- **Held items.** These are real items embedded on the merchant actor, such as anything a hero sells and one-off finds. A purchase moves that exact item, so its quality, affixes and name come with it. Crucible clamps quantity to 1 unless an item is stackable, so a stack of non-stackable items is held as separate items.

### Trades run on the GM's client

A player can't edit the merchant actor or another hero, so every trade runs on the active GM's client.

1. `module.json` has `"socket": true`. The player's window sends `{ type: "merchantTrade", requestId, request }` on `module.pauls-foundry-module` to the active GM only. `request` is `{ action, merchantId, actorId, source, id, quantity }`: `source` is `"catalogue"` or `"held"`, and `id` is the line id or the held item's id. The GM takes the sender's user id from the server, which sets it from the sender's authenticated socket, never from the message.
2. The active GM (`game.users.activeGM`) handles the requests one at a time, in a queue. So when two players buy the last Dose at once, the first gets it and the second gets "sold out".
3. The GM's client checks the trade again with fresh data: stock, the hero's coin, and that the user owns the hero. Then it applies the trade:
   - Buy: take the coin from the hero, create or move the item, lower the count, and post the receipt.
   - Sell: take the item from the hero, add it to the held items, pay the coin, and post the receipt.
4. The GM's client replies with a result, and the window re-renders.
5. With approval on, step 3 waits for the GM's Approve or Decline on an approval card that only the GM sees.

If no GM is logged in, the window says that trades need a GM.

### Pure helpers in `scripts/lib/merchant.mjs`

These use no Foundry globals, so Vitest can test them in Node:
- `priceFor(listPrice, rate, override)`: rounds to whole copper.
- Phase 1 (built): `normaliseMerchant(data)`, `priceFor(listPrice, rate, override)`, `checkBuy(state)`, `takeFromCatalogue(catalogue, lineId, qty)`, `logTrade(log, entry)` and `fromCrucibleShop(shop, makeId)`.
- Phase 2: `checkSell(state)`, plus helpers to put stock back and mark a trade undone.
- Phase 3: `fromItemPilesMerchant(flags, items)`, to import Muskrat.

### Windows

- `MerchantWindow` (ApplicationV2): stock list with name, icon, price and count, and a Buy button with a quantity. It has a type filter, the hero's purse, and a drop zone for selling. Players see only the merchants the GM has invited them to.
- `MerchantConfig` (ApplicationV2, GM only): rates, approval, catalogue lines (drag items in from a compendium), counts and price overrides.

Before writing each one, check the v14 API docs for `ApplicationV2`, `HandlebarsApplicationMixin` (and its `PARTS`), `game.socket`, the `renderChatMessageHTML` hook, and how a token double-click can open the window instead of the limited sheet.

## Phases

Each phase is one PR, with `npm run lint` and `npm test` passing.

1. **Buy.** The data flag, the pure helpers with Vitest tests, the GM trade queue over the socket, the window with Buy, gp/sp/cp prices, the invite card and the receipt. A Quench test covers a real purchase, a sell-out race between two requests, and not enough coin.
2. **Sell, approval and undo.** Drag to sell, the approval card, and undo from the receipt. Quench tests cover each of these.
3. **Setup and moving over.** `MerchantConfig`, opening from a token, and a GM button that imports Clipper and the Armarium from Crucible Shop and Muskrat from Item Piles. A Playwright test logs in as `paul`, opens the invite and buys an item on the Docker v14 server.
4. **Retire Crucible Shop.** After one live session with no shop problems, Paul disables Crucible Shop on the real install, and the docs are updated. Muskrat's Item Piles merchant flag is turned off, so Item Piles holds only loot.

## Decisions

Paul answered these on 2026-10-25:

1. A hero pays from their own purse only, not from the Party Stash.
2. Approval is per merchant: Clipper on, the others off.
3. An item a hero sells joins the merchant's held items, and the next hero can buy it at the buy rate.
4. The last 50 trades stay undoable, across sessions.
