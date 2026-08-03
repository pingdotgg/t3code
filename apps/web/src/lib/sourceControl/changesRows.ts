/**
 * The changes list as data.
 *
 * Tree-vs-flat is a flag inside ONE builder rather than two render branches:
 * `buildChangesRows` is the only source of row order, so the virtualizer,
 * keyboard navigation, shift-range selection and the sticky header overlay all
 * index the same array. Two orders means keyboard focus can land on a row
 * inside a collapsed folder that was never rendered.
 *
 * Pure and dependency-free (no React, no store) so the ordering rule is
 * testable on its own.
 */

import {
  buildSourceControlTree,
  collectAllFolderPaths,
  flattenSourceControlTree,
  type SourceControlTreeRow,
} from "./fileTree";
import type { WorkingCopyFile } from "./types";

export type ChangesRowKind = "header" | "folder" | "file" | "empty";
export type ChangesGroup = "conflicted" | "staged" | "unstaged";
export type ChangesViewMode = "flat" | "tree";
export type ChangesStatusFilter =
  | "all"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked";

export interface ChangesRow {
  /** Stable row key, unique across the whole list. */
  readonly key: string;
  readonly kind: ChangesRowKind;
  readonly group: ChangesGroup;
  /** Tree indent. 0 in flat mode and for headers. */
  readonly depth: number;

  // ── file rows ──
  readonly file?: WorkingCopyFile | undefined;

  // ── folder rows ──
  /** Folder path — the stable key for collapse state. */
  readonly path?: string | undefined;
  readonly name?: string | undefined;
  /** Every visible file path under this folder. */
  readonly folderFiles?: ReadonlyArray<string> | undefined;
  readonly collapsed?: boolean | undefined;

  // ── header rows ──
  /** Files in the group, ignoring the filter. */
  readonly total?: number | undefined;
  /** Files in the group that survive the filter. */
  readonly visible?: number | undefined;
  readonly detail?: string | undefined;
}

export interface BuildChangesRowsInput {
  readonly files: ReadonlyArray<WorkingCopyFile>;
  readonly viewMode: ChangesViewMode;
  /** Group keys the user collapsed. Conflicted is never collapsible. */
  readonly collapsedGroups: ReadonlySet<string>;
  /** `${group}:${folderPath}` keys the user collapsed in tree mode. */
  readonly collapsedFolders: ReadonlySet<string>;
  readonly filter: ChangesStatusFilter;
  readonly query: string;
}

export const CHANGES_GROUP_ORDER: ReadonlyArray<ChangesGroup> = [
  "conflicted",
  "staged",
  "unstaged",
];

export const CHANGES_GROUP_TITLE: Record<ChangesGroup, string> = {
  conflicted: "merge conflicts",
  staged: "staged",
  unstaged: "changes",
};

/**
 * Composite row identity: the same path can be staged AND unstaged at once
 * (an `MM` porcelain record), so the group is part of the key.
 */
export function changesGroupOf(file: WorkingCopyFile): ChangesGroup {
  if (file.area === "conflicted") {
    return "conflicted";
  }
  if (file.area === "staged") {
    return "staged";
  }
  return "unstaged";
}

export function changesFileRowKey(file: WorkingCopyFile): string {
  return `${changesGroupOf(file)}-${file.path}`;
}

export function changesFolderRowKey(group: ChangesGroup, path: string): string {
  return `${group}:d:${path}`;
}

export function changesHeaderRowKey(group: ChangesGroup): string {
  return `${group}:head`;
}

export function matchesChangesFilter(file: WorkingCopyFile, filter: ChangesStatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "modified":
      return file.change === "modified" || file.change === "typechange";
    case "added":
      return file.change === "added";
    case "deleted":
      return file.change === "deleted";
    case "renamed":
      return file.change === "renamed" || file.change === "copied";
    case "untracked":
      return file.change === "untracked";
  }
}

function passesFilters(
  file: WorkingCopyFile,
  filter: ChangesStatusFilter,
  normalizedQuery: string,
): boolean {
  if (!matchesChangesFilter(file, filter)) {
    return false;
  }
  return normalizedQuery === "" || file.path.toLowerCase().includes(normalizedQuery);
}

function treeRowToChangesRow(group: ChangesGroup, row: SourceControlTreeRow): ChangesRow {
  if (row.type === "file" && row.file) {
    return {
      key: changesFileRowKey(row.file),
      kind: "file",
      group,
      depth: row.depth,
      file: row.file,
    };
  }
  return {
    key: changesFolderRowKey(group, row.path),
    kind: "folder",
    group,
    depth: row.depth,
    path: row.path,
    name: row.name,
    folderFiles: row.files,
    collapsed: row.collapsed,
  };
}

/**
 * The visible rows, top to bottom.
 *
 * A group's header exists whenever the group has ANY file, filtered or not, so
 * the header can carry both counts and the group never silently disappears
 * while a filter is on.
 */
export function buildChangesRows(input: BuildChangesRowsInput): ReadonlyArray<ChangesRow> {
  const normalizedQuery = input.query.trim().toLowerCase();

  const byGroup: Record<ChangesGroup, WorkingCopyFile[]> = {
    conflicted: [],
    staged: [],
    unstaged: [],
  };
  for (const file of input.files) {
    byGroup[changesGroupOf(file)].push(file);
  }

  const visibleByGroup: Record<ChangesGroup, WorkingCopyFile[]> = {
    conflicted: byGroup.conflicted.filter((file) =>
      passesFilters(file, input.filter, normalizedQuery),
    ),
    staged: byGroup.staged.filter((file) => passesFilters(file, input.filter, normalizedQuery)),
    unstaged: byGroup.unstaged.filter((file) => passesFilters(file, input.filter, normalizedQuery)),
  };

  // When NOTHING matches, the section shows its own "no files match" banner —
  // three per-group placeholders on top of it would just be noise.
  const anyVisible = CHANGES_GROUP_ORDER.some((group) => visibleByGroup[group].length > 0);

  const rows: ChangesRow[] = [];

  for (const group of CHANGES_GROUP_ORDER) {
    const all = byGroup[group];
    if (all.length === 0) {
      continue;
    }
    const visible = visibleByGroup[group];

    // Conflicted is never collapsible — it is the one thing the user must act
    // on, so a stale collapse flag cannot hide it.
    const collapsed = group !== "conflicted" && input.collapsedGroups.has(group);

    rows.push({
      key: changesHeaderRowKey(group),
      kind: "header",
      group,
      depth: 0,
      total: all.length,
      visible: visible.length,
      collapsed,
      detail: group === "conflicted" ? "edit, then stage to mark resolved" : undefined,
    });

    if (collapsed) {
      continue;
    }

    if (visible.length === 0) {
      if (anyVisible) {
        rows.push({
          key: `${group}:empty`,
          kind: "empty",
          group,
          depth: 0,
          detail: "no files match in this group",
        });
      }
      continue;
    }

    if (input.viewMode === "flat") {
      for (const file of visible) {
        rows.push({ key: changesFileRowKey(file), kind: "file", group, depth: 0, file });
      }
      continue;
    }

    const treeRows = flattenSourceControlTree(buildSourceControlTree(visible), (folderPath) =>
      input.collapsedFolders.has(`${group}:${folderPath}`),
    );
    for (const treeRow of treeRows) {
      rows.push(treeRowToChangesRow(group, treeRow));
    }
  }

  return rows;
}

/** Rows the keyboard can land on. Headers, folders and placeholders are skipped. */
export function isChangesFileRow(row: ChangesRow): boolean {
  return row.kind === "file";
}

/**
 * The scope a group header's bulk action applies to.
 *
 * Deliberately the same filter/query the rows were built from: a header that
 * reads "3 of 12" sits above three visible rows, and a bulk action that touched
 * the other nine would be acting on files the user cannot see.
 */
export interface ChangesGroupScope {
  readonly files: ReadonlyArray<WorkingCopyFile>;
  readonly filter: ChangesStatusFilter;
  readonly query: string;
}

/**
 * fork: f4 — the files ONE group's header acts on.
 *
 * Computed from the full file list rather than from the rendered rows, because
 * a collapsed folder removes its children from `rows` and "Stage all" must not
 * quietly mean "stage all the ones that happen to be expanded".
 */
export function changesGroupFiles(
  scope: ChangesGroupScope,
  group: ChangesGroup,
): ReadonlyArray<WorkingCopyFile> {
  const normalizedQuery = scope.query.trim().toLowerCase();
  return scope.files.filter(
    (file) => changesGroupOf(file) === group && passesFilters(file, scope.filter, normalizedQuery),
  );
}

/**
 * Deduped paths for a group header's bulk action.
 *
 * The reason this exists at all: the group header's "Discard all" used to call
 * the changes list with an empty path array, which the panel expanded into the
 * whole-working-copy discard rung. A group-scoped affordance must carry its own
 * group's paths and nothing else.
 */
export function changesGroupPaths(
  scope: ChangesGroupScope,
  group: ChangesGroup,
): ReadonlyArray<string> {
  return [...new Set(changesGroupFiles(scope, group).map((file) => file.path))];
}

/**
 * fork: f4 — EVERY folder collapse key in one group, including folders that are
 * currently hidden inside a collapsed parent.
 *
 * `changesFolderKeysIn(rows)` only sees what is rendered, so "Collapse folders"
 * built from it collapsed exactly one more level per press instead of all of
 * them. This builds the group's tree with nothing collapsed, so one press is
 * one answer.
 */
export function changesAllFolderKeys(
  scope: ChangesGroupScope,
  group: ChangesGroup,
): ReadonlyArray<string> {
  const files = changesGroupFiles(scope, group);
  if (files.length === 0) {
    return [];
  }
  return collectAllFolderPaths(buildSourceControlTree(files)).map((path) => `${group}:${path}`);
}

/** Every folder collapse key currently in the list, for expand/collapse-all. */
export function changesFolderKeysIn(rows: ReadonlyArray<ChangesRow>): ReadonlyArray<string> {
  const keys: string[] = [];
  for (const row of rows) {
    if (row.kind === "folder" && row.path !== undefined) {
      keys.push(`${row.group}:${row.path}`);
    }
  }
  return keys;
}

/**
 * Paths that appear in more than one group — the `partial` chip on a row.
 * An `MM` record legitimately produces two rows for one path.
 */
export function partiallyStagedPaths(files: ReadonlyArray<WorkingCopyFile>): ReadonlySet<string> {
  const seen = new Map<string, ChangesGroup>();
  const partial = new Set<string>();
  for (const file of files) {
    const group = changesGroupOf(file);
    const previous = seen.get(file.path);
    if (previous !== undefined && previous !== group) {
      partial.add(file.path);
      continue;
    }
    seen.set(file.path, group);
  }
  return partial;
}

// ── Geometry ────────────────────────────────────────────────────────────────
// The virtualizer needs a height per row BEFORE it mounts, so heights are
// declared data rather than something read back off the DOM.
//
// fork: f4 redesign (audit §8 / M5) — these were 36/32/38, imported from 2code's
// type scale, which made the LEAF row taller than the group header above it and
// gave a single line of `text-sm` ~10px of slack. t3's list-row rhythm is 28px
// at `text-sm` on desktop (`ui/menu.tsx` `sm:min-h-7`), so every row kind sits
// on one pitch and the hierarchy is carried by indent and weight, not by height.
//
// The rendered rows apply the SAME constant as an explicit height — that
// equality is what keeps the virtualizer's assumed pitch and the painted pitch
// from drifting, and `changesRows.test.ts` pins it.

export const CHANGES_ROW_HEIGHT = {
  header: 28,
  folder: 28,
  file: 28,
  empty: 28,
} as const;

/** Conflicted rows carry a resolve-actions bar underneath the row proper. */
export const CONFLICT_ACTIONS_HEIGHT = 28;
/** The inline "discard <file>?" confirm, when open on a row. */
export const DISCARD_CONFIRM_HEIGHT = 28;

/**
 * fork: f4 redesign (audit §8 / M1) — the ONE horizontal inset for the whole
 * panel. Header, toolbar, filter row, status band, every list row and the
 * composer all start here; the panel used to stack six different left insets
 * (16/8/8/8/12/6) so nothing lined up with anything.
 */
export const CHANGES_GUTTER = 12;

/**
 * Tree indent per level, on the app's 4px grid. Was 13 — a value copied from
 * another app's 16px base inset and then applied to an 8px one.
 */
export const CHANGES_INDENT_PER_LEVEL = 12;

/** The left inset of a row at `depth`, gutter included. */
export function changesRowIndent(depth: number): number {
  return CHANGES_GUTTER + Math.max(0, depth) * CHANGES_INDENT_PER_LEVEL;
}

/**
 * fork: f4 redesign (audit §8 / M7) — which designed empty state the Changes
 * list owes the user, if any.
 *
 * Kept pure and separate from the row builder because the answer decides what
 * the panel renders INSTEAD of the list (an `Empty`, with a "Clear filter"
 * action in the filtered case), and "clean tree" and "your filter matched
 * nothing" are the two cases the old 32px "Nothing here." row could not tell
 * apart.
 */
export type ChangesEmptyState = "clean" | "filtered";

export function changesListEmptyState(input: {
  /** Files in the working copy, before any filter. */
  readonly fileCount: number;
  /** File rows that survived the status filter and the path query. */
  readonly visibleFileCount: number;
}): ChangesEmptyState | null {
  if (input.fileCount === 0) {
    return "clean";
  }
  return input.visibleFileCount === 0 ? "filtered" : null;
}

/** File rows in a built row list — the input `changesListEmptyState` needs. */
export function changesVisibleFileCount(rows: ReadonlyArray<ChangesRow>): number {
  let count = 0;
  for (const row of rows) {
    if (row.kind === "file") count += 1;
  }
  return count;
}

export function changesRowHeight(
  row: ChangesRow,
  options: {
    readonly hasConflictActions: boolean;
    readonly confirmingDiscardKey: string | null;
  },
): number {
  if (row.kind !== "file") {
    return CHANGES_ROW_HEIGHT[row.kind];
  }
  let height = CHANGES_ROW_HEIGHT.file;
  if (row.group === "conflicted" && options.hasConflictActions) {
    height += CONFLICT_ACTIONS_HEIGHT;
  }
  if (options.confirmingDiscardKey === row.key) {
    height += DISCARD_CONFIRM_HEIGHT;
  }
  return height;
}
