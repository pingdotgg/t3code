/**
 * Column from `status:*` labels. Defaults: backlog|todo|in-progress|review|done.
 * Unmapped → backlog. Several matches → furthest along BOARD_COLUMN_IDS.
 */

export const BOARD_COLUMN_IDS = ["backlog", "todo", "in-progress", "review", "done"] as const;

export type BoardColumnId = (typeof BOARD_COLUMN_IDS)[number];

export const STATUS_LABEL_PREFIX = "status:";

/** Fixed mapping: column id ↔ label slug after `status:`. */
export const BOARD_COLUMN_STATUS_SLUGS: Readonly<Record<BoardColumnId, string>> = {
  backlog: "backlog",
  todo: "todo",
  "in-progress": "in-progress",
  review: "review",
  done: "done",
};

export type BoardLabel = {
  readonly name: string;
};

const slugToColumn = new Map<string, BoardColumnId>(
  BOARD_COLUMN_IDS.map((id) => [BOARD_COLUMN_STATUS_SLUGS[id].toLowerCase(), id]),
);

/** Normalize a label name to a status slug, or null if it is not a status label. */
export function statusSlugFromLabelName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed.toLowerCase().startsWith(STATUS_LABEL_PREFIX)) return null;
  const slug = trimmed.slice(STATUS_LABEL_PREFIX.length).trim().toLowerCase();
  return slug.length > 0 ? slug : null;
}

export function isStatusLabelName(name: string): boolean {
  return statusSlugFromLabelName(name) !== null;
}

/** Labels that are not column-status noise (for card chips). */
export function nonStatusLabels<T extends BoardLabel>(labels: ReadonlyArray<T>): ReadonlyArray<T> {
  return labels.filter((label) => !isStatusLabelName(label.name));
}

/** Pick column; unmapped → backlog; multiple → most progressed. */
export function assignBoardColumn(labels: ReadonlyArray<BoardLabel>): BoardColumnId {
  let bestIndex = -1;
  for (const label of labels) {
    const slug = statusSlugFromLabelName(label.name);
    if (slug === null) continue;
    const column = slugToColumn.get(slug);
    if (column === undefined) continue;
    const index = BOARD_COLUMN_IDS.indexOf(column);
    if (index > bestIndex) bestIndex = index;
  }
  return bestIndex < 0 ? "backlog" : BOARD_COLUMN_IDS[bestIndex]!;
}

export function groupIssuesByBoardColumn<T extends { readonly labels: ReadonlyArray<BoardLabel> }>(
  issues: ReadonlyArray<T>,
): Readonly<Record<BoardColumnId, ReadonlyArray<T>>> {
  const buckets: Record<BoardColumnId, T[]> = {
    backlog: [],
    todo: [],
    "in-progress": [],
    review: [],
    done: [],
  };
  for (const issue of issues) {
    buckets[assignBoardColumn(issue.labels)].push(issue);
  }
  return buckets;
}

/** True when any issue carries a known `status:*` column label. */
export function anyIssueHasStatusLabel(
  issues: ReadonlyArray<{ readonly labels: ReadonlyArray<BoardLabel> }>,
): boolean {
  return issues.some((issue) =>
    issue.labels.some((label) => {
      const slug = statusSlugFromLabelName(label.name);
      return slug !== null && slugToColumn.has(slug);
    }),
  );
}

/** Filter issues that must match every selected label name (case-insensitive). */
export function filterIssuesByLabelNames<T extends { readonly labels: ReadonlyArray<BoardLabel> }>(
  issues: ReadonlyArray<T>,
  requiredLabelNames: ReadonlyArray<string>,
): ReadonlyArray<T> {
  if (requiredLabelNames.length === 0) return issues;
  const required = requiredLabelNames.map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (required.length === 0) return issues;
  return issues.filter((issue) => {
    const names = new Set(issue.labels.map((label) => label.name.trim().toLowerCase()));
    return required.every((name) => names.has(name));
  });
}
