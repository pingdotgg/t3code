import { classifyChangedFile, type ChangedFileKind } from "./changedFileKind.ts";

export type ReviewFileGroup = ChangedFileKind;

export const REVIEW_FILE_GROUPS = [
  { id: "code", title: "Code" },
  { id: "tests", title: "Tests" },
  { id: "mocks", title: "Mocks" },
  { id: "generated", title: "Generated" },
  { id: "docs", title: "Docs" },
] as const;

export const reviewFileGroup = classifyChangedFile;

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

export function reviewFileChapterIndex<T>(input: {
  readonly completePaths: ReadonlyArray<string> | null;
  readonly loadedFiles: ReadonlyArray<T>;
  readonly visibleFiles: ReadonlyArray<T>;
  readonly getPath: (file: T) => string;
}) {
  const paths = input.completePaths ?? input.loadedFiles.map(input.getPath);
  return {
    complete: input.completePaths !== null,
    chapters: reviewFileChapters(paths, (path) => path).map((chapter) => ({
      ...chapter,
      visibleFiles: input.visibleFiles.filter(
        (file) => reviewFileGroup(input.getPath(file)) === chapter.id,
      ),
    })),
  };
}

export function isReviewTestFile(path: string): boolean {
  return classifyChangedFile(path) === "tests";
}
