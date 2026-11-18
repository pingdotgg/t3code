export type DiffFoldOverride = "expanded" | "folded" | null;

/** The reader's own fold choice per file. It is absolute, so a Viewed mark loading later keeps it. */
export type FileDiffFoldChoices = ReadonlyMap<string, boolean>;

export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  choices: FileDiffFoldChoices,
  viewed = false,
): boolean {
  return choices.get(fileKey) ?? (foldOverride === null ? viewed : foldOverride === "folded");
}

export function withFileDiffFold(
  choices: FileDiffFoldChoices,
  fileKey: string,
  collapsed: boolean | undefined,
): FileDiffFoldChoices {
  if (choices.get(fileKey) === collapsed) return choices;
  const next = new Map(choices);
  if (collapsed === undefined) next.delete(fileKey);
  else next.set(fileKey, collapsed);
  return next;
}
