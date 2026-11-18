import {
  type CustomModelDefinition,
  readCustomModelEntries,
  toCustomModelSetting,
} from "@t3tools/shared/model";

export interface CustomModelSave {
  readonly models: ReadonlyArray<CustomModelDefinition>;
  /** The models as the config stream will read them back once this save lands. */
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
export function pendingCustomModelSaves(
  saves: ReadonlyArray<CustomModelSave>,
  storedKey: string,
): ReadonlyArray<CustomModelSave> {
  const echoed = saves.findLastIndex((entry) => entry.key === storedKey);
  if (echoed >= 0) return saves.slice(echoed + 1);
  return saves.flatMap((entry) => (entry.replied ? [] : [{ ...entry, raced: true as const }]));
}

/** A failed or raced save is dropped; a successful one waits for its echo. */
export function settleCustomModelSave(
  saves: ReadonlyArray<CustomModelSave>,
  sent: CustomModelSave,
  saved: boolean,
): ReadonlyArray<CustomModelSave> {
  return saves.flatMap((entry) =>
    entry.models !== sent.models
      ? [entry]
      : saved && !entry.raced
        ? [{ ...entry, replied: true as const }]
        : [],
  );
}
