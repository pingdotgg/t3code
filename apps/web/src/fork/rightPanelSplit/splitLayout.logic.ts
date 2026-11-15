import type { ContextMenuItem } from "@t3tools/contracts";

import type { RightPanelKind, RightPanelSurface, ThreadRightPanelState } from "~/rightPanelStore";

export type PaneSide = "left" | "right";

/**
 * `ThreadRightPanelState.split`. The left pane holds every surface not in `rightIds`, and
 * `surfaces` lists the left pane's tabs before the right pane's. The focused pane is the one
 * holding `activeSurfaceId`; `otherShownId` is the tab the other pane shows.
 */
export interface RightPanelSplit {
  readonly rightIds: readonly string[];
  readonly otherShownId: string;
  /** The left pane's share of the row. */
  readonly ratio: number;
}

export type SplitChange =
  | { type: "split"; surfaceId: string; side: PaneSide; restoreShown?: string }
  | {
      type: "move";
      surfaceId: string;
      pane: PaneSide;
      beforeId: string | null;
      restoreShown?: string;
    }
  | { type: "reorder"; surfaceId: string; beforeId: string | null }
  | { type: "unsplit" }
  | { type: "focus"; pane: PaneSide }
  | { type: "ratio"; ratio: number };

/** How a store write came about: a close and an automatic removal fall back inside the pane. */
export type SplitWriteKind = "user" | "close" | "automatic";

export const PANE_MIN_WIDTH = 220;
export const SPLITTER_WIDTH = 1;
export const SPLIT_MIN_PANEL_WIDTH = 2 * PANE_MIN_WIDTH + SPLITTER_WIDTH;
/** A new split widens a narrower panel toward this, as far as the chat column allows. */
const SPLIT_COMFORT_PANEL_WIDTH = 800;

/** The width a new split widens the panel to, or null when the panel would not grow. */
export function splitWidenTarget(width: number, maxWidth: number): number | null {
  const target = Math.min(maxWidth, SPLIT_COMFORT_PANEL_WIDTH);
  return target > width ? target : null;
}

/** The width an ended split gives back: only while the panel still has the width it set. */
export function widthToGiveBack(
  currentWidth: number,
  widened: { readonly before: number; readonly set: number },
): number | null {
  return currentWidth === widened.set ? widened.before : null;
}
export const SPLIT_RATIO_MIN = 0.2;
export const SPLIT_RATIO_MAX = 0.8;
export const SPLIT_RATIO_DEFAULT = 0.5;

/** A user choice bumps the action revision: it requests focus and refuses pending proactive opens. */
const USER_SPLIT_CHANGES: Record<SplitChange["type"], boolean> = {
  split: true,
  move: true,
  unsplit: true,
  reorder: false,
  focus: false,
  ratio: false,
};

export function isUserSplitChange(change: SplitChange): boolean {
  return USER_SPLIT_CHANGES[change.type];
}

export interface PanelArrangement {
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurfaceId: string | null;
  readonly split?: RightPanelSplit | undefined;
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return SPLIT_RATIO_DEFAULT;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

function withoutSplit<T extends PanelArrangement>(state: T): T {
  if (state.split === undefined) return state;
  const { split: _split, ...rest } = state;
  return rest as T;
}

function sideOf(right: ReadonlySet<string>, id: string | null): PaneSide {
  return id !== null && right.has(id) ? "right" : "left";
}

function otherSide(side: PaneSide): PaneSide {
  return side === "left" ? "right" : "left";
}

function paneSurfaces(
  surfaces: readonly RightPanelSurface[],
  right: ReadonlySet<string>,
  side: PaneSide,
): RightPanelSurface[] {
  return surfaces.filter((surface) => right.has(surface.id) === (side === "right"));
}

function neighbourOf(
  before: readonly RightPanelSurface[],
  after: readonly RightPanelSurface[],
  id: string,
): string | null {
  if (after.length === 0) return null;
  const index = Math.max(
    0,
    before.findIndex((surface) => surface.id === id),
  );
  return after[Math.min(index, after.length - 1)]!.id;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Builds a valid two-pane state. Both panes must be non-empty. Returns `next` itself when it
 * already is that state, so the store's unchanged-record check holds.
 */
function withPanes<T extends PanelArrangement>(
  next: T,
  right: ReadonlySet<string>,
  activeSurfaceId: string | null,
  otherShownCandidate: string | null,
  ratio: number,
): T {
  const left = paneSurfaces(next.surfaces, right, "left");
  const rightSurfaces = paneSurfaces(next.surfaces, right, "right");
  const focused = sideOf(right, activeSurfaceId);
  const other = focused === "left" ? rightSurfaces : left;
  const otherShownId = other.some((surface) => surface.id === otherShownCandidate)
    ? otherShownCandidate!
    : other[0]!.id;
  const surfaces = [...left, ...rightSurfaces];
  const rightIds = rightSurfaces.map((surface) => surface.id);
  const clamped = clampSplitRatio(ratio);
  const sameSurfaces = surfaces.every((surface, index) => surface === next.surfaces[index]);
  const current = next.split;
  const sameSplit =
    current !== undefined &&
    current.otherShownId === otherShownId &&
    current.ratio === clamped &&
    sameIds(current.rightIds, rightIds);
  if (sameSurfaces && sameSplit && activeSurfaceId === next.activeSurfaceId) return next;
  return {
    ...next,
    surfaces: sameSurfaces ? next.surfaces : surfaces,
    activeSurfaceId,
    split: sameSplit ? current : { rightIds, otherShownId, ratio: clamped },
  };
}

/** Repairs a split against its own surfaces: dangling ids, an empty pane, order, ratio. */
function normalizeSplit<T extends PanelArrangement>(state: T): T {
  const split = state.split;
  if (split === undefined) return state;
  const present = new Set<string>(state.surfaces.map((surface) => surface.id));
  const right = new Set(split.rightIds.filter((id) => present.has(id)));
  if (right.size === 0 || right.size === present.size) return withoutSplit(state);
  return withPanes(state, right, state.activeSurfaceId, split.otherShownId, split.ratio);
}

/**
 * Keeps a split valid across a pane-blind store write (`prev` to `next`). A write that set
 * `split` itself is only repaired. A thread without a split passes through by reference.
 */
export function reconcileSplit<T extends PanelArrangement>(
  prev: PanelArrangement,
  next: T,
  kind: SplitWriteKind,
): T {
  const split = next.split;
  if (split === undefined) return next;
  if (split !== prev.split) return normalizeSplit(next);

  const before = new Set(split.rightIds);
  const prevIds = new Set<string>(prev.surfaces.map((surface) => surface.id));
  const nextIds = new Set<string>(next.surfaces.map((surface) => surface.id));
  const prevFocus = sideOf(before, prev.activeSurfaceId);
  const kept = (side: PaneSide) =>
    next.surfaces.some(
      (surface) => prevIds.has(surface.id) && before.has(surface.id) === (side === "right"),
    );
  const added = next.surfaces.some((surface) => !prevIds.has(surface.id));
  // A replacement that empties a pane (an explorer turning into a file) refills that pane.
  const target =
    added && kept("left") !== kept("right") ? (kept("left") ? "right" : "left") : prevFocus;
  const right = new Set<string>(
    next.surfaces
      .filter((surface) => (prevIds.has(surface.id) ? before.has(surface.id) : target === "right"))
      .map((surface) => surface.id),
  );
  const prevShown = (side: PaneSide) =>
    side === prevFocus ? prev.activeSurfaceId : split.otherShownId;

  if (right.size === 0 || right.size === nextIds.size) {
    const collapsed = withoutSplit(next);
    if (kind === "user") return collapsed;
    const shown = prevShown(right.size === 0 ? "left" : "right");
    return shown !== null && nextIds.has(shown) && shown !== collapsed.activeSurfaceId
      ? { ...collapsed, activeSurfaceId: shown }
      : collapsed;
  }

  let activeSurfaceId = next.activeSurfaceId;
  const prevActive = prev.activeSurfaceId;
  if (kind !== "user" && prevActive !== null && !nextIds.has(prevActive)) {
    activeSurfaceId = neighbourOf(
      paneSurfaces(prev.surfaces, before, prevFocus),
      paneSurfaces(next.surfaces, right, prevFocus),
      prevActive,
    );
  }

  const nextFocus = sideOf(right, activeSurfaceId);
  let otherShown: string | null;
  if (nextFocus !== prevFocus) {
    otherShown = prevActive;
  } else if (nextIds.has(split.otherShownId)) {
    otherShown = split.otherShownId;
  } else {
    const side = otherSide(prevFocus);
    otherShown = neighbourOf(
      paneSurfaces(prev.surfaces, before, side),
      paneSurfaces(next.surfaces, right, side),
      split.otherShownId,
    );
  }
  return withPanes(next, right, activeSurfaceId, otherShown, split.ratio);
}

function moved(
  surfaces: readonly RightPanelSurface[],
  surface: RightPanelSurface,
  beforeId: string | null,
): RightPanelSurface[] {
  const rest = surfaces.filter((entry) => entry.id !== surface.id);
  const index = beforeId === null ? -1 : rest.findIndex((entry) => entry.id === beforeId);
  return index < 0 ? [...rest, surface] : [...rest.slice(0, index), surface, ...rest.slice(index)];
}

/** The reducer behind `updateSplit`. Ids, never indices: a stale command is a no-op. */
export function applySplitChange<T extends PanelArrangement>(thread: T, change: SplitChange): T {
  const split = thread.split;
  const right = new Set(split?.rightIds ?? []);
  switch (change.type) {
    case "split": {
      if (split !== undefined || thread.surfaces.length < 2) return thread;
      const others = thread.surfaces.filter((surface) => surface.id !== change.surfaceId);
      if (others.length === thread.surfaces.length) return thread;
      const restore = change.restoreShown ?? thread.activeSurfaceId;
      const shown = others.some((surface) => surface.id === restore)
        ? restore
        : neighbourOf(thread.surfaces, others, change.surfaceId);
      const nextRight = new Set<string>(
        change.side === "right" ? [change.surfaceId] : others.map((surface) => surface.id),
      );
      return withPanes(thread, nextRight, change.surfaceId, shown, SPLIT_RATIO_DEFAULT);
    }
    case "move": {
      if (split === undefined) return thread;
      const surface = thread.surfaces.find((entry) => entry.id === change.surfaceId);
      if (!surface) return thread;
      const from = sideOf(right, surface.id);
      if (from === change.pane) {
        return applySplitChange(thread, {
          type: "reorder",
          surfaceId: change.surfaceId,
          beforeId: change.beforeId,
        });
      }
      const beforeId =
        change.beforeId !== null && sideOf(right, change.beforeId) === change.pane
          ? change.beforeId
          : null;
      const surfaces = moved(thread.surfaces, surface, beforeId);
      const nextRight = new Set(right);
      if (change.pane === "right") nextRight.add(surface.id);
      else nextRight.delete(surface.id);
      const sourceBefore = paneSurfaces(thread.surfaces, right, from);
      const sourceAfter = paneSurfaces(surfaces, nextRight, from);
      if (sourceAfter.length === 0) {
        return withoutSplit({ ...thread, surfaces, activeSurfaceId: surface.id });
      }
      const prevFocus = sideOf(right, thread.activeSurfaceId);
      const sourceShown = from === prevFocus ? thread.activeSurfaceId : split.otherShownId;
      const shown = [change.restoreShown, sourceShown].find((id) =>
        sourceAfter.some((entry) => entry.id === id),
      );
      return withPanes(
        { ...thread, surfaces },
        nextRight,
        surface.id,
        shown ?? neighbourOf(sourceBefore, sourceAfter, surface.id),
        split.ratio,
      );
    }
    case "reorder": {
      const surface = thread.surfaces.find((entry) => entry.id === change.surfaceId);
      if (!surface) return thread;
      const beforeId =
        change.beforeId !== null && sideOf(right, change.beforeId) === sideOf(right, surface.id)
          ? change.beforeId
          : null;
      const surfaces =
        beforeId === null && split !== undefined && !right.has(surface.id)
          ? moved(
              thread.surfaces,
              surface,
              thread.surfaces.find((entry) => right.has(entry.id))?.id ?? null,
            )
          : moved(thread.surfaces, surface, beforeId);
      if (surfaces.every((entry, index) => entry === thread.surfaces[index])) return thread;
      if (split === undefined) return { ...thread, surfaces };
      return withPanes(
        { ...thread, surfaces },
        right,
        thread.activeSurfaceId,
        split.otherShownId,
        split.ratio,
      );
    }
    case "unsplit":
      return withoutSplit(thread);
    case "focus": {
      if (split === undefined || sideOf(right, thread.activeSurfaceId) === change.pane) {
        return thread;
      }
      return withPanes(thread, right, split.otherShownId, thread.activeSurfaceId, split.ratio);
    }
    case "ratio": {
      if (split === undefined) return thread;
      const ratio = clampSplitRatio(change.ratio);
      return ratio === split.ratio ? thread : { ...thread, split: { ...split, ratio } };
    }
  }
}

/** Hydrate boundary: parses a persisted `split`, then repairs it, or drops it. */
export function restorePersistedSplit<T extends PanelArrangement>(record: T, rawSplit: unknown): T {
  const base = withoutSplit(record);
  if (!rawSplit || typeof rawSplit !== "object" || !Array.isArray(base.surfaces)) return base;
  const { rightIds, otherShownId, ratio } = rawSplit as Record<string, unknown>;
  if (!Array.isArray(rightIds) || typeof otherShownId !== "string") return base;
  return normalizeSplit({
    ...base,
    split: {
      rightIds: rightIds.filter((id): id is string => typeof id === "string"),
      otherShownId,
      ratio: typeof ratio === "number" ? ratio : SPLIT_RATIO_DEFAULT,
    },
  });
}

/** The migration's hook: the split, and the order it needs, for a record rebuilt from storage. */
export function persistedSplitFields(
  record: { readonly surfaces: RightPanelSurface[]; readonly activeSurfaceId: string | null },
  rawSplit: unknown,
): Partial<Pick<ThreadRightPanelState, "split" | "surfaces">> {
  const restored = restorePersistedSplit<
    Pick<ThreadRightPanelState, "surfaces" | "activeSurfaceId" | "split">
  >(record, rawSplit);
  return restored.split === undefined ? {} : { split: restored.split, surfaces: restored.surfaces };
}

/** zustand's `merge`: a same-version load skips `migrate`, so it repairs splits here too. */
export function mergePersistedRightPanelState<
  S extends { byThreadKey: Record<string, ThreadRightPanelState> },
>(persisted: unknown, current: S): S {
  const merged: S = { ...current, ...(persisted as Partial<S>) };
  if (!merged.byThreadKey || typeof merged.byThreadKey !== "object") return merged;
  return {
    ...merged,
    byThreadKey: Object.fromEntries(
      Object.entries(merged.byThreadKey).map(([threadKey, record]) => [
        threadKey,
        record && typeof record === "object" && "split" in record
          ? restorePersistedSplit(record, record.split)
          : record,
      ]),
    ),
  };
}

interface PaneView {
  readonly side: PaneSide;
  readonly surfaces: readonly RightPanelSurface[];
  readonly shown: RightPanelSurface;
}

type PaneLayout =
  | { readonly kind: "single" }
  | {
      readonly kind: "split";
      readonly left: PaneView;
      readonly right: PaneView;
      readonly focused: PaneSide;
      readonly ratio: number;
    };

const SINGLE: PaneLayout = { kind: "single" };

/** Total: a split that does not fit the given surfaces reads as one pane. */
export function paneLayout(arrangement: PanelArrangement): PaneLayout {
  const split = arrangement.split;
  if (split === undefined) return SINGLE;
  const right = new Set(split.rightIds);
  const focused = sideOf(right, arrangement.activeSurfaceId);
  const view = (side: PaneSide): PaneView | null => {
    const surfaces = paneSurfaces(arrangement.surfaces, right, side);
    const shownId = side === focused ? arrangement.activeSurfaceId : split.otherShownId;
    const shown = surfaces.find((surface) => surface.id === shownId) ?? surfaces[0];
    return shown === undefined ? null : { side, surfaces, shown };
  };
  const left = view("left");
  const rightView = view("right");
  if (left === null || rightView === null) return SINGLE;
  return { kind: "split", left, right: rightView, focused, ratio: clampSplitRatio(split.ratio) };
}

export function paneOf(arrangement: PanelArrangement, surfaceId: string): PaneSide {
  return arrangement.split?.rightIds.includes(surfaceId) ? "right" : "left";
}

/** What the pane the user is not working in shows, or null without a split. */
export function unfocusedPaneSurface(arrangement: PanelArrangement): RightPanelSurface | null {
  const layout = paneLayout(arrangement);
  if (layout.kind === "single") return null;
  return layout.focused === "left" ? layout.right.shown : layout.left.shown;
}

/** Kinds an open panel shows in either pane; an automatic open must not replace them. */
export function shownPanelKinds(thread: ThreadRightPanelState): RightPanelKind[] {
  if (!thread.isOpen) return [];
  const active = thread.surfaces.find((surface) => surface.id === thread.activeSurfaceId);
  return [active, unfocusedPaneSurface(thread)].flatMap((surface) =>
    surface ? [surface.kind] : [],
  );
}

export type SplitMenuAction = "split-right" | "split-left" | "move-to-other-pane" | "unsplit";

/** The tab menu's split entries, the non-drag path to every layout change. */
export function splitMenuItems(
  arrangement: PanelArrangement,
  surfaceId: string,
  view: { readonly splitAllowed: boolean; readonly splitRendered: boolean },
): ContextMenuItem<SplitMenuAction>[] {
  if (arrangement.split === undefined) {
    if (!view.splitAllowed || arrangement.surfaces.length < 2) return [];
    return [
      { id: "split-right", label: "Split right", separatorBefore: true },
      { id: "split-left", label: "Split left" },
    ];
  }
  const unsplit: ContextMenuItem<SplitMenuAction> = { id: "unsplit", label: "Unsplit" };
  if (!view.splitRendered) return [{ ...unsplit, separatorBefore: true }];
  const label =
    paneOf(arrangement, surfaceId) === "left" ? "Move to the right pane" : "Move to the left pane";
  return [{ id: "move-to-other-pane", label, separatorBefore: true }, unsplit];
}

export function splitMenuChange(
  action: SplitMenuAction,
  arrangement: PanelArrangement,
  surfaceId: string,
): SplitChange {
  switch (action) {
    case "split-right":
      return { type: "split", surfaceId, side: "right" };
    case "split-left":
      return { type: "split", surfaceId, side: "left" };
    case "move-to-other-pane":
      return {
        type: "move",
        surfaceId,
        pane: otherSide(paneOf(arrangement, surfaceId)),
        beforeId: null,
      };
    case "unsplit":
      return { type: "unsplit" };
  }
}
