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

export const CHANGES_ROW_HEIGHT = {
  header: 36,
  folder: 32,
  file: 38,
  empty: 32,
} as const;

/** Conflicted rows carry a resolve-actions bar underneath the row proper. */
export const CONFLICT_ACTIONS_HEIGHT = 34;
/** The inline "discard <file>?" confirm, when open on a row. */
export const DISCARD_CONFIRM_HEIGHT = 30;

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
