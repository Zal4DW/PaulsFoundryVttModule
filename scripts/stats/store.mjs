// Stats storage: one world setting that every user can read and only a GM can write.
// Shape: { fights: { [fightId]: { id, name, scene, started, ended, meta: {key: {...}}, records: [...] } } }

export const STATS_SETTING = "statsLog";

export function registerStatsSettings(moduleId, onChange) {
  game.settings.register(moduleId, STATS_SETTING, {
    scope: "world",
    config: false,
    type: Object,
    default: { fights: {} },
    onChange
  });
}

export function readLog(moduleId) {
  const log = game.settings.get(moduleId, STATS_SETTING) ?? {};
  return { fights: log.fights ?? {} };
}

/** Fights, newest first. */
export function listFights(moduleId) {
  return Object.values(readLog(moduleId).fights).sort((a, b) => (b.started ?? 0) - (a.started ?? 0));
}

let pending = null;
let timer = null;

/**
 * Change the log and save it. Writes are batched, because one action can create and then update several messages.
 * @param {string} moduleId
 * @param {(log: object) => void} mutate
 */
export function updateLog(moduleId, mutate) {
  if (!game.user.isGM) return;
  pending ??= foundry.utils.deepClone(readLog(moduleId));
  mutate(pending);
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const log = pending;
    pending = null;
    await game.settings.set(moduleId, STATS_SETTING, log);
  }, 750);
}

/** Save now, without waiting for the batch timer (used before combat data disappears). */
export async function flushLog(moduleId) {
  if (!pending) return;
  clearTimeout(timer);
  const log = pending;
  pending = null;
  await game.settings.set(moduleId, STATS_SETTING, log);
}
