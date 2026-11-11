import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

/** Most conversations a split view shows at once. */
export const MAX_PANES = 6;

export interface Pane {
  /** Stable per slot, so a pane that switches threads keeps its mounted ChatView. */
  readonly id: string;
  readonly ref: ScopedThreadRef;
}

export interface PaneLayout {
  readonly panes: ReadonlyArray<Pane>;
  readonly focusedIndex: number;
}

export const EMPTY_PANE_LAYOUT: PaneLayout = { panes: [], focusedIndex: 0 };

/** Split view is two or more panes; a single pane is the ordinary one-thread view. */
export function isSplitLayout(layout: PaneLayout): boolean {
  return layout.panes.length >= 2;
}

function indexOfRef(panes: ReadonlyArray<Pane>, ref: ScopedThreadRef): number {
  const key = scopedThreadKey(ref);
  return panes.findIndex((pane) => scopedThreadKey(pane.ref) === key);
}

function clampFocus(index: number, count: number): number {
  return Math.max(0, Math.min(index, count - 1));
}

/**
 * Add `ref` as a new pane. `current` is the thread the single view shows, which becomes the first
 * pane when a split starts. A thread that is already open is focused instead of duplicated; at the
 * limit the focused pane is replaced.
 */
export function addPane(
  layout: PaneLayout,
  current: ScopedThreadRef | null,
  ref: ScopedThreadRef,
  newId: () => string,
): PaneLayout {
  // Below two panes the layout is just a leftover, so the thread on screen is the real first pane.
  const panes =
    layout.panes.length >= 2 || current === null
      ? layout.panes
      : [{ id: layout.panes[0]?.id ?? newId(), ref: current }];
  const existing = indexOfRef(panes, ref);
  if (existing !== -1) return { panes, focusedIndex: existing };
  if (panes.length >= MAX_PANES) return replacePane(layout, layout.focusedIndex, ref, newId);
  return { panes: [...panes, { id: newId(), ref }], focusedIndex: panes.length };
}

/**
 * Show `ref` in the pane at `index`. If another pane already shows it the two swap, so a drop
 * never leaves the same conversation open twice.
 */
export function replacePane(
  layout: PaneLayout,
  index: number,
  ref: ScopedThreadRef,
  newId: () => string,
): PaneLayout {
  const target = layout.panes[index];
  if (target === undefined) return addPane(layout, null, ref, newId);
  const existing = indexOfRef(layout.panes, ref);
  if (existing === index) return { ...layout, focusedIndex: index };
  const panes = layout.panes.map((pane, i) => {
    if (i === index) return { id: pane.id, ref };
    if (i === existing) return { id: pane.id, ref: target.ref };
    return pane;
  });
  return { panes, focusedIndex: index };
}

export function closePane(layout: PaneLayout, index: number): PaneLayout {
  if (layout.panes[index] === undefined) return layout;
  const panes = layout.panes.filter((_, i) => i !== index);
  const focused =
    layout.focusedIndex > index || layout.focusedIndex === panes.length
      ? layout.focusedIndex - 1
      : layout.focusedIndex;
  return { panes, focusedIndex: clampFocus(focused, panes.length) };
}

export function focusPane(layout: PaneLayout, index: number): PaneLayout {
  if (layout.panes[index] === undefined || layout.focusedIndex === index) return layout;
  return { ...layout, focusedIndex: index };
}

/**
 * The route changed to `ref` (sidebar click, link, history). In a split it focuses the pane that
 * shows it, or takes over the focused pane. Outside a split there is nothing to keep in step.
 */
export function followRoute(layout: PaneLayout, ref: ScopedThreadRef): PaneLayout {
  if (!isSplitLayout(layout)) return layout;
  const existing = indexOfRef(layout.panes, ref);
  if (existing !== -1) return focusPane(layout, existing);
  const target = layout.panes[layout.focusedIndex];
  if (target === undefined) return layout;
  return {
    ...layout,
    panes: layout.panes.map((pane, i) => (i === layout.focusedIndex ? { id: pane.id, ref } : pane)),
  };
}

function paneColumns(count: number): number {
  if (count <= 3) return Math.max(count, 1);
  return count === 4 ? 2 : 3;
}

/**
 * How many panes each row holds: one row up to three, then 2x2, then three across. A short last
 * row simply holds fewer, so it stretches to full width instead of leaving a hole.
 */
export function paneRowCounts(count: number): number[] {
  const columns = paneColumns(count);
  const rows = Math.max(1, Math.ceil(count / columns));
  return Array.from({ length: rows }, (_, row) =>
    row < rows - 1 ? columns : count - (rows - 1) * columns,
  );
}

/** Row heights and per-row pane widths as fractions that each sum to one. */
export interface PaneSizes {
  /** The pane count these were made for; a different count means a different grid shape. */
  readonly count: number;
  readonly rows: ReadonlyArray<number>;
  readonly cols: ReadonlyArray<ReadonlyArray<number>>;
}

const equalFractions = (n: number): number[] => Array.from({ length: n }, () => 1 / n);

export function equalPaneSizes(count: number): PaneSizes {
  const rowCounts = paneRowCounts(count);
  return { count, rows: equalFractions(rowCounts.length), cols: rowCounts.map(equalFractions) };
}

/** Sizes saved for another pane count no longer fit the grid, so they fall back to equal. */
export function resolvePaneSizes(saved: PaneSizes | null, count: number): PaneSizes {
  return saved !== null && saved.count === count ? saved : equalPaneSizes(count);
}

/** Smallest pane, in pixels, before its composer and transcript stop fitting. */
export const MIN_PANE_WIDTH_PX = 260;
export const MIN_PANE_HEIGHT_PX = 200;

/** No pane shrinks below this share of its row or column, whatever the window size. */
export const MIN_PANE_FRACTION = 0.1;

/** The smallest share a pane may take when its container is `extentPx` long and the pane `minPx`. */
export function minPaneFraction(minPx: number, extentPx: number): number {
  return extentPx > 0 ? Math.max(MIN_PANE_FRACTION, minPx / extentPx) : MIN_PANE_FRACTION;
}

/**
 * Move the boundary between `index` and `index + 1` by `delta`, keeping both at least `min`. When
 * the pair together is too small for `min`, each keeps half so the boundary can still move.
 */
export function resizeBoundary(
  fractions: ReadonlyArray<number>,
  index: number,
  delta: number,
  min: number = MIN_PANE_FRACTION,
): number[] {
  const before = fractions[index];
  const after = fractions[index + 1];
  if (before === undefined || after === undefined) return [...fractions];
  const floor = Math.min(min, (before + after) / 2);
  const low = floor - before;
  const high = after - floor;
  const applied = Math.max(low, Math.min(delta, high));
  return fractions.map((value, i) =>
    i === index ? value + applied : i === index + 1 ? value - applied : value,
  );
}

/** How close, in pixels, a divider must come to a snap point before it jumps to it. */
const SNAP_THRESHOLD_PX = 10;

/**
 * Pull `raw` (a pixel shift) onto the nearest candidate within `threshold`. Returns the shift to
 * apply and whether it snapped, so the divider can show it.
 */
export function snapShift(
  raw: number,
  candidates: ReadonlyArray<number>,
  threshold: number = SNAP_THRESHOLD_PX,
): { shift: number; snapped: boolean } {
  let best: number | null = null;
  for (const candidate of candidates) {
    if (Math.abs(candidate - raw) > threshold) continue;
    if (best === null || Math.abs(candidate - raw) < Math.abs(best - raw)) best = candidate;
  }
  return best === null ? { shift: raw, snapped: false } : { shift: best, snapped: true };
}

/** Exchange the conversations in two slots. Focus stays with the conversation, not the slot. */
export function swapPanes(layout: PaneLayout, from: number, to: number): PaneLayout {
  const a = layout.panes[from];
  const b = layout.panes[to];
  if (a === undefined || b === undefined || from === to) return layout;
  const panes = layout.panes.map((pane, i) =>
    i === from ? { id: pane.id, ref: b.ref } : i === to ? { id: pane.id, ref: a.ref } : pane,
  );
  const focusedIndex =
    layout.focusedIndex === from ? to : layout.focusedIndex === to ? from : layout.focusedIndex;
  return { panes, focusedIndex };
}
