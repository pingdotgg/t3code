/**
 * Focus and multi-selection over the changes list.
 *
 * Every function here indexes the SAME array `buildChangesRows` produced. That
 * is the whole point: the virtualizer, the keyboard, shift-range selection and
 * the sticky header must agree on display order, and the only way to guarantee
 * that is for none of them to compute an order of their own.
 *
 * fork: f4 source-control panel
 */
import {
  changesRowHeight,
  isChangesFileRow,
  type ChangesGroup,
  type ChangesRow,
} from "~/lib/sourceControl/changesRows";

export interface ChangesSelection {
  /** Row key the keyboard is on. Null when nothing is focused. */
  readonly focusedKey: string | null;
  /** Row keys in the multi-selection. Always includes `focusedKey` when set. */
  readonly selectedKeys: ReadonlySet<string>;
  /** Range anchor for shift+click / shift+arrow. */
  readonly anchorKey: string | null;
}

export const EMPTY_CHANGES_SELECTION: ChangesSelection = {
  focusedKey: null,
  selectedKeys: new Set<string>(),
  anchorKey: null,
};

/** Only file rows can be focused — headers, folders and placeholders are skipped. */
export function focusableRowKeys(rows: ReadonlyArray<ChangesRow>): ReadonlyArray<string> {
  const keys: string[] = [];
  for (const row of rows) {
    if (isChangesFileRow(row)) {
      keys.push(row.key);
    }
  }
  return keys;
}

export type ChangesFocusMove = "next" | "previous" | "first" | "last";

export function moveChangesFocus(
  rows: ReadonlyArray<ChangesRow>,
  currentKey: string | null,
  move: ChangesFocusMove,
): string | null {
  const keys = focusableRowKeys(rows);
  if (keys.length === 0) {
    return null;
  }
  if (move === "first") return keys[0] ?? null;
  if (move === "last") return keys[keys.length - 1] ?? null;

  const index = currentKey === null ? -1 : keys.indexOf(currentKey);
  if (index === -1) {
    // A focus that fell off the list (the file was staged away) restarts from
    // the appropriate end rather than swallowing the keypress.
    return move === "next" ? (keys[0] ?? null) : (keys[keys.length - 1] ?? null);
  }
  const nextIndex = move === "next" ? index + 1 : index - 1;
  if (nextIndex < 0 || nextIndex >= keys.length) {
    return currentKey;
  }
  return keys[nextIndex] ?? null;
}

/** Plain click / plain arrow: single select, and reset the range anchor. */
export function selectSingleRow(key: string): ChangesSelection {
  return { focusedKey: key, selectedKeys: new Set([key]), anchorKey: key };
}

/** Cmd/Ctrl+click: toggle one row, keeping the rest of the selection. */
export function toggleRowSelection(selection: ChangesSelection, key: string): ChangesSelection {
  const selectedKeys = new Set(selection.selectedKeys);
  if (selectedKeys.has(key)) {
    selectedKeys.delete(key);
    return {
      focusedKey: selectedKeys.size === 0 ? null : key,
      selectedKeys,
      anchorKey: key,
    };
  }
  selectedKeys.add(key);
  return { focusedKey: key, selectedKeys, anchorKey: key };
}

/**
 * Shift+click: a contiguous range over DISPLAY order, not over the file list.
 * Selecting "everything between these two rows" has to mean what the user sees,
 * which is why this walks `rows` rather than the status payload.
 */
export function selectRowRange(
  rows: ReadonlyArray<ChangesRow>,
  selection: ChangesSelection,
  key: string,
): ChangesSelection {
  const keys = focusableRowKeys(rows);
  const anchor = selection.anchorKey ?? selection.focusedKey;
  const anchorIndex = anchor === null ? -1 : keys.indexOf(anchor);
  const targetIndex = keys.indexOf(key);
  if (targetIndex === -1) {
    return selection;
  }
  if (anchorIndex === -1) {
    return selectSingleRow(key);
  }
  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  const selectedKeys = new Set<string>();
  for (let index = from; index <= to; index += 1) {
    const rowKey = keys[index];
    if (rowKey !== undefined) selectedKeys.add(rowKey);
  }
  return { focusedKey: key, selectedKeys, anchorKey: anchor };
}

/**
 * Drop keys that no longer exist after a refresh, keeping identity when nothing
 * changed so the list does not re-render on every idle status read.
 */
export function reconcileSelection(
  selection: ChangesSelection,
  rows: ReadonlyArray<ChangesRow>,
): ChangesSelection {
  const live = new Set(focusableRowKeys(rows));
  const nextSelected = [...selection.selectedKeys].filter((key) => live.has(key));
  const focusedKey =
    selection.focusedKey !== null && live.has(selection.focusedKey) ? selection.focusedKey : null;
  const anchorKey =
    selection.anchorKey !== null && live.has(selection.anchorKey) ? selection.anchorKey : null;
  if (
    nextSelected.length === selection.selectedKeys.size &&
    focusedKey === selection.focusedKey &&
    anchorKey === selection.anchorKey
  ) {
    return selection;
  }
  return { focusedKey, selectedKeys: new Set(nextSelected), anchorKey };
}

/**
 * The rows an action applies to: the whole multi-selection when the focused row
 * is part of it, otherwise just the focused row. This is what makes `s` on a
 * 40-file selection one call rather than 40.
 */
export function actionTargetRows(
  rows: ReadonlyArray<ChangesRow>,
  selection: ChangesSelection,
): ReadonlyArray<ChangesRow> {
  const byKey = new Map(rows.filter(isChangesFileRow).map((row) => [row.key, row]));
  if (
    selection.focusedKey !== null &&
    selection.selectedKeys.size > 1 &&
    selection.selectedKeys.has(selection.focusedKey)
  ) {
    const targets: ChangesRow[] = [];
    for (const row of rows) {
      if (isChangesFileRow(row) && selection.selectedKeys.has(row.key)) {
        targets.push(row);
      }
    }
    return targets;
  }
  if (selection.focusedKey === null) {
    return [];
  }
  const row = byKey.get(selection.focusedKey);
  return row ? [row] : [];
}

/** Deduped paths for a batch RPC. A path can be in two groups at once (`MM`). */
export function targetPaths(rows: ReadonlyArray<ChangesRow>): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (const row of rows) {
    if (row.file) paths.add(row.file.path);
  }
  return [...paths];
}

export function rowsInGroup(
  rows: ReadonlyArray<ChangesRow>,
  group: ChangesGroup,
): ReadonlyArray<ChangesRow> {
  return rows.filter((row) => isChangesFileRow(row) && row.group === group);
}

// ─── Virtualizer geometry ───────────────────────────────────────────────────

export interface ChangesRowHeightOptions {
  readonly hasConflictActions: boolean;
  readonly confirmingDiscardKey: string | null;
}

/**
 * Row offsets, in the one order everything else uses. Used for scroll-into-view
 * and for the sticky-header pin, so both agree with the virtualizer by
 * construction rather than by coincidence.
 */
export function changesRowOffsets(
  rows: ReadonlyArray<ChangesRow>,
  options: ChangesRowHeightOptions,
): ReadonlyArray<number> {
  const offsets: number[] = [];
  let offset = 0;
  for (const row of rows) {
    offsets.push(offset);
    offset += changesRowHeight(row, options);
  }
  return offsets;
}

/**
 * Which group header to pin, given a scroll offset.
 *
 * The header is an always-mounted overlay rather than `position: sticky`,
 * because a windowed row unmounts as it leaves the viewport and takes its
 * sticky positioning with it. The pin only engages once that group's own
 * header has scrolled out of view — otherwise the real header and the overlay
 * would double up.
 */
export function stickyChangesGroup(
  rows: ReadonlyArray<ChangesRow>,
  options: ChangesRowHeightOptions,
  scrollTop: number,
): ChangesGroup | null {
  let offset = 0;
  let pinned: ChangesGroup | null = null;
  for (const row of rows) {
    const height = changesRowHeight(row, options);
    if (row.kind === "header") {
      if (offset + height <= scrollTop) {
        pinned = row.group;
      } else {
        // This header is still visible; nothing after it can be pinned either.
        return pinned;
      }
    }
    offset += height;
  }
  return pinned;
}
