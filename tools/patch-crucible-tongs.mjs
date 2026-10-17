// Patch Crucible Tongs 1.8.0 for Crucible 0.11.1, until the Tongs author ships a fix.
//
// Crucible 0.11.1 moved two config tables that Tongs still reads from the old place:
//   SYSTEM.SKILL.SKILLS                 -> SYSTEM.SKILLS
//   SYSTEM.TALENT.TRAINING_RANK_VALUES  -> SYSTEM.PROFICIENCY.RANK_VALUES
// Without the fix, the Tongs hero hotbar, skill tooltips and token action ring fail to render.
// These two fall back to the old path first, so they also work on older Crucible versions.
// It also removed the translation key ACTOR.TABS.skills, which Tongs uses as the hotbar's skills tab tooltip.
//
// Usage:   node tools/patch-crucible-tongs.mjs <Foundry Data folder>
// Example: node tools/patch-crucible-tongs.mjs ".foundry/data/Data"
//
// It keeps a .orig copy of each file it changes, and running it again changes nothing.
// A Tongs update replaces the files, so run it again after updating Tongs. Restart or reload Foundry afterwards.
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXES = [
  { from: /SYSTEM\.SKILL\.SKILLS/g, to: "(SYSTEM.SKILL?.SKILLS ?? SYSTEM.SKILLS)" },
  { from: /SYSTEM\.TALENT\.TRAINING_RANK_VALUES/g, to: "(SYSTEM.TALENT.TRAINING_RANK_VALUES ?? SYSTEM.PROFICIENCY.RANK_VALUES)" },
  // The hotbar's skills tab tooltip showed the raw key "ACTOR.TABS.skills". Crucible 0.11.1 has no such key;
  // its skills live on the "Proficiency" sheet tab. The label is read at load time, so there is no fallback.
  { from: /'ACTOR\.TABS\.skills'/g, to: "'ACTOR.TABS.proficiency'" }
];

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("Usage: node tools/patch-crucible-tongs.mjs <Foundry Data folder>");
  process.exit(1);
}

const moduleDir = join(dataDir, "modules", "crucibletongs");
const scriptsDir = join(moduleDir, "modules");
if (!existsSync(scriptsDir)) {
  console.error(`Crucible Tongs not found at ${moduleDir}`);
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(moduleDir, "module.json"), "utf8")).version;
console.log(`Crucible Tongs ${version} at ${moduleDir}`);

let changed = 0;
for (const name of readdirSync(scriptsDir).filter((f) => f.endsWith(".js"))) {
  const file = join(scriptsDir, name);
  // Hide already-patched expressions behind placeholders first, so a second run does not wrap them again.
  const placeholder = (i) => `@@PFM_TONGS_FIX_${i}@@`;
  let patched = FIXES.reduce((text, { to }, i) => text.split(to).join(placeholder(i)), readFileSync(file, "utf8"));
  let count = 0;
  for (const { from, to } of FIXES) {
    patched = patched.replace(from, () => {
      count++;
      return to;
    });
  }
  patched = FIXES.reduce((text, { to }, i) => text.split(placeholder(i)).join(to), patched);
  if (count === 0) continue;

  if (!existsSync(`${file}.orig`)) copyFileSync(file, `${file}.orig`);
  writeFileSync(file, patched);
  changed += count;
  console.log(`  patched ${name}: ${count} replacement(s)`);
}

console.log(changed ? `Done: ${changed} replacement(s). Reload Foundry.` : "Nothing to patch: already fixed or a newer Tongs.");
