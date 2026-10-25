# Movement collision sweep

Players in the Ember game reported that a token move sometimes does not complete after they confirm it. This report
covers a repeatable sweep on the Docker v14 server, what it found, and the fixes it points to. Nothing here changes
module behaviour yet.

Tested on Foundry 14.369, Crucible 0.11.2, `CrucibleMovementPolygon` as the move backend, microgrid of 1 ft cells.

## Short answer

There are three separate causes. Only the first is about collision geometry.

1. **Collision uses the mover's centre, not its footprint.** Core Foundry tests the path of the token's centre.
   Crucible turns each blocking token's full footprint into wall edges, so the blocker's size counts but the mover's
   size does not. A mover can push into a wall or a token by just under half its own width. If its centre line misses
   the blocker, it passes straight through, even when the two footprints overlap.
2. **An unseen obstacle gives a clear ruler but a short drop.** The ruler (preview) ignores walls and tokens the player
   cannot see. The drop does not. The player sees a clear path, drops, and the token stops short or does not move.
3. **move-confirm can confirm one card twice, and rejects drags by design.** A drag soon after Confirm (or after a
   late Move card) is rejected with "Drag again", and the same card can be confirmed twice, which spends its AP twice.
   The player's next move then fails with "insufficient action".

Causes 2 and 3 look like "the move did not complete". Cause 1 makes tokens end up too close, and it does not stop a
move part way unless the centre line hits something.

## How the sweep works

`test/e2e/move-sweep.spec.mjs` (Playwright). Pure helpers and the two models are in `test/e2e/move-sweep-model.mjs`,
with unit tests in `test/unit/move-sweep-model.test.mjs`.

- The GM builds a throwaway scene (100 px grid, 5 ft, so 20 px per 1 ft cell), a combat, a player user, a mover for
  each size and a 4 ft blocker. The player has "Confirm my own movement" on.
- Each case puts the mover 6 ft from the obstacle in a lane, then moves it towards the obstacle in steps. The planned
  gap between the mover's leading face and the obstacle's face goes 4, 2, 1, 0, then negative (overlap) to past half
  the mover's width.
- Lanes (vertical offset `dy` from the blocker's top edge): touching only, 1 ft footprint overlap with the centre
  outside, centre on the edge, centre 1 ft inside, aligned.
- Obstacles: `wall`, `token`, `hidden` (GM-hidden token), `dark` (no light, mover has no sight, so the blocker is not
  seen), `dark-wall`, and `actors` (other kinds of blocker, opt-in).
- Before each drop the player records the ruler result (`findMovementPath` with `preview: true`), the real constraint
  (`constrainMovementPath` with `preview: false`), a centre-line `testCollision`, the centre and the bounds. After the
  drop it waits for the Move card, clicks the module's Confirm button, and records the final position.
- Headless Chromium runs Foundry at about 3 FPS, so a real mouse drag never starts. The spec sends the same update
  core's drag-drop sends (`Token#_getDragLeftDropUpdateOptions`, `method: "dragging"`, `movement.waypoints`). So
  `TokenDocument#_preUpdate`, `preMoveToken`, Crucible's AP check and move-confirm all run as normal.
- Each case's set-up moves use the `displace` waypoint action with `method: "config"`, so they make no Move card.

Run it with the shared server lock held, one size at a time:

```bash
PFM_MOVE_SWEEP=1 PFM_SWEEP_SIZES=4 bash /e/Development/PaulFoundryVttModule/.foundry/server-lock.sh run "movement-sweep" npx playwright test test/e2e/move-sweep.spec.mjs --reporter=line
```

Options: `PFM_SWEEP_OBSTACLES=wall,token,hidden,dark` (default), `actors`, or `none` (timing only);
`PFM_SWEEP_TIMING=0` skips the timing scenario; `PFM_SWEEP_DEBUG=1` saves screenshots. One size with the default
obstacles takes about 5 minutes. Results go to `sweep-results/` (gitignored), and each move prints a `row` JSON line.

## Results

### Walls: centre-point stop

Every size stops just under half its width past the wall face. The ruler and the drop agree.

| Mover size | Last gap that completes | Stop on the next step | Overlap at stop |
|---|---|---|---|
| 2 ft | 0 | truncated at -0.95 | 0.95 ft |
| 4 ft | -1 | truncated at -1.95 | 1.95 ft |
| 5 ft | -2 | truncated at -2.45 | 2.45 ft |
| 8 ft | -3 | truncated at -3.95 | 3.95 ft |
| 10 ft | -4 | truncated at -4.95 | 4.95 ft |

A footprint model would stop every size at gap 0. The step after the truncation is a no-op ("rejected" in the raw
data), because the token is already at the limit.

### Tokens: centre line against the blocker's footprint

A 4 ft blocker, 4 ft mover:

| Lane `dy` | What overlaps | Gap -1 | Gap -2 | Gap -3 |
|---|---|---|---|---|
| -4 | edges touch only | completes | completes | completes |
| -3 | 1 ft of footprint, centre outside | completes | completes | completes |
| -2 | centre line on the blocker's edge | completes | truncated at -1.95 | stays at -1.95 |
| -1 | centre 1 ft inside | completes | truncated at -1.95 | stays at -1.95 |
| 0 | aligned | completes | truncated at -1.95 | stays at -1.95 |

A 10 ft mover against a 4 ft blocker:

| Lane `dy` | What overlaps | Result |
|---|---|---|
| -10 | edges touch only | passes, as expected |
| -9 | 1 ft of footprint, centre 4 ft outside | passes all the way to gap -6 (6 ft into the blocker's column) |
| -5 | centre on the edge | stops at -4.95 |
| -4, -3 | centre inside | stops at -4.95 |

So the answer to "does it go wrong when the centre crosses the blocker's box?" is yes. The test is exactly "would the
mover's centre cross into the blocker's footprint". The blocker's footprint is right for its size. The mover's
footprint is not used at all. Across all sizes, the token lanes matched the centre model except at the exact
boundary, where a centre that lands on the edge counts as a hit.

Summary per size (wrong vs a model means the move did or did not complete when that model said otherwise; most
"wrong vs centre" rows are the boundary case or a "Drag again" rejection, see cause 3):

| Size | Obstacle | Moves | Completed | Wrong vs footprint | Wrong vs centre | Ruler differs from drop | Max overlap ft |
|---|---|---|---|---|---|---|---|
| 2 | wall | 6 | 4 | 0 | 1 | 0 | 0.95 |
| 2 | token | 24 | 18 | 0 | 4 | 0 | 0.95 |
| 4 | wall | 7 | 4 | 2 | 2 | 0 | 1.95 |
| 4 | token | 35 | 29 | 6 | 4 | 0 | 3 |
| 5 | wall | 8 | 6 | 2 | 0 | 0 | 2.45 |
| 5 | token | 40 | 35 | 11 | 1 | 0 | 4 |
| 8 | wall | 9 | 7 | 3 | 1 | 0 | 3.95 |
| 8 | token | 45 | 36 | 17 | 7 | 0 | 5 |
| 10 | wall | 9 | 6 | 4 | 2 | 0 | 4.95 |
| 10 | token | 45 | 35 | 14 | 8 | 0 | 6 |

"Max overlap" for tokens includes the edge lanes, where the mover passes through without any stop.

### Hidden tokens

For the player, a GM-hidden token never blocks, in any lane or size. This is `scripts/hidden-collision.mjs`
working as designed: it adds `token.document.hidden` to Crucible's `excludeTokenTest`
(`scripts/hidden-collision.mjs:12-15`). Without it, a hidden blocker would stop the drop and give away its position.

### Unseen obstacles: ruler and drop disagree

With the lights off and the mover blind, the ruler shows a clear path and the drop stops the token:

| Size | Obstacle | Planned gap | Ruler | Drop |
|---|---|---|---|---|
| 4 | dark (token) | -2 | clear | truncated at -1.95 |
| 4 | dark (token) | -3 | clear | no move |
| 4 | dark-wall | -3 | clear | no move |
| 10 | dark (token) | -5 | clear | truncated at -4.95 |
| 10 | dark-wall | -6 | clear | no move |

Core does this on purpose. With `preview: true`, `Token#constrainMovementPath` only lets collisions the user can see
or has explored block the ruler (core `client/canvas/placeables/token.mjs` around 3268-3277). The drop runs again with
`preview: false` in `TokenDocument#_preUpdate` (core `client/documents/token.mjs` around 1812-1816) and stops on
everything. In a dark room or behind an unseen creature, this looks to the player exactly like a glitch: a clear ruler,
then a short move.

### Other kinds of blocker

`PFM_SWEEP_OBSTACLES=actors` puts one other kind of blocker in the way at a time, in the aligned lane and the 1 ft
overlap lane. `PFM_SWEEP_KINDS` picks kinds. Hero blockers are copies of a real hero in the world, because a blank hero
has a wounds pool of 0 and Crucible counts that as dead.

| Blocker | 4 ft mover, aligned | 4 ft mover, 1 ft overlap | 10 ft mover | Matches Crucible's code? |
|---|---|---|---|---|
| Hero the same player owns | stops at -1.95 | passes | aligned lane stops at -4.95; 1 ft lane passes | Yes. Allies block. |
| Another player's hero | stops at -1.95 | passes | not run | Yes |
| Neutral adversary | stops at -1.95 | passes | not run | Yes |
| Secret adversary | passes | passes | not run | Yes. Secret tokens never block players. |
| Hostile adversary not in the combat | stops at -1.95 | passes | not run | Yes. Only the mover has to be in combat. |
| Hostile 8 ft adversary | stops at -1.95 | passes | not run | Yes. The blocker's size is right. |
| Adversary set to 0 health by the GM | stops at -1.95 | passes | not run | Not tested. See below. |

Every kind that blocks follows the same centre-line rule as the plain token lanes. Disposition and ownership do not
change anything except Secret.

The "defeated" case did not test what it meant to. The GM's client reported the blocker as dead
(`system.isDead: true`), but the player's client saw it at health 24 and not dead (`blockerActor` in the rows). So the
health update never reached the player, and the blocker counted as alive. Crucible's `isBlocker` skips dead actors
(`module/canvas/movement-polygon.mjs:65`), so a real defeated creature should not block. This needs a better set-up
before it counts as a result.

The 10 ft other-actor run stopped after the first kind. The Confirm click hung behind a window, probably a
`crucible-reaction-prompts` prompt when the mover came alongside the player's own hero. The spec now closes framed
windows and tries the click again, with a 5 s limit.

### Move-confirm timing

The timing scenario (`PFM_SWEEP_OBSTACLES=none`) makes 5 ft moves with a 4 ft mover in the player's browser and
logs each event with a timestamp. One run, AP starts at 6:

| Step | What happened |
|---|---|
| First drop | Token moved at 0.7 s. The Move card arrived at 2.0 s, and the GM's held flag at 2.3 s. |
| Drop while the card is held | Rejected by move-confirm, which confirmed the card and showed "Drag again". By design. |
| Drop as soon as the client sees the card confirmed | Moved. |
| Drop 0 ms after clicking Confirm | Rejected with "Drag again". AP 6 to 5, spent once. |
| Drop 50 ms after Confirm | Moved. The confirmed flag had already arrived (68 ms round trip). |
| Drop 100 ms after Confirm | Rejected. The click spent 1 AP (4 to 3), then the rejected drag confirmed the same card again (3 to 2). |
| Drop 250 ms after Confirm | Rejected. Same double spend (2 to 1, then 1 to 0). The drop went out 640 ms after the click, and the confirmed flag arrived 11 ms after it. |
| Next drop | "insufficient action to move this distance which requires 1A!" |

So five 5 ft moves used all 6 AP and then the player could not move. Two of those AP were second confirms of a card
already confirmed. The risk window is the confirm round trip, which was 70 to 650 ms here and will be longer on a real
network. A player who clicks Confirm and starts the next drag straight away lands in it.

### Late Move cards in the sweep

The sweep waits 1.5 s after a token stops for its Move card. Some cards came later than that, more often for big
tokens (13 of 90 moves for 10 ft, 7 of 90 for 8 ft, 1 to 3 for smaller sizes). The sweep then did not click Confirm,
the card became held, and the next drag got "Your last move ... is now confirmed. Drag again". Those rows show as
"rejected" with that note. They are not collision results. They do show that a player who drags again shortly after a
move, before or without seeing the card, gets a rejected drag.

## Which cases should and should not work

| Case | Today | Should it? |
|---|---|---|
| Mover's footprint overlaps a wall by less than half its width | moves | No for a strict footprint rule, but this is core's centre-point design for walls. Leave it. |
| Mover's footprint overlaps a token, centre line outside it | moves through | No. Two creatures should not share space. |
| Mover's centre would enter a token's footprint | stops at the edge | Yes |
| Hidden token, player moving | passes | Yes, by the module's design |
| Unseen wall or token | ruler clear, drop stops | The stop is right. The clear ruler is not, but it is core behaviour, and showing it would leak hidden information. The fix is to tell the player why the move stopped. |
| Drag soon after Confirm | rejected, card may be confirmed twice | The drag should go through, and AP should be spent once. |

## Likely causes in the code

### Cause 1: centre point against footprint edges

- Core: `Token#constrainMovementPath` (core `client/canvas/placeables/token.mjs:2941`) tests each segment from
  `TokenDocument#getMovementOrigin` (lines 2969, 2986, 3007). The v14 docs describe `getMovementOrigin` as the point
  used to test collision with walls. It is the token's centre.
- Crucible: `CrucibleMovementPolygon#_identifyEdges` (`module/canvas/movement-polygon.mjs:38-44`) adds
  `#buildTokenEdges` (lines 53-96). For each blocker it takes `token.document.getGridSpacePolygon()` and adds one
  `Edge` of type `wall` per side. Those edges are the blocker's full footprint. Nothing grows them by the mover's
  size, so the mover's centre point is tested against the blocker's footprint.
- `isBlocker` (lines 63-77) skips the mover, dead actors, tokens mid-animation, other levels, the caller's
  `excludeTokenTest`, weaker blockers under forced movement, and Secret tokens for players.
- Token collision only applies when the mover is in combat (Crucible `module/canvas/token.mjs:415-417`).

### Cause 2: preview and drop use different collision sets

- Core `Token#constrainMovementPath` with `preview: true` only counts visible or explored collisions. The drop
  constrains again with `preview: false`. See the line references above.

### Cause 3: move-confirm double confirm and drag rejection

- The Confirm button handler calls `Action().confirmMessage(message)` and does not wait or record that a confirm is in
  progress (`scripts/move-confirm.mjs:66-69`). Disabling the button only stops a second click on that one button.
- `preMoveToken` rejects any drag while a held move is pending, and calls `confirmPending`
  (`scripts/move-confirm.mjs:74-79`). `confirmPending` confirms every pending card again (lines 22-24).
- A card counts as pending until its `confirmed` flag reaches the client (`scripts/lib/move-confirm.mjs:18`).
- Crucible's guard in `CrucibleAction.confirmMessage` (`module/models/action.mjs:3907-3909`) only checks the
  `confirmed` flag. The flag is written at the end of `confirm` (line 3023), after the events (AP spend) apply. So two
  calls inside that window both pass and both spend AP.
- `preMoveToken` cannot wait for a promise, so the module rejects the drag and asks the player to drag again
  (comment at `scripts/move-confirm.mjs:7`).

## Proposed fixes (not done yet)

### Fix A: one confirm per card (cause 3, highest value)

- Keep a module-level `Map` of message id to the in-flight confirm promise. The button, `confirmPending` and the
  `combatTurnChange` handler all go through it, so a card is confirmed once.
- `pendingMoves` skips cards that are in flight.
- In `preMoveToken`, if every pending card is already in flight, still reject (the AP check needs the earlier spend
  first), but after the confirm finishes, replay the drag with `TokenDocument#move(waypoints, options)` using the
  `TokenPreMovementOperation` passed to the hook (its `passed` and `pending` waypoints, `method: "dragging"`, and
  `constrainOptions`). Then the player does not need to drag again.
- APIs: `preMoveToken` hook, `TokenPreMovementOperation`, `TokenDocument#move` (v14: `move(waypoints, options):
  Promise<boolean>`, resolves `false` if stopped), `ChatMessage#getFlag`. The `preMoveToken` return value `false`
  rejects the movement; the v14 hook page documents this.
- Test: a Quench case that calls the button handler and `confirmPending` together on one held card and checks AP
  drops by one.

### Fix B: tell the player why a drop stopped short (cause 2)

- After a dragged move, compare the final position with the dropped destination. If it stopped short, show a
  notification such as "Something blocks the way". Do not reveal what.
- APIs: `moveToken` hook (or `preMoveToken` with the operation's `destination`), `ui.notifications`.

### Fix C: footprint collision for tokens (cause 1, optional)

- Wrap `CrucibleMovementPolygon.prototype._identifyEdges` (reached through `CONFIG.Canvas.polygonBackends.move`) and
  replace Crucible's token edges with each blocker's footprint grown by half the mover's width and height on every side
  (a Minkowski sum of two rectangles). The centre then stops exactly where the footprints meet. Keep Crucible's
  `isBlocker` rules, the `excludeTokenTest` used by `hidden-collision.mjs`, and the edge ids
  `crucible.tokencollision.<id>.<n>`.
- APIs: `foundry.canvas.geometry.edges.Edge`, `TokenDocument#getGridSpacePolygon`, `TokenDocument#getMovementOrigin`,
  `CONFIG.Canvas.polygonBackends.move`.
- Risks: it wraps a private Crucible method, so it can break when Crucible changes. Grown edges also block a mover
  that starts next to a creature from sliding along it, which is a rules change. Raise it with the Crucible authors
  first, since the system owns token collision.
- Walls: leave as they are. The half-width overlap is core's centre-point design, not a bug.

## Foundry API notes

Checked against the v14 docs:

- `TokenDocument#getMovementOrigin(data)`: "the point used to test collision with walls and surfaces".
- `TokenDocument#move(waypoints, options)`: returns `Promise<boolean>`.
- `TokenDocument#getGridSpacePolygon(data)`: returns `Point[]`, or nothing on gridless scenes.
- The `teleport` update option is deprecated since v13. The sweep uses waypoint action `displace` instead.
- `Game#togglePause(pause, {broadcast})` and `game.paused`: the sweep unpauses for the run and restores the old state.
