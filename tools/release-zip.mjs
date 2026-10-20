// Build module.zip for a GitHub release: the module's tracked files plus the compiled compendium packs.
//
// The packs are LevelDB folders built from packs/_source and gitignored, so a plain git archive leaves them out.
// This script builds them, then archives the tracked module files at a ref and adds every built pack file.
// It refuses to run unless this checkout is at that ref with no uncommitted pack source changes.
//
// Usage:   npm run release:zip -- [ref]        (ref defaults to HEAD; use the release tag, such as v0.4.0)
// Output:  module.zip in the repo root
//
// Stop the dev server (or return to Setup) first: Foundry locks a pack while a world uses it.

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ref = process.argv[2] ?? "HEAD";

/** The files and folders that make up the module. Never secrets/, CLAUDE.md, tests or .foundry. */
const MODULE_PATHS = ["module.json", "README.md", "lang", "scripts", "styles", "assets"];

// The packs are built from the working tree but the rest comes from the ref, so they must be the same commit,
// with no uncommitted changes to the pack sources. Otherwise the zip's items would not match its scripts.
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD");
const target = git("rev-parse", `${ref}^{commit}`);
if (head !== target) {
  console.error(`Check out ${ref} (${target.slice(0, 7)}) first: this checkout is at ${head.slice(0, 7)}, and the packs are built from it.`);
  process.exit(1);
}
if (git("status", "--porcelain", "--", "packs/_source")) {
  console.error("packs/_source has uncommitted changes. Commit or discard them, so the built packs match the release.");
  process.exit(1);
}

execFileSync(process.execPath, ["tools/build-packs.mjs"], { cwd: root, stdio: "inherit" });

// Built pack files, as paths relative to the repo root with forward slashes.
const packFiles = readdirSync(new URL("../packs/", import.meta.url), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "_source")
  .flatMap((d) => readdirSync(new URL(`../packs/${d.name}/`, import.meta.url)).map((f) => `packs/${d.name}/${f}`))
  .filter((f) => !f.endsWith("/LOCK"));

// git archive applies the rightmost --prefix to the tracked files and each earlier --prefix to the --add-file entries
// after it, so each pack file gets its own folder and the tracked files stay at the root.
const addFiles = packFiles.flatMap((f) => [`--prefix=${f.slice(0, f.lastIndexOf("/") + 1)}`, `--add-file=${f}`]);
execFileSync("git", ["archive", "--format=zip", "-o", "module.zip", ...addFiles, "--prefix=", ref, ...MODULE_PATHS],
  { cwd: root, stdio: "inherit" });
console.log(`module.zip: ${ref} plus ${packFiles.length} built pack file(s)`);
