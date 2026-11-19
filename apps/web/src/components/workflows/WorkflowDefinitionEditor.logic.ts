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

/** The warning after a save: one the person saved over is settled, a newer one stays. */
export const staleAfterSave = (now: string | null, overwrote: string | null) =>
  now === overwrote ? null : now;
