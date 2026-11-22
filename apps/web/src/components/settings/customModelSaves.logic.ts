import {
  type CustomModelDefinition,
  readCustomModelEntries,
  toCustomModelSetting,
} from "@t3tools/shared/model";

/** Replies match their save by `value` identity, so every save sends a fresh object. */
export interface PendingSave<Value extends object> {
  readonly value: Value;
  /** The value as the config stream will read it back once this save lands. */
  readonly key: string;
  /** The server accepted it; only its echo is outstanding. */
  readonly replied?: true;
  /** Another writer changed the list while this save was in flight, so its echo may never come. */
  readonly raced?: true;
}

export const customModelsKey = (models: ReadonlyArray<CustomModelDefinition>) =>
  JSON.stringify(readCustomModelEntries(models.map(toCustomModelSetting)));

/**
 * Saves land in order, so an echo settles its save and every one before. The latest match wins
 * because the stream can coalesce repeats, and a stale save would overwrite another writer later.
 * Any other change drops replied saves and marks in-flight ones raced.
 */
export function pendingSaves<Value extends object>(
  saves: ReadonlyArray<PendingSave<Value>>,
  storedKey: string,
): ReadonlyArray<PendingSave<Value>> {
  const echoed = saves.findLastIndex((entry) => entry.key === storedKey);
  if (echoed >= 0) return saves.slice(echoed + 1);
  return saves.flatMap((entry) => (entry.replied ? [] : [{ ...entry, raced: true as const }]));
}

/** A failed or raced save is dropped; a successful one waits for its echo. */
export function settleSave<Value extends object>(
  saves: ReadonlyArray<PendingSave<Value>>,
  sent: PendingSave<Value>,
  saved: boolean,
): ReadonlyArray<PendingSave<Value>> {
  return saves.flatMap((entry) =>
    entry.value !== sent.value
      ? [entry]
      : saved && !entry.raced
        ? [{ ...entry, replied: true as const }]
        : [],
  );
}
