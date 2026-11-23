/**
 * What a new version of the file on disk means for an editor holding `baseline`. A change that
 * lands while a save is out is never the save's own unless it is the saved text itself.
 */
export function diskChange(input: {
  readonly source: string;
  readonly baseline: string;
  readonly dirty: boolean;
  readonly saving: string | null;
}): "follow" | "stale" | "ignore" {
  if (input.saving !== null) return input.source === input.saving ? "ignore" : "stale";
  if (input.source === input.baseline) return "ignore";
  return input.dirty ? "stale" : "follow";
}

/** One change on disk the person has not settled. Each change is its own, even with the same text. */
export interface DiskChange {
  readonly source: string;
}

/** The warning after a save: the change the person saved over is settled, any later one stays. */
export const staleAfterSave = (now: DiskChange | null, overwrote: DiskChange | null) =>
  now === overwrote ? null : now;
