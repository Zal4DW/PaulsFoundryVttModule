// Compile the compendium packs from their JSON source.
//
// Source:  packs/_source/<pack>/*.json   (committed, one file per document)
// Output:  packs/<pack>/                 (LevelDB, gitignored, built for the dev server and for a release)
//
// Usage:   npm run build:packs
//
// Foundry locks a LevelDB pack while a world that uses it is running. Return to Setup (or stop the server)
// before you build, or the build fails with a lock error.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compilePack } from "@foundryvtt/foundryvtt-cli";

const root = new URL("../packs/", import.meta.url);
const packs = readdirSync(new URL("_source/", root), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

for (const pack of packs) {
  const src = new URL(`_source/${pack}`, root);
  const dest = new URL(pack, root);
  await compilePack(fileURLToPath(src), fileURLToPath(dest), { log: true });
}
console.log(`Built ${packs.length} pack(s): ${packs.join(", ")}`);
