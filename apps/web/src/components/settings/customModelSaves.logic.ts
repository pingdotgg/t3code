import {
  type CustomModelDefinition,
  readCustomModelEntries,
  toCustomModelSetting,
} from "@t3tools/shared/model";

export interface CustomModelSave {
  readonly models: ReadonlyArray<CustomModelDefinition>;
  /** The models as the config stream will read them back once this save lands. */
  readonly key: string;
  /** The stored list when the save replied; unset while in flight. */
  readonly storedAtReply?: string;
}

export const customModelsKey = (models: ReadonlyArray<CustomModelDefinition>) =>
  JSON.stringify(readCustomModelEntries(models.map(toCustomModelSetting)));

/**
 * Saves the stored list does not reflect yet, after the stored list changed. Saves land in order,
 * so the echo of one settles it and every save before it; repeated snapshots retire only the
 * earliest match because later identical saves may still be pending. Any other stored change
 * drops the replied ones.
 */
export function pendingCustomModelSaves(
  saves: ReadonlyArray<CustomModelSave>,
  storedKey: string,
): ReadonlyArray<CustomModelSave> {
  const echoed = saves.findIndex((entry) => entry.key === storedKey);
  return saves
    .slice(echoed + 1)
    .flatMap((entry) =>
      entry.storedAtReply === undefined
        ? [entry]
        : echoed >= 0 || entry.storedAtReply === storedKey
          ? [{ ...entry, storedAtReply: storedKey }]
          : [],
    );
}

/** A failed save is dropped; a successful one waits for its echo. */
export function settleCustomModelSave(
  saves: ReadonlyArray<CustomModelSave>,
  sent: CustomModelSave,
  saved: boolean,
  storedKey: string,
): ReadonlyArray<CustomModelSave> {
  return saves.flatMap((entry) =>
    entry !== sent ? [entry] : saved ? [{ ...entry, storedAtReply: storedKey }] : [],
  );
}
