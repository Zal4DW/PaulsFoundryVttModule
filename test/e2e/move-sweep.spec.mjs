// Token movement sweep: when does a player's drag stop short of where they dropped it?
//
// Opt-in, because it takes several minutes and changes the world while it runs:
//   PFM_MOVE_SWEEP=1 npx playwright test test/e2e/move-sweep.spec.mjs
// Narrow it with PFM_SWEEP_SIZES=4,10 and PFM_SWEEP_OBSTACLES=wall,token,hidden,dark (or actors, or none).
// PFM_SWEEP_TIMING=0 skips the Confirm timing scenario. Take the shared server lock first (docs/movement-collision.md).
//
// The GM joins in one browser and builds a throwaway microgrid scene, actors, a combat and a player user. The player
// joins in a second browser with "Confirm my own movement" on, drops a token towards a wall or a blocking token in
// steps that get closer each time, and clicks the module's Confirm button on each Move card. Headless Foundry runs at
// about 3 FPS, too slow for a real mouse drag, so the drop sends the same update core's drag-drop sends.
// Each move records the planned and final positions, the token's centre and bounds, and what Foundry's preview
// constraint (the ruler), the real constraint (the drop) and Crucible's collision test said.
// Results go to sweep-results/, and each move is also logged as a "row" line. The GM deletes what it created.
// The findings are in docs/movement-collision.md.
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { allows, laneOffsets, outcome, stopGap, targetGaps } from "./move-sweep-model.mjs";

const MODULE_ID = "pauls-foundry-module";
const GM = process.env.FOUNDRY_USER ?? "Gamemaster";
const GM_PASSWORD = process.env.FOUNDRY_USER_PASSWORD ?? "";
const PLAYER = "PFM Sweep Player";
const PREFIX = "PFM Sweep";
const SIZES = (process.env.PFM_SWEEP_SIZES ?? "2,4,5,8,10").split(",").map(Number);
const OBSTACLES = (process.env.PFM_SWEEP_OBSTACLES ?? "wall,token,hidden,dark").split(",");
// Not under test-results/: Playwright empties that folder at the start of every run.
const OUT = `sweep-results/${process.env.PFM_SWEEP_SIZES ?? "all"}-${process.env.PFM_SWEEP_OBSTACLES ?? "all"}`;

// Scene layout, in feet (one microgrid cell each). The obstacle's left face is at OBSTACLE_X.
const BLOCKER_SIZE = 4;
const OBSTACLE_X = 80;
const OBSTACLE_Y = 40;
const START_GAP = 6;

test.skip(!process.env.PFM_MOVE_SWEEP, "Set PFM_MOVE_SWEEP=1 to run the movement sweep.");
// One size with every obstacle takes about 5 minutes. Run sizes one at a time so a hang never holds the server long.
test.setTimeout(20 * 60_000);

async function join(page, user, password = "") {
  await page.goto("/join");
  const select = page.getByRole("combobox", { name: "Select User" });
  if (await select.getByRole("option", { name: user }).isDisabled()) {
    throw new Error(`User "${user}" is already connected in another browser.`);
  }
  await select.selectOption({ label: user });
  if (password) await page.getByRole("textbox", { name: "User Password" }).fill(password);
  await page.getByRole("button", { name: "Join Game Session" }).click();
  await page.waitForURL("**/game");
  await page.waitForFunction(() => globalThis.game?.ready === true && canvas.ready, null, { timeout: 45_000 });
}

// Other kinds of blocking token, for PFM_SWEEP_OBSTACLES=actors. Crucible's isBlocker
// (module/canvas/movement-polygon.mjs) skips dead actors, Secret tokens for players, and tokens on another level, but
// checks nothing about disposition, ownership or combat for the blocker itself.
const ALL_BLOCKER_KINDS = [
  { key: "ownHero", label: "a hero the same player owns", type: "hero", disposition: "FRIENDLY", owned: true },
  { key: "otherHero", label: "another player's hero", type: "hero", disposition: "FRIENDLY" },
  { key: "neutral", label: "a neutral adversary", disposition: "NEUTRAL" },
  { key: "secret", label: "a Secret-disposition adversary", disposition: "SECRET" },
  { key: "bystander", label: "a hostile adversary not in the combat", combat: false },
  { key: "defeated", label: "a hostile adversary at 0 health", defeated: true },
  { key: "large", label: "a hostile 8 ft adversary", size: 8 }
];
// PFM_SWEEP_KINDS=defeated,secret runs only those kinds of blocker.
const BLOCKER_KINDS = ALL_BLOCKER_KINDS.filter((k) => !process.env.PFM_SWEEP_KINDS || process.env.PFM_SWEEP_KINDS.split(",").includes(k.key));

/** Every case for one mover size: the obstacle, the lane and a label. */
function casesFor(size, setup) {
  const cases = [];
  if (OBSTACLES.includes("wall")) cases.push({ obstacle: "wall", variant: "wall", dy: 0, lane: "wall spans the lane" });
  const lanes = laneOffsets(size, BLOCKER_SIZE);
  if (OBSTACLES.includes("token")) {
    for (const l of lanes) cases.push({ obstacle: "token", variant: "token", dy: l.dy, lane: l.label });
  }
  const aligned = lanes.at(-1);
  const inside = lanes.find((l) => l.label.startsWith("centre 1 ft"));
  if (OBSTACLES.includes("hidden")) {
    for (const l of [aligned, inside]) cases.push({ obstacle: "token", variant: "hidden", dy: l.dy, lane: l.label });
  }
  if (OBSTACLES.includes("dark")) {
    cases.push({ obstacle: "token", variant: "dark", dy: aligned.dy, lane: aligned.label });
    cases.push({ obstacle: "wall", variant: "dark-wall", dy: 0, lane: "wall spans the lane" });
  }
  if (OBSTACLES.includes("actors")) {
    for (const kind of BLOCKER_KINDS) {
      const blockerId = setup.blockers[kind.key];
      const blockerSize = setup.sizes[blockerId];
      const kindLanes = laneOffsets(size, blockerSize);
      const picks = [kindLanes.at(-1), kindLanes.find((l) => l.label.startsWith("1 ft"))];
      for (const l of picks) {
        cases.push({ obstacle: "token", variant: kind.key, kind: kind.label, blockerId, blockerSize, dy: l.dy, lane: l.label });
      }
    }
  }
  return cases;
}

test("token movement collision sweep", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const gmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const playerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const gm = await gmContext.newPage();
  const player = await playerContext.newPage();
  const rows = [];
  let setup = null;
  let wroteResults = false;

  try {
    await join(gm, GM, GM_PASSWORD);

    // GM: player user, scene, actors, tokens and combat.
    setup = await gm.evaluate(async ({ PLAYER, PREFIX, SIZES, BLOCKER_SIZE, KINDS }) => {
      const { Combat, Scene, User } = globalThis;
      // The GM's set-up moves use the "displace" action: no wall or token collision, and no Move card.
      globalThis.pfmSweepDisplace = (scene, updates) => scene.updateEmbeddedDocuments("Token", updates, {
        animate: false,
        movement: Object.fromEntries(updates.filter((u) => "x" in u).map((u) => [u._id,
          { waypoints: [{ x: u.x, y: u.y, action: "displace" }], method: "config" }]))
      });
      // Remove anything a killed run left behind. Such a run also left its scene active and the game unpaused.
      const ours = (d) => d.name?.startsWith(PREFIX);
      const leftover = game.scenes.some(ours);
      for (const c of game.combats.filter((c) => ours(c.scene ?? {}))) await c.delete();
      const priorScene = (game.scenes.active && !ours(game.scenes.active)) ? game.scenes.active.id
        : (game.scenes.find((s) => !ours(s) && s.name !== "Foundry Virtual Tabletop")?.id ?? null);
      if (priorScene && leftover) await game.scenes.get(priorScene).activate();
      await Scene.implementation.deleteDocuments(game.scenes.filter(ours).map((s) => s.id));
      await Actor.implementation.deleteDocuments(game.actors.filter(ours).map((a) => a.id));
      // Players cannot move tokens while the game is paused, and the test world starts paused.
      const priorPaused = leftover ? true : game.paused;
      game.togglePause(false, { broadcast: true });
      let user = game.users.getName(PLAYER);
      user ??= await User.implementation.create({ name: PLAYER, role: CONST.USER_ROLES.PLAYER });
      // 5 ft squares of 100 px: Crucible turns this into a 1 ft microgrid of 20 px.
      const scene = await Scene.implementation.create({
        name: `${PREFIX} Scene`, width: 3200, height: 1600, padding: 0,
        grid: { type: CONST.GRID_TYPES.SQUARE, size: 100, distance: 5, units: "ft" },
        tokenVision: true, fog: { mode: CONST.FOG_EXPLORATION_MODES.DISABLED },
        environment: { globalLight: { enabled: true } }
      });
      await scene.activate();
      const owner = { default: 0, [user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };
      const actorData = SIZES.map((size) => ({
        name: `${PREFIX} Mover ${size}ft`, type: "adversary", ownership: owner,
        system: { movement: { sizeBonus: size - 4 } }
      }));
      actorData.push({ name: `${PREFIX} Blocker`, type: "adversary", system: { movement: { sizeBonus: BLOCKER_SIZE - 4 } } });
      const kinds = KINDS ?? [];
      // A blank hero has a wounds pool of 0, and Crucible counts wounds.value === wounds.max as dead.
      // So hero blockers start from a copy of a real hero in the world, with no wounds.
      const template = game.actors.find((a) => a.type === "hero" && !a.name.startsWith(PREFIX)
        && a.system.resources.wounds.max > 0)?.toObject();
      for (const k of kinds) {
        const base = k.type === "hero" && template ? foundry.utils.deepClone(template) : {};
        delete base._id;
        delete base.folder;
        actorData.push(foundry.utils.mergeObject(base, {
          name: `${PREFIX} Blocker ${k.key}`, type: k.type ?? "adversary", prototypeToken: { name: `${PREFIX} Blocker ${k.key}` },
          ownership: k.owned ? owner : { default: 0 },
          system: { movement: { sizeBonus: (k.size ?? BLOCKER_SIZE) - 4 }, resources: { wounds: { value: 0 } } } }));
      }
      const actors = await Actor.implementation.createDocuments(actorData);
      const kindOf = (a) => kinds.find((k) => a.name === `${PREFIX} Blocker ${k.key}`);
      const tokenData = await Promise.all(actors.map((a, i) => a.getTokenDocument({
        x: 100 + ((i % 15) * 200), y: 1400 - (Math.floor(i / 15) * 200),
        disposition: CONST.TOKEN_DISPOSITIONS[kindOf(a)?.disposition ?? "HOSTILE"],
        sight: { enabled: true, range: 60 }
      })));
      const tokens = await scene.createEmbeddedDocuments("Token", tokenData.map((t) => t.toObject()));
      const combat = await Combat.implementation.create({ scene: scene.id, active: true });
      const fighting = tokens.filter((t) => kindOf(t.actor)?.combat !== false);
      await combat.createEmbeddedDocuments("Combatant", fighting.map((t) => ({ tokenId: t.id, sceneId: scene.id, actorId: t.actorId })));
      await combat.update({ round: 1, turn: 0 });
      // A defeated blocker: health 0 on the token's own actor. Crucible's isBlocker skips actors whose isDead is true.
      for (const t of tokens.filter((t) => kindOf(t.actor)?.defeated)) {
        await t.actor.update({ "system.resources.health.value": 0 });
      }
      // Match tokens to actors by id: createEmbeddedDocuments does not keep the order of its input.
      const tokenOf = (actor) => tokens.find((t) => t.actorId === actor.id).id;
      // Look actors up by name: createDocuments does not keep the order of its input either.
      const actorNamed = (name) => actors.find((a) => a.name === name);
      const moverActor = (size) => actorNamed(`${PREFIX} Mover ${size}ft`);
      const ids = Object.fromEntries(SIZES.map((size) => [size, tokenOf(moverActor(size))]));
      const moverActors = Object.fromEntries(SIZES.map((size) => [size, moverActor(size).id]));
      return {
        priorScene, priorPaused, userId: user.id, sceneId: scene.id, combatId: combat.id,
        actorIds: actors.map((a) => a.id), moverActors, movers: ids, blocker: tokenOf(actorNamed(`${PREFIX} Blocker`)),
        sizes: Object.fromEntries(tokens.map((t) => [t.id, t.width])),
        blockers: Object.fromEntries(kinds.map((k) => [k.key, tokenOf(actorNamed(`${PREFIX} Blocker ${k.key}`))])),
        dead: Object.fromEntries(tokens.map((t) => [t.name, t.actor.system.isDead])), autoConfirm: game.settings.get("crucible", "autoConfirm"),
        backend: CONFIG.Canvas.polygonBackends.move.name, version: game.version, crucible: game.system.version
      };
    }, { PLAYER, PREFIX, SIZES, BLOCKER_SIZE, KINDS: OBSTACLES.includes("actors") ? BLOCKER_KINDS : null });
    console.log("setup", JSON.stringify(setup));
    // Only the defeated kind may be dead: Crucible never treats a dead actor as a blocker.
    const deadNames = Object.entries(setup.dead).filter(([, d]) => d).map(([n]) => n);
    expect(deadNames.filter((n) => !n.endsWith("defeated")), "a dead blocker never collides").toEqual([]);

    await join(player, PLAYER);
    await player.evaluate(async (id) => {
      await game.settings.set(id, "confirmOwnMoves", true);
      for (const app of [...foundry.applications.instances.values()].filter((a) => a.hasFrame && a.rendered)) await app.close();
      ui.sidebar.changeTab("chat", "primary");
      ui.sidebar.expand();
      canvas.tokens.activate();

      // A drop as core's Token drag workflow makes it. Mouse drags do not work here: headless Chromium draws Foundry
      // at about 3 FPS with software WebGL, and the PIXI drag never starts. During a drag, core finds the path with
      // findMovementPath(preview: true), which is the ruler the player sees. On drop, Token#_prepareDragLeftDropUpdates
      // sends that path minus its origin as a "dragging" movement with _getDragLeftDropUpdateOptions(). Then
      // TokenDocument#_preUpdate constrains it again with preview: false, preMoveToken fires, and Crucible makes the
      // Move card. Everything after the drop is the real code path.
      // Keep every notification the player sees, so a rejected drop shows its reason.
      globalThis.pfmSweepNotes = [];
      const notify = ui.notifications.notify.bind(ui.notifications);
      ui.notifications.notify = (message, type, options) => {
        globalThis.pfmSweepNotes.push(`${type}: ${message}`);
        return notify(message, type, options);
      };

      globalThis.pfmSweepDrop = (id, x, y) => {
        const token = canvas.tokens.get(id);
        const s = token.document._source;
        const origin = { x: s.x, y: s.y, elevation: s.elevation, width: s.width, height: s.height, depth: s.depth,
          shape: s.shape, level: s.level, action: token.document.movementAction };
        const options = token._getDragLeftDropUpdateOptions();
        const found = token.findMovementPath([origin, { x, y }], { ...options, preview: true }).result;
        const waypoints = found.slice(1);
        if (!waypoints.length) return { sent: false };
        globalThis.pfmSweepMove = canvas.scene.updateEmbeddedDocuments("Token", [{ _id: id }],
          { ...options, method: "dragging", movement: { [id]: { waypoints, planned: false } } });
        return { sent: true, ruler: { x: waypoints.at(-1).x / canvas.grid.size, y: waypoints.at(-1).y / canvas.grid.size } };
      };
    }, MODULE_ID);

    for (const size of SIZES) {
      const moverId = setup.movers[size];
      const actualSize = setup.sizes[moverId];
      for (const c of casesFor(size, setup)) {
        // GM: place the mover at the start of its lane and set up the obstacle for this case.
        await gm.evaluate(async ({ setup, moverId, c, size, OBSTACLE_X, OBSTACLE_Y, START_GAP }) => {
          const scene = game.scenes.get(setup.sceneId);
          const g = scene.grid.size;
          await scene.deleteEmbeddedDocuments("Wall", scene.walls.map((w) => w.id));
          const dark = c.variant.startsWith("dark");
          await scene.update({ "environment.globalLight.enabled": !dark });
          const park = (id, i) => ({ _id: id, x: 100 + (i * 200), y: 1400, hidden: false });
          const updates = Object.values(setup.movers).filter((id) => id !== moverId).map(park);
          updates.push({ _id: moverId, x: (OBSTACLE_X - START_GAP - size) * g, y: (OBSTACLE_Y + c.dy) * g,
            sight: { enabled: true, range: dark ? 0 : 60 } });
          // The case's blocker goes at the obstacle; every other blocker is parked out of the way.
          const active = c.obstacle === "token" ? (c.blockerId ?? setup.blocker) : null;
          for (const [i, id] of [setup.blocker, ...Object.values(setup.blockers)].entries()) {
            if (id === active) {
              updates.push({ _id: id, x: OBSTACLE_X * g, y: OBSTACLE_Y * g, hidden: c.variant === "hidden" });
            } else {
              updates.push({ _id: id, x: 100 + (i * 200), y: 1000, hidden: false });
            }
          }
          if (c.obstacle === "wall") {
            await scene.createEmbeddedDocuments("Wall", [{ c: [OBSTACLE_X * g, 0, OBSTACLE_X * g, scene.height],
              move: CONST.WALL_MOVEMENT_TYPES.NORMAL, sight: CONST.WALL_SENSE_TYPES.NORMAL }]);
          }
          await globalThis.pfmSweepDisplace(scene, updates);
        }, { setup, moverId, c, size, OBSTACLE_X, OBSTACLE_Y, START_GAP });

        await player.waitForFunction(({ moverId, x }) => {
          const t = canvas.tokens.get(moverId);
          return t && t.document.x === x && !t.movementAnimationPromise;
        }, { moverId, x: (OBSTACLE_X - START_GAP - size) * 20 }, { timeout: 15_000 });
        await player.evaluate(({ x, y }) => canvas.pan({ x: x * 20, y: y * 20, scale: 1 }), { x: OBSTACLE_X - 2, y: OBSTACLE_Y + 2 });
        await player.waitForTimeout(300);

        const limits = stopGap({ obstacle: c.obstacle, size: actualSize, dy: c.dy, blockerSize: c.blockerSize ?? BLOCKER_SIZE });
        for (const gap of targetGaps(actualSize)) {
          // The movers are unlinked tokens, so AP lives on the token's own actor, not the sidebar actor. It caps at 6.
          await gm.evaluate(({ sceneId, moverId }) => game.scenes.get(sceneId).tokens.get(moverId).actor
            .update({ "system.resources.action.value": 99 }), { sceneId: setup.sceneId, moverId });

          const target = { x: OBSTACLE_X - gap - actualSize, y: OBSTACLE_Y + c.dy };
          const before = await player.evaluate(({ moverId, blockerId, target }) => {
            const token = canvas.tokens.get(moverId);
            const doc = token.document;
            const g = canvas.grid.size;
            const ft = (v) => Math.round((v / g) * 100) / 100;
            const origin = { x: doc.x, y: doc.y, elevation: doc.elevation };
            const dest = { x: target.x * g, y: target.y * g, elevation: doc.elevation };
            const last = ([path, constrained]) => ({ x: ft(path.at(-1).x), y: ft(path.at(-1).y), constrained });
            const preview = last(token.constrainMovementPath([origin, dest], { preview: true }));
            const real = last(token.constrainMovementPath([origin, dest], { preview: false }));
            const level = doc.parent.levels.get(doc._source.level) ?? doc.parent.firstLevel;
            const from = doc.getMovementOrigin(origin);
            const to = doc.getMovementOrigin(dest);
            const hit = CONFIG.Canvas.polygonBackends.move.testCollision(from, to,
              { type: "move", mode: "closest", level, excludeToken: token, tokenCollision: token.inCombat });
            const blocker = canvas.tokens.get(blockerId);
            const centre = token.center;
            return {
              origin: { x: ft(doc.x), y: ft(doc.y) },
              centre: { x: ft(centre.x), y: ft(centre.y) },
              bounds: { x: ft(token.bounds.x), y: ft(token.bounds.y), w: ft(token.bounds.width), h: ft(token.bounds.height) },
              preview, real,
              centreHit: hit ? { x: ft(hit.x), y: ft(hit.y) } : null,
              inCombat: token.inCombat,
              blockerVisible: blocker?.visible ?? null,
              // What this client knows about the blocker: Crucible skips a blocker whose actor is missing or dead.
              blockerActor: blocker ? { present: !!blocker.actor, dead: blocker.actor?.system.isDead ?? null,
                health: blocker.actor?.system.resources?.health?.value ?? null } : null,
              messages: game.messages.size,
              heldWaiting: game.messages.filter((m) => m.flags?.crucible?.actor === token.actor.uuid
                && m.flags?.["pauls-foundry-module"]?.heldForPlayer && !m.flags?.crucible?.confirmed).length,
              stale: globalThis.pfmSweepNotes.splice(0)
            };
          }, { moverId, blockerId: c.blockerId ?? setup.blocker, target });

          if (before.origin.x === target.x && before.origin.y === target.y) continue;

          // Crucible's welcome journal and other pop-ups open late and would swallow the drag.
          await player.evaluate(async () => {
            const open = [...foundry.applications.instances.values()].filter((a) => a.hasFrame && a.rendered);
            await Promise.all(open.map((a) => a.close()));
          });
          const started = Date.now();
          const drop = await player.evaluate(({ moverId, x, y }) => globalThis.pfmSweepDrop(moverId, x, y),
            { moverId, x: target.x * 20, y: target.y * 20 });
          if (process.env.PFM_SWEEP_DEBUG) await player.screenshot({ path: `${OUT}/${actualSize}-${c.variant}-${c.dy}-${gap}.png` });

          // Wait for the move to settle and for its Move card, if there is one.
          const after = await player.waitForFunction(({ moverId, count }) => {
            const token = canvas.tokens.get(moverId);
            if (token.movementAnimationPromise) return null;
            const state = token.document.movement?.state;
            if (state === "pending") return null;
            const card = game.messages.contents.slice(count).findLast((m) => m.flags?.crucible?.action?.id === "move");
            const now = Date.now();
            globalThis.__sweepSettled ??= now;
            if (!card && now - globalThis.__sweepSettled < 1500) return null;
            delete globalThis.__sweepSettled;
            return { x: token.document.x / canvas.grid.size, y: token.document.y / canvas.grid.size,
              state, cardId: card?.id ?? null, held: !!card?.flags?.["pauls-foundry-module"]?.heldForPlayer,
              confirmed: !!card?.flags?.crucible?.confirmed, notes: globalThis.pfmSweepNotes.splice(0) };
          }, { moverId, count: before.messages }, { timeout: 15_000, polling: 100 }).then((h) => h.jsonValue());

          // Give the GM's client time to mark the card as held, then confirm it with the module's button.
          let confirm = { clicked: false, x: after.x, y: after.y };
          if (after.cardId) {
            const button = player.locator(`#chat [data-message-id="${after.cardId}"] button.pfm-confirm-move`).first();
            try {
              await button.waitFor({ state: "visible", timeout: 3000 });
              // A reaction prompt (crucible-reaction-prompts) can open over the chat when the mover comes alongside one
              // of the player's own heroes. Close any framed window and try the click once more.
              await button.click({ timeout: 5000 }).catch(async () => {
                await player.evaluate(() => Promise.all([...foundry.applications.instances.values()]
                  .filter((a) => a.hasFrame && a.rendered).map((a) => a.close())));
                await button.click({ timeout: 5000 });
              });
              confirm = await player.waitForFunction(({ id, moverId }) => {
                const m = game.messages.get(id);
                if (!m?.flags?.crucible?.confirmed) return null;
                const t = canvas.tokens.get(moverId);
                if (t.movementAnimationPromise) return null;
                return { clicked: true, x: t.document.x / canvas.grid.size, y: t.document.y / canvas.grid.size };
              }, { id: after.cardId, moverId }, { timeout: 10_000 }).then((h) => h.jsonValue());
            } catch (err) {
              confirm.error = String(err).split("\n")[0];
            }
          }

          const row = {
            size: actualSize, variant: c.variant, obstacle: c.obstacle, dy: c.dy, lane: c.lane, gap,
            planned: target, ...before, final: { x: after.x, y: after.y }, state: after.state,
            card: !!after.cardId, held: after.held, notes: after.notes, confirm, drop, ms: Date.now() - started,
            outcome: outcome({ planned: target, origin: before.origin, final: { x: after.x, y: after.y } }),
            footprintAllows: allows(limits.footprint, gap), centreAllows: allows(limits.centre, gap, { touchBlocks: true }),
            finalGap: OBSTACLE_X - (after.x + actualSize)
          };
          delete row.messages;
          rows.push(row);
          // The whole row goes to the console too, so the log alone is a complete record of the run.
          console.log("row", JSON.stringify(row));
        }
      }
    }

    // The module's own block: drag again while a held Move card waits for its Confirm. PFM_SWEEP_TIMING=0 skips it.
    const size = SIZES.includes(4) ? 4 : SIZES[0];
    const moverId = setup.movers[size];
    const pending = process.env.PFM_SWEEP_TIMING === "0" ? [] : await (async () => {
      await gm.evaluate(async ({ setup, moverId }) => {
        const scene = game.scenes.get(setup.sceneId);
        await scene.deleteEmbeddedDocuments("Wall", scene.walls.map((w) => w.id));
        await scene.update({ "environment.globalLight.enabled": true });
        await globalThis.pfmSweepDisplace(scene, [{ _id: moverId, x: 1000, y: 200 }, { _id: setup.blocker, x: 3000, y: 1400 }]);
      }, { setup, moverId });
      await player.waitForFunction((id) => canvas.tokens.get(id)?.document.x === 1000, moverId, { timeout: 15_000 });
      await player.evaluate(() => canvas.pan({ x: 1200, y: 300, scale: 1 }));
      await player.waitForTimeout(300);
      await gm.evaluate(({ sceneId, moverId }) => game.scenes.get(sceneId).tokens.get(moverId).actor
        .update({ "system.resources.action.value": 99 }), { sceneId: setup.sceneId, moverId });

      // Runs in the player's page, with timestamps, so the round trips to the GM's client show up.
      return player.evaluate(async ({ moverId, MODULE_ID }) => {
        const token = canvas.tokens.get(moverId);
        const doc = token.document;
        const actor = token.actor;
        const t0 = performance.now();
        const log = [];
        const at = () => Math.round(performance.now() - t0);
        const ft = () => doc.x / canvas.grid.size;
        const ap = () => actor.system.resources.action.value;
        const note = (event, extra = {}) => log.push({ t: at(), event, x: ft(), ap: ap(), ...extra });
        const isMine = (m) => m.flags?.crucible?.actor === actor.uuid && m.flags?.crucible?.action?.id === "move";
        const cardState = (m) => ({ id: m.id, held: !!m.flags?.[MODULE_ID]?.heldForPlayer, confirmed: !!m.flags?.crucible?.confirmed });
        const hooks = [
          ["createChatMessage", (m) => isMine(m) && note("card created", cardState(m))],
          ["updateChatMessage", (m) => isMine(m) && note("card updated", cardState(m))],
          ["updateToken", (d, change) => d === doc && ("x" in change) && note("token moved")]
        ].map(([name, fn]) => [name, Hooks.on(name, fn)]);
        const notify = ui.notifications.notify.bind(ui.notifications);
        ui.notifications.notify = (message, type, options) => {
          note("notification", { message: String(message), type });
          return notify(message, type, options);
        };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const until = async (test, ms = 10_000) => {
          const end = performance.now() + ms;
          while (performance.now() < end) {
            const v = test();
            if (v) return v;
            await sleep(50);
          }
          return null;
        };
        const newest = () => game.messages.contents.findLast(isMine);
        const heldCard = () => {
          const m = newest();
          return m && cardState(m).held && !cardState(m).confirmed ? m : null;
        };
        const drop = (label) => {
          const before = ft();
          const r = globalThis.pfmSweepDrop(moverId, doc.x + 100, doc.y);
          note(`drop: ${label}`, { sent: r.sent, from: before });
        };
        const clickConfirm = (m) => {
          const button = document.querySelector(`#chat [data-message-id="${m.id}"] button.pfm-confirm-move`);
          note("click Confirm", { found: !!button });
          button?.click();
        };
        const settle = () => sleep(2500);

        try {
          note("start");
          // 1. A move, then a second drag while its card is held. The module rejects the second drag on purpose.
          drop("first");
          note("held flag seen", { ok: !!(await until(heldCard)) });
          drop("second, while the first is held");
          await settle();
          // 2. Drag again as soon as this client sees the card confirmed.
          await until(() => newest() && cardState(newest()).confirmed);
          note("confirmed seen");
          drop("third, right after the confirmation arrives");
          await settle();
          // 3. Click Confirm, then drag after 0, 250, 1000 and 3000 ms.
          for (const delay of [0, 50, 100, 250, 1000]) {
            // A rejected drop leaves no new held card, so make a fresh move first when needed.
            if (!heldCard()) {
              drop("set-up move");
              await until(heldCard);
            }
            const card = heldCard();
            note("held flag seen", { ok: !!card });
            if (!card) break;
            const from = ft();
            clickConfirm(card);
            await sleep(delay);
            drop(`${delay} ms after Confirm`);
            await settle();
            note(`result: ${delay} ms after Confirm`, { moved: ft() !== from, cardConfirmed: cardState(game.messages.get(card.id)).confirmed });
          }
          await sleep(1500);
          note("end", { cards: game.messages.filter(isMine).map(cardState) });
        } finally {
          for (const [name, id] of hooks) Hooks.off(name, id);
          ui.notifications.notify = notify;
        }
        return log;
      }, { moverId, MODULE_ID });
    })();
    for (const line of pending) console.log("pending", JSON.stringify(line));

    writeFileSync(`${OUT}/results.json`, JSON.stringify({ setup, rows, pending }, null, 2));
    wroteResults = true;
    writeFileSync(`${OUT}/results.md`, toMarkdown(rows));
  } finally {
    // A run that failed part way still saves the rows it has. A full run already wrote them with the timing log.
    if (rows.length && !wroteResults) writeFileSync(`${OUT}/results.json`, JSON.stringify({ setup, rows }, null, 2));
    await player.evaluate(() => game.logOut?.()).catch(() => {});
    await playerContext.close();
    if (setup) {
      await gm.evaluate(async ({ setup }) => {
        await game.combats.get(setup.combatId)?.delete();
        await game.scenes.get(setup.sceneId)?.delete();
        await Actor.implementation.deleteDocuments(setup.actorIds.filter((id) => game.actors.has(id)));
        const cards = game.messages.filter((m) => setup.actorIds.some((id) => m.speaker?.actor === id)).map((m) => m.id);
        if (cards.length) await ChatMessage.implementation.deleteDocuments(cards);
        await game.users.get(setup.userId)?.delete();
        if (setup.priorScene) await game.scenes.get(setup.priorScene)?.activate();
        game.togglePause(setup.priorPaused, { broadcast: true });
      }, { setup }).catch((err) => console.error("cleanup failed", err));
    }
    await gm.evaluate(() => game.logOut?.()).catch(() => {});
    await gmContext.close();
  }
});

function toMarkdown(rows) {
  const head = "| Size | Obstacle | Lane dy | Plan gap | Footprint says | Centre says | Ruler (preview) | Drop (real) | Outcome | Final gap | Confirm |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|";
  const yesNo = (b) => (b ? "move" : "stop");
  const gapOf = (p, r) => OBSTACLE_X - (p.x + r.size);
  const lines = rows.map((r) => `| ${r.size} | ${r.variant} | ${r.dy} | ${r.gap} | ${yesNo(r.footprintAllows)} | ${yesNo(r.centreAllows)} | `
    + `${r.preview.constrained ? `stop at ${gapOf(r.preview, r)}` : "clear"} | ${r.real.constrained ? `stop at ${gapOf(r.real, r)}` : "clear"} | `
    + `${r.outcome} | ${r.finalGap} | ${r.confirm.clicked ? "ok" : (r.card ? (r.confirm.error ?? "no") : "no card")} |`);
  return [head, sep, ...lines].join("\n") + "\n";
}
