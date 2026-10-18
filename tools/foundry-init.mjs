// Create the Foundry data folders on the host before `docker compose up`.
// If Docker creates them instead (as mount points for the module bind mounts), they are
// root-owned with mode 755, and Foundry, which runs as uid 1000, fails with EACCES on
// mkdir '/data/Data/systems'. Folders created from Windows come through as writable.
// On Linux and macOS the folders belong to the host user, who may not be uid 1000,
// so they also get mode 777. The folder is local dev data only and is gitignored.
import { chmodSync, mkdirSync } from "node:fs";

const dirs = [
  ".foundry/data/Data/modules/pauls-foundry-module",
  ".foundry/data/Data/systems",
  ".foundry/data/Data/worlds"
];

for (const dir of dirs) mkdirSync(dir, { recursive: true });

if (process.platform !== "win32") {
  const writable = new Set([".foundry/data", ".foundry/data/Data", ".foundry/data/Data/modules", ...dirs]);
  for (const dir of writable) chmodSync(dir, 0o777);
}
