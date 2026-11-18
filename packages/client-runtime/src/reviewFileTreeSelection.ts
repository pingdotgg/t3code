import { reviewFolderContains } from "./reviewWorkspace.ts";

export type ReviewTreeRow = {
  readonly scope: "staged" | "unstaged";
  readonly path: string;
  readonly kind: "file" | "folder";
};

export type ReviewTreeSelection = {
  readonly rows: ReadonlyArray<ReviewTreeRow>;
  readonly anchor: ReviewTreeRow | null;
};

export function reviewTreeRowKey(row: Pick<ReviewTreeRow, "scope" | "path">): string {
  return JSON.stringify([row.scope, row.path]);
}

/** Ranges follow the visible tree order; folder actions include hidden descendants separately. */
export function selectReviewTreeRows(
  current: ReviewTreeSelection,
  visible: ReadonlyArray<ReviewTreeRow>,
  clicked: ReviewTreeRow,
  modifiers: { readonly toggle: boolean; readonly range: boolean },
): ReviewTreeSelection {
  const key = reviewTreeRowKey(clicked);
  const anchor = current.anchor;
  if (modifiers.range && anchor) {
    const start = visible.findIndex((row) => reviewTreeRowKey(row) === reviewTreeRowKey(anchor));
    const end = visible.findIndex((row) => reviewTreeRowKey(row) === key);
    if (start >= 0 && end >= 0) {
      const range = visible.slice(Math.min(start, end), Math.max(start, end) + 1);
      return {
        rows: modifiers.toggle
          ? [
              ...new Map(
                [...current.rows, ...range].map((row) => [reviewTreeRowKey(row), row]),
              ).values(),
            ]
          : range,
        anchor,
      };
    }
  }
  if (modifiers.toggle) {
    const selected = current.rows.some((row) => reviewTreeRowKey(row) === key);
    return {
      rows: selected
        ? current.rows.filter((row) => reviewTreeRowKey(row) !== key)
        : [...current.rows, clicked],
      anchor: clicked,
    };
  }
  return { rows: [clicked], anchor: clicked };
}

/** Actions on a selected row apply to its whole selection, within the action's Git section. */
export function reviewTreeActionFiles(
  files: ReadonlyArray<string>,
  selected: ReadonlyArray<ReviewTreeRow>,
  clicked: ReviewTreeRow | null,
): string[] {
  if (clicked === null) return [...new Set(files)];
  const contains = (row: ReviewTreeRow, path: string) =>
    row.path === path || (row.kind === "folder" && reviewFolderContains(row.path, path));
  const sameScope = selected.filter((row) => row.scope === clicked.scope);
  const targets = sameScope.some((row) => contains(row, clicked.path)) ? sameScope : [clicked];
  const exact = new Set(targets.map((row) => row.path));
  const folders = targets.filter((row) => row.kind === "folder");
  return [
    ...new Set(
      files.filter((path) => exact.has(path) || folders.some((row) => contains(row, path))),
    ),
  ];
}
