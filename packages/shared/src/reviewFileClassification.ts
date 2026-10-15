/** Review presentation rules for this client. */
export type ReviewFileGroup = "implementation" | "tests" | "generated";

const REVIEW_FILE_GROUPS = [
  { id: "implementation", title: "Implementation" },
  { id: "tests", title: "Tests" },
  { id: "generated", title: "Generated" },
] as const;

/** Chapter membership stays complete while viewing options filter the files shown in its reader. */
export function reviewFileChapters<T>(
  files: ReadonlyArray<T>,
  getPath: (file: T) => string,
  visibleFiles?: ReadonlyArray<T>,
) {
  return REVIEW_FILE_GROUPS.flatMap((group) => {
    const chapterFiles = files.filter((file) => reviewFileGroup(getPath(file)) === group.id);
    return chapterFiles.length > 0
      ? [
          {
            ...group,
            files: chapterFiles,
            visibleFiles:
              visibleFiles === undefined
                ? chapterFiles
                : visibleFiles.filter((file) => reviewFileGroup(getPath(file)) === group.id),
          },
        ]
      : [];
  });
}

export function isReviewTestFile(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  const name = parts.at(-1) ?? "";
  return (
    parts
      .slice(0, -1)
      .some((part) => /^(?:__tests__|__snapshots__|tests?|spec|e2e)$/i.test(part)) ||
    /\.(?:test|spec)\./i.test(name) ||
    /\.snap$/i.test(name) ||
    /^(?:test_.+|.+_test)\.py$/i.test(name) ||
    /_test\.(?:go|rs|rb|c|cc|cpp|h|hpp)$/i.test(name) ||
    /(?:Test|Tests|Spec)\.(?:java|kt|kts|swift|cs)$/.test(name) ||
    /_spec\.rb$/i.test(name)
  );
}
const generatedNames = new Set([
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
]);
export function reviewFileGroup(path: string): ReviewFileGroup {
  const parts = path.replaceAll("\\", "/").split("/");
  const name = parts.at(-1) ?? "";
  if (
    generatedNames.has(name) ||
    /\.(?:snap|min\.js|min\.css)$/.test(name) ||
    /\.generated\./.test(name) ||
    parts
      .slice(0, -1)
      .some((part) =>
        ["__snapshots__", "__generated__", "_generated", "dist", "build", "vendor"].includes(part),
      )
  )
    return "generated";
  return isReviewTestFile(path) ? "tests" : "implementation";
}
