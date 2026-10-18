// Patch Ember Item Sync 0.0.1 so only the active GM writes token weapon layers, until the author ships a fix.
//
// Its syncToken() rewrites flags.ember.dynamicToken.layers on every client, on canvasReady, createToken,
// combat changes and equipment changes. A player who does not own the token gets
// "User <name> lacks permission to update Token [...]" from the server, once per token, every time
// Ember spawns NPCs (Begin Event on a vista) or a scene loads. The GM's own write still lands, so nothing
// looks wrong except the errors. The fix lets only the active GM write, which also stops every client
// sending the same update.
//
// Usage:   node tools/patch-ember-item-sync.mjs <Foundry Data folder>
// Example: node tools/patch-ember-item-sync.mjs ".foundry/data/Data"
//
// It keeps a .orig copy of the file it changes, and running it again changes nothing.
// An Ember Item Sync update replaces the file, so run it again after updating. Reload Foundry afterwards.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = "PFM patch: only the active GM writes";
const ANCHOR = "async function syncToken(tokenDoc) {";
const GUARD = `${ANCHOR}\n  if ( !game.users.activeGM?.isSelf ) return; // ${MARKER} (players lack permission on NPC tokens)`;

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("Usage: node tools/patch-ember-item-sync.mjs <Foundry Data folder>");
  process.exit(1);
}

const moduleDir = join(dataDir, "modules", "ember-item-sync");
const file = join(moduleDir, "scripts", "combat-weapon-sync.js");
if (!existsSync(file)) {
  console.error(`Ember Item Sync not found at ${moduleDir}`);
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(moduleDir, "module.json"), "utf8")).version;
console.log(`Ember Item Sync ${version} at ${moduleDir}`);

const text = readFileSync(file, "utf8");
if (text.includes(MARKER)) {
  console.log("Nothing to patch: already patched.");
} else if (!text.includes(ANCHOR)) {
  console.log("Nothing to patch: syncToken has changed, so this version may already be fixed. Check it by hand.");
} else if (/async function syncToken\(tokenDoc\) \{\s*if \( ?!game\.users\.activeGM/.test(text)) {
  console.log("Nothing to patch: this version already has an active-GM check.");
} else {
  if (!existsSync(`${file}.orig`)) copyFileSync(file, `${file}.orig`);
  writeFileSync(file, text.replace(ANCHOR, GUARD));
  console.log("  patched combat-weapon-sync.js: syncToken now runs on the active GM only.");
  console.log("Done. Reload Foundry.");
}
