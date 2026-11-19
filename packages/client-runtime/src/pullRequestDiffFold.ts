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

export interface PullRequestDiffFoldState {
  readonly sourceOverride: DiffFoldOverride;
  readonly testOverride: DiffFoldOverride;
  readonly choices: FileDiffFoldChoices;
}

export function createPullRequestDiffFoldState(): PullRequestDiffFoldState {
  return { sourceOverride: null, testOverride: null, choices: new Map() };
}

/** Scope the bulk override to the filter at click time, including for files that load later. */
export function applyPullRequestDiffFold(
  current: PullRequestDiffFoldState,
  override: NonNullable<DiffFoldOverride>,
  defaultOverride: DiffFoldOverride,
  filteredTests: ReadonlyArray<{
    readonly key: string;
    readonly viewed: boolean;
    readonly hidden: boolean;
  }> | null,
): PullRequestDiffFoldState {
  const choices = new Map<string, boolean>();
  const previousTestOverride = current.testOverride ?? defaultOverride;
  for (const { key, viewed, hidden } of filteredTests ?? []) {
    choices.set(
      key,
      hidden
        ? isFileDiffCollapsed(key, previousTestOverride, current.choices, viewed)
        : override === "folded",
    );
  }
  return {
    sourceOverride: override,
    testOverride: filteredTests === null ? override : current.testOverride,
    choices,
  };
}
