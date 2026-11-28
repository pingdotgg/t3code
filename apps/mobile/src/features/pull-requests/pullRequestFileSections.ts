import type { ReviewRenderableFile } from "../review/reviewModel";

export function fileDirectory(path: string) {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

type SheetItem =
  | {
      readonly kind: "directory";
      readonly key: string;
      readonly directory: string;
      readonly collapsed: boolean;
    }
  | { readonly kind: "file"; readonly key: string; readonly file: ReviewRenderableFile };

export function groupByDirectory(
  files: ReadonlyArray<ReviewRenderableFile>,
  collapsed: ReadonlySet<string>,
) {
  // Keep the shared review order: a directory gets a new header each time it resumes after a subdirectory.
  const items: SheetItem[] = [];
  files.forEach((file, index) => {
    const directory = fileDirectory(file.path);
    const previous = files[index - 1];
    if (!previous || directory !== fileDirectory(previous.path)) {
      items.push({
        kind: "directory",
        key: `directory:${directory}:${index}`,
        directory,
        collapsed: collapsed.has(directory),
      });
    }
    if (!collapsed.has(directory)) items.push({ kind: "file", key: file.id, file });
  });
  return items;
}
