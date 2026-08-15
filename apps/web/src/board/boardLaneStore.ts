import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

const BOARD_LANE_STORAGE_KEY = "t3code:board-lanes:v1";
const BOARD_LANE_STORAGE_VERSION = 5;

export const BOARD_LANE_MIN_WIDTH = 260;
export const BOARD_LANE_MAX_WIDTH = 1316;
export const BOARD_LANE_DEFAULT_WIDTH = 380;

export type BoardLaneId = string;

export const TRIAGE_BOARD_LANE_ID = "triage";
export const SNOOZED_BOARD_LANE_ID = "snoozed";
export const SETTLED_BOARD_LANE_ID = "settled";

export const FIXED_BOARD_LANE_IDS = Object.freeze([
  TRIAGE_BOARD_LANE_ID,
  SNOOZED_BOARD_LANE_ID,
  SETTLED_BOARD_LANE_ID,
] as const);

export const LIFECYCLE_BOARD_LANE_IDS = Object.freeze([
  SNOOZED_BOARD_LANE_ID,
  SETTLED_BOARD_LANE_ID,
] as const);

/**
 * A board lane belongs to the client surface, not to an environment. This is
 * intentionally a small local shape rather than an orchestration contract:
 * connected servers contribute sessions, while this browser or desktop window
 * decides where those sessions sit.
 */
export interface BoardLane {
  readonly id: BoardLaneId;
  readonly name: string;
  readonly description: string;
  readonly order: number;
}

const FIXED_BOARD_LANES = Object.freeze({
  [TRIAGE_BOARD_LANE_ID]: {
    id: TRIAGE_BOARD_LANE_ID,
    name: "Triage",
    description: "New and unplaced sessions start here",
    order: 0,
  },
  [SNOOZED_BOARD_LANE_ID]: {
    id: SNOOZED_BOARD_LANE_ID,
    name: "Snoozed",
    description: "Sessions hidden until their wake time",
    order: 5,
  },
  [SETTLED_BOARD_LANE_ID]: {
    id: SETTLED_BOARD_LANE_ID,
    name: "Settled",
    description: "Finished sessions kept as quiet history",
    order: 6,
  },
} satisfies Record<(typeof FIXED_BOARD_LANE_IDS)[number], BoardLane>);

export const DEFAULT_BOARD_LANES: ReadonlyArray<BoardLane> = Object.freeze([
  FIXED_BOARD_LANES[TRIAGE_BOARD_LANE_ID],
  {
    id: "blocked",
    name: "Blocked",
    description: "Waiting on something before work can continue",
    order: 1,
  },
  {
    id: "ready",
    name: "Ready",
    description: "Ready to start",
    order: 2,
  },
  {
    id: "in-progress",
    name: "In Progress",
    description: "Work currently underway",
    order: 3,
  },
  {
    id: "review",
    name: "Review",
    description: "Ready for review and final checks",
    order: 4,
  },
  FIXED_BOARD_LANES[SNOOZED_BOARD_LANE_ID],
  FIXED_BOARD_LANES[SETTLED_BOARD_LANE_ID],
]);

const LEGACY_DEFAULT_BOARD_LANES: ReadonlyArray<BoardLane> = Object.freeze([
  {
    id: "triage",
    name: "Triage",
    description: "New and unplaced sessions start here until you file them elsewhere",
    order: -1,
  },
  {
    id: "shaping",
    name: "Grilling / shaping",
    description: "Working out what this actually is",
    order: 0,
  },
  {
    id: "ready",
    name: "Ready",
    description: "Groomed and ready to pick up",
    order: 1,
  },
  {
    id: "done",
    name: "Done",
    description: "Finished work you want to keep visible on this board",
    order: 2,
  },
]);

const LEGACY_LIFECYCLE_BOARD_LANES: ReadonlyArray<BoardLane> = Object.freeze([
  {
    id: "settled",
    name: "Settled",
    description: "Sessions you want to keep parked as settled on this board",
    order: 3,
  },
  {
    id: "snoozed",
    name: "Snoozed",
    description: "Sessions you want to revisit later on this board",
    order: 4,
  },
]);

const LEGACY_DEFAULT_WORKFLOW_LANE_REPLACEMENTS: Readonly<Record<string, BoardLaneId>> = {
  shaping: "in-progress",
  done: "review",
};

export interface BoardLaneState {
  readonly widthPx: number;
}

export interface BoardLaneEntryState {
  readonly laneId: BoardLaneId;
  readonly enteredAt: string;
}

export interface BoardLaneDraft {
  readonly name: string;
  readonly description: string;
  readonly order: number;
}

export type BoardOrganization =
  | {
      readonly columns: "workflow";
      readonly rows: "project" | "state" | "none";
    }
  | {
      readonly columns: "state";
      readonly rows: "project" | "none";
    };

export type BoardOrganizationColumns = BoardOrganization["columns"];
export type BoardOrganizationRows = BoardOrganization["rows"];

export const DEFAULT_BOARD_ORGANIZATION: BoardOrganization = Object.freeze({
  columns: "workflow",
  rows: "project",
});

interface BoardLaneStoreState {
  readonly lanes: ReadonlyArray<BoardLane>;
  /**
   * `undefined` means a session has never been placed and therefore falls
   * into Triage. Lifecycle lanes are derived from server state and are never
   * persisted here. Keys are scoped so two environments may both contribute
   * `thread-1`.
   */
  readonly placementByThreadKey: Record<string, BoardLaneId>;
  /** Displayed lane arrivals, including derived lifecycle transitions. */
  readonly laneEntryByThreadKey: Record<string, BoardLaneEntryState>;
  /** Complete user-authored sequences. New arrivals not in a sequence sort above it. */
  readonly orderByLaneId: Record<BoardLaneId, ReadonlyArray<string>>;
  readonly byLaneColumnKey: Record<string, BoardLaneState>;
  readonly collapsedLifecycleLaneIds: ReadonlyArray<BoardLaneId>;
  readonly organization: BoardOrganization;
  readonly setPlacement: (ref: ScopedThreadRef, laneId: BoardLaneId) => void;
  readonly recordLaneEntry: (ref: ScopedThreadRef, laneId: BoardLaneId, enteredAt?: string) => void;
  readonly setLaneOrder: (laneId: BoardLaneId, orderedThreadKeys: ReadonlyArray<string>) => void;
  readonly createLane: (lane: BoardLane) => void;
  readonly updateLane: (laneId: BoardLaneId, draft: BoardLaneDraft) => void;
  readonly archiveLane: (laneId: BoardLaneId) => void;
  readonly setWidth: (laneColumnKey: string, widthPx: number) => void;
  readonly removeLane: (laneColumnKey: string) => void;
  readonly toggleLifecycleLaneCollapsed: (laneId: BoardLaneId) => void;
  readonly setOrganizationColumns: (columns: BoardOrganizationColumns) => void;
  readonly setOrganizationRows: (rows: BoardOrganizationRows) => void;
}

export function clampBoardLaneWidth(widthPx: number): number {
  if (!Number.isFinite(widthPx)) return BOARD_LANE_DEFAULT_WIDTH;
  return Math.min(BOARD_LANE_MAX_WIDTH, Math.max(BOARD_LANE_MIN_WIDTH, Math.round(widthPx)));
}

function isFixedBoardLaneId(laneId: BoardLaneId): laneId is (typeof FIXED_BOARD_LANE_IDS)[number] {
  return FIXED_BOARD_LANE_IDS.some((fixedLaneId) => fixedLaneId === laneId);
}

function isLifecycleBoardLaneId(
  laneId: BoardLaneId,
): laneId is (typeof LIFECYCLE_BOARD_LANE_IDS)[number] {
  return LIFECYCLE_BOARD_LANE_IDS.some((lifecycleLaneId) => lifecycleLaneId === laneId);
}

function isSameLane(left: BoardLane, right: BoardLane): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.description === right.description &&
    left.order === right.order
  );
}

function isUntouchedLegacyDefaultLanes(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const entries = value.filter(
    (entry): entry is BoardLane => typeof entry === "object" && entry !== null,
  );
  const allowed = [...LEGACY_DEFAULT_BOARD_LANES, ...LEGACY_LIFECYCLE_BOARD_LANES];
  if (
    entries.length < LEGACY_DEFAULT_BOARD_LANES.length ||
    entries.length > allowed.length ||
    new Set(entries.map((lane) => lane.id)).size !== entries.length
  ) {
    return false;
  }
  return (
    LEGACY_DEFAULT_BOARD_LANES.every((legacyLane) =>
      entries.some((lane) => isSameLane(lane, legacyLane)),
    ) && entries.every((lane) => allowed.some((legacyLane) => isSameLane(lane, legacyLane)))
  );
}

function remapLegacyDefaultLaneId(value: unknown): unknown {
  return typeof value === "string"
    ? (LEGACY_DEFAULT_WORKFLOW_LANE_REPLACEMENTS[value] ?? value)
    : value;
}

function remapLegacyDefaultPlacement(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([threadKey, laneId]) => [
      threadKey,
      remapLegacyDefaultLaneId(laneId),
    ]),
  );
}

function remapLegacyDefaultLaneEntries(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([threadKey, entry]) => {
      if (typeof entry !== "object" || entry === null) return [threadKey, entry];
      const laneEntry = entry as Record<string, unknown>;
      return [threadKey, { ...laneEntry, laneId: remapLegacyDefaultLaneId(laneEntry.laneId) }];
    }),
  );
}

function remapLegacyDefaultLaneKeyedState(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const remapped: Record<string, unknown> = {};
  for (const [laneId, laneState] of Object.entries(value as Record<string, unknown>)) {
    const targetLaneId = remapLegacyDefaultLaneId(laneId);
    if (typeof targetLaneId !== "string") continue;
    const current = remapped[targetLaneId];
    remapped[targetLaneId] =
      Array.isArray(current) && Array.isArray(laneState)
        ? [...new Set([...current, ...laneState])]
        : laneState;
  }
  return remapped;
}

function normalizeLanes(value: unknown): ReadonlyArray<BoardLane> {
  if (!Array.isArray(value)) return DEFAULT_BOARD_LANES;
  if (isUntouchedLegacyDefaultLanes(value)) return DEFAULT_BOARD_LANES;
  const workflowLanes: BoardLane[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, name, description, order } = entry as Partial<BoardLane>;
    if (
      typeof id !== "string" ||
      id.trim() === "" ||
      ids.has(id) ||
      typeof name !== "string" ||
      name.trim() === "" ||
      typeof description !== "string" ||
      description.trim() === "" ||
      typeof order !== "number" ||
      !Number.isFinite(order)
    ) {
      continue;
    }
    ids.add(id);
    if (!isFixedBoardLaneId(id)) workflowLanes.push({ id, name, description, order });
  }
  if (ids.size === 0) return DEFAULT_BOARD_LANES;
  return [
    FIXED_BOARD_LANES[TRIAGE_BOARD_LANE_ID],
    ...workflowLanes,
    FIXED_BOARD_LANES[SNOOZED_BOARD_LANE_ID],
    FIXED_BOARD_LANES[SETTLED_BOARD_LANE_ID],
  ];
}

function normalizePlacementByThreadKey(
  value: unknown,
  lanes: ReadonlyArray<BoardLane>,
): Record<string, BoardLaneId> {
  if (typeof value !== "object" || value === null) return {};
  const workflowLaneIds = new Set(
    lanes.filter((lane) => !isLifecycleBoardLaneId(lane.id)).map((lane) => lane.id),
  );
  const placementByThreadKey: Record<string, BoardLaneId> = {};
  for (const [threadKey, laneId] of Object.entries(value as Record<string, unknown>)) {
    if (typeof laneId === "string" && workflowLaneIds.has(laneId)) {
      placementByThreadKey[threadKey] = laneId;
    }
  }
  return placementByThreadKey;
}

function normalizeCollapsedLifecycleLaneIds(value: unknown): ReadonlyArray<BoardLaneId> {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (laneId): laneId is (typeof LIFECYCLE_BOARD_LANE_IDS)[number] =>
          typeof laneId === "string" && isLifecycleBoardLaneId(laneId),
      ),
    ),
  ];
}

function normalizeLaneEntryByThreadKey(value: unknown): Record<string, BoardLaneEntryState> {
  if (typeof value !== "object" || value === null) return {};
  const laneEntryByThreadKey: Record<string, BoardLaneEntryState> = {};
  for (const [threadKey, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { laneId, enteredAt } = entry as Partial<BoardLaneEntryState>;
    if (
      typeof laneId === "string" &&
      laneId.length > 0 &&
      typeof enteredAt === "string" &&
      Number.isFinite(Date.parse(enteredAt))
    ) {
      laneEntryByThreadKey[threadKey] = { laneId, enteredAt };
    }
  }
  return laneEntryByThreadKey;
}

function normalizeOrderByLaneId(value: unknown): Record<BoardLaneId, ReadonlyArray<string>> {
  if (typeof value !== "object" || value === null) return {};
  const orderByLaneId: Record<BoardLaneId, ReadonlyArray<string>> = {};
  for (const [laneId, order] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(order)) continue;
    orderByLaneId[laneId] = [
      ...new Set(order.filter((threadKey): threadKey is string => typeof threadKey === "string")),
    ];
  }
  return orderByLaneId;
}

function withoutThreadKey(
  orderByLaneId: Record<BoardLaneId, ReadonlyArray<string>>,
  threadKey: string,
): Record<BoardLaneId, ReadonlyArray<string>> {
  let changed = false;
  const next: Record<BoardLaneId, ReadonlyArray<string>> = {};
  for (const [laneId, order] of Object.entries(orderByLaneId)) {
    const filtered = order.filter((key) => key !== threadKey);
    if (filtered.length !== order.length) changed = true;
    if (filtered.length > 0) next[laneId] = filtered;
  }
  return changed ? next : orderByLaneId;
}

function normalizePersistedByLaneColumnKey(
  persistedState: unknown,
): Record<string, BoardLaneState> {
  if (typeof persistedState !== "object" || persistedState === null) return {};
  const source = (persistedState as { byLaneColumnKey?: unknown }).byLaneColumnKey;
  if (typeof source !== "object" || source === null) return {};
  const byLaneColumnKey: Record<string, BoardLaneState> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const width = (value as { widthPx?: unknown } | null)?.widthPx;
    if (typeof width === "number") byLaneColumnKey[key] = { widthPx: clampBoardLaneWidth(width) };
  }
  return byLaneColumnKey;
}

function normalizeBoardOrganization(value: unknown): BoardOrganization {
  if (typeof value !== "object" || value === null) return DEFAULT_BOARD_ORGANIZATION;
  const { columns, rows } = value as Partial<Record<keyof BoardOrganization, unknown>>;
  if (columns === "workflow" && (rows === "project" || rows === "state" || rows === "none")) {
    return { columns, rows };
  }
  if (columns === "state" && (rows === "project" || rows === "none")) {
    return { columns, rows };
  }
  return DEFAULT_BOARD_ORGANIZATION;
}

/**
 * The pre-local-board store only held column widths and an environment picker.
 * Preserve the harmless presentation preferences but intentionally discard the
 * picker and all server-owned lane placement state; importing either would
 * make this client surface look authoritative over another environment.
 */
function migrateBoardLaneState(persistedState: unknown, version: number): unknown {
  if (version >= BOARD_LANE_STORAGE_VERSION) return persistedState;
  const legacy = persistedState as {
    lanes?: unknown;
    placementByThreadKey?: unknown;
    laneEntryByThreadKey?: unknown;
    orderByLaneId?: unknown;
    groupByProject?: unknown;
    byLaneColumnKey?: unknown;
  } | null;
  const versionTwoState =
    version < 2
      ? {
          lanes: DEFAULT_BOARD_LANES,
          placementByThreadKey: {},
          byLaneColumnKey: legacy?.byLaneColumnKey,
          groupByProject: legacy?.groupByProject,
        }
      : legacy;
  const versionThreeState =
    version < 3
      ? {
          ...versionTwoState,
          laneEntryByThreadKey: {},
          orderByLaneId: {},
        }
      : versionTwoState;
  const versionFourState =
    version >= 4
      ? versionThreeState
      : !isUntouchedLegacyDefaultLanes(versionThreeState?.lanes)
        ? { ...versionThreeState, collapsedLifecycleLaneIds: [] }
        : {
            ...versionThreeState,
            lanes: DEFAULT_BOARD_LANES,
            placementByThreadKey: remapLegacyDefaultPlacement(
              versionThreeState?.placementByThreadKey,
            ),
            laneEntryByThreadKey: remapLegacyDefaultLaneEntries(
              versionThreeState?.laneEntryByThreadKey,
            ),
            orderByLaneId: remapLegacyDefaultLaneKeyedState(versionThreeState?.orderByLaneId),
            byLaneColumnKey: remapLegacyDefaultLaneKeyedState(versionThreeState?.byLaneColumnKey),
            collapsedLifecycleLaneIds: [],
          };
  const { groupByProject, ...versionFiveState } = versionFourState ?? {};
  return {
    ...versionFiveState,
    organization: {
      columns: "workflow",
      rows: groupByProject === false ? "none" : "project",
    },
  };
}

export interface BoardLaneOrderedEntry {
  readonly key: string;
  readonly laneId: BoardLaneId;
  readonly createdAt: string;
}

/**
 * Stable card order for every lane. Unknown entries are new arrivals and sit
 * above the last manual sequence; otherwise lane-entry time (or creation time
 * for implicit placement) is the default. Runtime activity never participates.
 */
export function orderBoardLaneEntries<T extends BoardLaneOrderedEntry>(
  entries: ReadonlyArray<T>,
  laneEntryByThreadKey: Readonly<Record<string, BoardLaneEntryState>>,
  orderByLaneId: Readonly<Record<BoardLaneId, ReadonlyArray<string>>>,
): ReadonlyArray<T> {
  const indexByLaneId = new Map<string, ReadonlyMap<string, number>>();
  for (const [laneId, order] of Object.entries(orderByLaneId)) {
    indexByLaneId.set(laneId, new Map(order.map((threadKey, index) => [threadKey, index])));
  }

  return entries.toSorted((left, right) => {
    const laneComparison = left.laneId.localeCompare(right.laneId);
    if (laneComparison !== 0) return laneComparison;

    const manualOrder = indexByLaneId.get(left.laneId);
    const leftIndex = manualOrder?.get(left.key);
    const rightIndex = manualOrder?.get(right.key);
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
    if (leftIndex === undefined && rightIndex !== undefined) return -1;
    if (leftIndex !== undefined && rightIndex === undefined) return 1;

    const leftEntry = laneEntryByThreadKey[left.key];
    const rightEntry = laneEntryByThreadKey[right.key];
    const leftEnteredAt = leftEntry?.laneId === left.laneId ? leftEntry.enteredAt : left.createdAt;
    const rightEnteredAt =
      rightEntry?.laneId === right.laneId ? rightEntry.enteredAt : right.createdAt;
    return rightEnteredAt.localeCompare(leftEnteredAt) || left.key.localeCompare(right.key);
  });
}

export const useBoardLaneStore = create<BoardLaneStoreState>()(
  persist(
    (set) => ({
      lanes: DEFAULT_BOARD_LANES,
      placementByThreadKey: {},
      laneEntryByThreadKey: {},
      orderByLaneId: {},
      byLaneColumnKey: {},
      collapsedLifecycleLaneIds: [],
      organization: DEFAULT_BOARD_ORGANIZATION,
      setPlacement: (ref, laneId) =>
        set((state) => {
          if (isLifecycleBoardLaneId(laneId) || !state.lanes.some((lane) => lane.id === laneId)) {
            return state;
          }
          const threadKey = scopedThreadKey(ref);
          if (state.placementByThreadKey[threadKey] === laneId) return state;
          return {
            placementByThreadKey: {
              ...state.placementByThreadKey,
              [threadKey]: laneId,
            },
            laneEntryByThreadKey: {
              ...state.laneEntryByThreadKey,
              [threadKey]: { laneId, enteredAt: new Date().toISOString() },
            },
            orderByLaneId: withoutThreadKey(state.orderByLaneId, threadKey),
          };
        }),
      recordLaneEntry: (ref, laneId, enteredAt) =>
        set((state) => {
          if (!state.lanes.some((lane) => lane.id === laneId)) return state;
          const threadKey = scopedThreadKey(ref);
          if (state.laneEntryByThreadKey[threadKey]?.laneId === laneId) return state;
          const timestamp =
            enteredAt !== undefined && Number.isFinite(Date.parse(enteredAt))
              ? enteredAt
              : new Date().toISOString();
          return {
            laneEntryByThreadKey: {
              ...state.laneEntryByThreadKey,
              [threadKey]: { laneId, enteredAt: timestamp },
            },
            orderByLaneId: withoutThreadKey(state.orderByLaneId, threadKey),
          };
        }),
      setLaneOrder: (laneId, orderedThreadKeys) =>
        set((state) => {
          const order = [...new Set(orderedThreadKeys)];
          const current = state.orderByLaneId[laneId] ?? [];
          if (
            current.length === order.length &&
            current.every((key, index) => key === order[index])
          ) {
            return state;
          }
          return { orderByLaneId: { ...state.orderByLaneId, [laneId]: order } };
        }),
      createLane: (lane) =>
        set((state) => {
          if (state.lanes.some((existing) => existing.id === lane.id)) return state;
          return { lanes: [...state.lanes, lane] };
        }),
      updateLane: (laneId, draft) =>
        set((state) => {
          if (isFixedBoardLaneId(laneId)) return state;
          let changed = false;
          const lanes = state.lanes.map((lane) => {
            if (lane.id !== laneId) return lane;
            changed =
              lane.name !== draft.name ||
              lane.description !== draft.description ||
              lane.order !== draft.order;
            return changed ? { ...lane, ...draft } : lane;
          });
          return changed ? { lanes } : state;
        }),
      archiveLane: (laneId) =>
        set((state) => {
          if (isFixedBoardLaneId(laneId) || !state.lanes.some((lane) => lane.id === laneId)) {
            return state;
          }
          const lanes = state.lanes.filter((lane) => lane.id !== laneId);
          const placementByThreadKey = { ...state.placementByThreadKey };
          const laneEntryByThreadKey = { ...state.laneEntryByThreadKey };
          for (const [threadKey, placement] of Object.entries(placementByThreadKey)) {
            // An archived lane turns cards back into implicit-leftmost placement.
            if (placement === laneId) {
              delete placementByThreadKey[threadKey];
              delete laneEntryByThreadKey[threadKey];
            }
          }
          const { [laneId]: _removedWidth, ...byLaneColumnKey } = state.byLaneColumnKey;
          const { [laneId]: _removedOrder, ...orderByLaneId } = state.orderByLaneId;
          return {
            lanes,
            placementByThreadKey,
            laneEntryByThreadKey,
            orderByLaneId,
            byLaneColumnKey,
          };
        }),
      setWidth: (laneColumnKey, widthPx) =>
        set((state) => {
          const next = clampBoardLaneWidth(widthPx);
          if (state.byLaneColumnKey[laneColumnKey]?.widthPx === next) return state;
          return {
            byLaneColumnKey: {
              ...state.byLaneColumnKey,
              [laneColumnKey]: { widthPx: next },
            },
          };
        }),
      removeLane: (laneColumnKey) =>
        set((state) => {
          if (!(laneColumnKey in state.byLaneColumnKey)) return state;
          const { [laneColumnKey]: _removed, ...byLaneColumnKey } = state.byLaneColumnKey;
          return { byLaneColumnKey };
        }),
      toggleLifecycleLaneCollapsed: (laneId) =>
        set((state) => {
          if (!isLifecycleBoardLaneId(laneId)) return state;
          const collapsed = state.collapsedLifecycleLaneIds.includes(laneId);
          return {
            collapsedLifecycleLaneIds: collapsed
              ? state.collapsedLifecycleLaneIds.filter((candidate) => candidate !== laneId)
              : [...state.collapsedLifecycleLaneIds, laneId],
          };
        }),
      setOrganizationColumns: (columns) =>
        set((state) => {
          const rows =
            columns === "state" && state.organization.rows === "state"
              ? "project"
              : state.organization.rows;
          if (state.organization.columns === columns && state.organization.rows === rows) {
            return state;
          }
          return {
            organization:
              columns === "state"
                ? { columns, rows: rows === "state" ? "project" : rows }
                : { columns, rows },
          };
        }),
      setOrganizationRows: (rows) =>
        set((state) => {
          const columns = rows === "state" ? "workflow" : state.organization.columns;
          if (state.organization.columns === columns && state.organization.rows === rows) {
            return state;
          }
          return {
            organization: rows === "state" ? { columns: "workflow", rows } : { columns, rows },
          };
        }),
    }),
    {
      name: BOARD_LANE_STORAGE_KEY,
      version: BOARD_LANE_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      migrate: migrateBoardLaneState,
      partialize: (state) => ({
        lanes: state.lanes,
        placementByThreadKey: state.placementByThreadKey,
        laneEntryByThreadKey: state.laneEntryByThreadKey,
        orderByLaneId: state.orderByLaneId,
        byLaneColumnKey: state.byLaneColumnKey,
        collapsedLifecycleLaneIds: state.collapsedLifecycleLaneIds,
        organization: state.organization,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as {
          lanes?: unknown;
          placementByThreadKey?: unknown;
          laneEntryByThreadKey?: unknown;
          orderByLaneId?: unknown;
          collapsedLifecycleLaneIds?: unknown;
          organization?: unknown;
        } | null;
        const lanes = normalizeLanes(persisted?.lanes);
        return {
          ...currentState,
          lanes,
          placementByThreadKey: normalizePlacementByThreadKey(
            persisted?.placementByThreadKey,
            lanes,
          ),
          laneEntryByThreadKey: normalizeLaneEntryByThreadKey(persisted?.laneEntryByThreadKey),
          orderByLaneId: normalizeOrderByLaneId(persisted?.orderByLaneId),
          byLaneColumnKey: normalizePersistedByLaneColumnKey(persistedState),
          collapsedLifecycleLaneIds: normalizeCollapsedLifecycleLaneIds(
            persisted?.collapsedLifecycleLaneIds,
          ),
          organization: normalizeBoardOrganization(persisted?.organization),
        };
      },
    },
  ),
);

// A board is local to this browser profile, not to one tab. Rehydrate when a
// sibling tab saves so later edits do not write an arbitrarily stale snapshot.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === BOARD_LANE_STORAGE_KEY) void useBoardLaneStore.persist.rehydrate();
  });
}

export function selectBoardLaneWidth(
  byLaneColumnKey: Record<string, BoardLaneState>,
  laneColumnKey: string,
): number {
  return byLaneColumnKey[laneColumnKey]?.widthPx ?? BOARD_LANE_DEFAULT_WIDTH;
}

export function selectBoardPlacement(
  placementByThreadKey: Record<string, BoardLaneId>,
  ref: ScopedThreadRef,
): BoardLaneId | undefined {
  return placementByThreadKey[scopedThreadKey(ref)];
}
