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

export interface DiffFoldGroup {
  readonly override: DiffFoldOverride;
  readonly choices: FileDiffFoldChoices;
}

/** Test files keep their own group, so a bulk fold while they are hidden leaves them as they were. */
export interface PullRequestDiffFolds {
  readonly source: DiffFoldGroup;
  readonly test: DiffFoldGroup;
}

const EMPTY_GROUP: DiffFoldGroup = { override: null, choices: new Map() };

export const EMPTY_PULL_REQUEST_DIFF_FOLDS: PullRequestDiffFolds = {
  source: EMPTY_GROUP,
  test: EMPTY_GROUP,
};

export function withPullRequestDiffFold(
  folds: PullRequestDiffFolds,
  test: boolean,
  update: (choices: FileDiffFoldChoices) => FileDiffFoldChoices,
): PullRequestDiffFolds {
  const group = test ? folds.test : folds.source;
  const choices = update(group.choices);
  if (choices === group.choices) return folds;
  return { ...folds, [test ? "test" : "source"]: { ...group, choices } };
}

/**
 * Expand or fold every file, on later pages too. While test files are hidden, only the tests
 * still shown (a revealed one) follow; the rest keep their choices and fallback.
 */
export function foldAllPullRequestDiffs(
  folds: PullRequestDiffFolds,
  override: NonNullable<DiffFoldOverride>,
  hiddenTests: { readonly shownKeys: ReadonlyArray<string> } | null,
): PullRequestDiffFolds {
  const all: DiffFoldGroup = { override, choices: new Map() };
  if (hiddenTests === null) return { source: all, test: all };
  return {
    source: all,
    test: {
      ...folds.test,
      choices: hiddenTests.shownKeys.reduce(
        (choices, key) => withFileDiffFold(choices, key, override === "folded"),
        folds.test.choices,
      ),
    },
  };
}
