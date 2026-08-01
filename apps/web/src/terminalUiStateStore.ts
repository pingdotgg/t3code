/**
 * Single Zustand store for terminal UI state keyed by scoped thread identity.
 *
 * Terminal UI transition helpers are intentionally private to keep the public
 * API constrained to store actions/selectors.
 */

import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "./types";

interface ThreadTerminalUiState {
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
}

// Keep the old storage key so existing drawer layout preferences migrate.
const TERMINAL_UI_STATE_STORAGE_KEY = "t3code:terminal-state:v1";

interface PersistedTerminalUiStateStoreState {
  terminalUiStateByThreadKey?: Record<string, ThreadTerminalUiState>;
  terminalStateByThreadKey?: Record<string, ThreadTerminalUiState>;
}

export function migratePersistedTerminalUiStateStoreState(
  persistedState: unknown,
  _version: number,
): PersistedTerminalUiStateStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return { terminalUiStateByThreadKey: {} };
  }

  const candidate = persistedState as PersistedTerminalUiStateStoreState;
  const persistedUiStateByThreadKey =
    candidate.terminalUiStateByThreadKey ?? candidate.terminalStateByThreadKey ?? {};
  const terminalUiStateByThreadKey = Object.fromEntries(
    Object.entries(persistedUiStateByThreadKey).filter(([threadKey]) =>
      parseScopedThreadKey(threadKey),
    ),
  );

  return { terminalUiStateByThreadKey };
}

function createTerminalUiStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const normalizedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of terminalIds) {
    const trimmedId = id.trim();
    if (trimmedId.length === 0 || seen.has(trimmedId)) continue;
    seen.add(trimmedId);
    normalizedIds.push(trimmedId);
  }
  return normalizedIds;
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function normalizeTerminalGroupIds(terminalIds: string[]): string[] {
  return normalizeTerminalIds(terminalIds);
}

function normalizeTerminalGroups(
  terminalGroups: ThreadTerminalGroup[],
  terminalIds: string[],
): ThreadTerminalGroup[] {
  if (terminalIds.length === 0) {
    return [];
  }

  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: ThreadTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeTerminalGroupIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? terminalIds[0] ?? "");
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
      ...(group.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  return nextGroups;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function terminalGroupsEqual(left: ThreadTerminalGroup[], right: ThreadTerminalGroup[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if (
      (leftGroup.splitDirection ?? "horizontal") !== (rightGroup.splitDirection ?? "horizontal")
    ) {
      return false;
    }
    if (!arraysEqual(leftGroup.terminalIds, rightGroup.terminalIds)) return false;
  }
  return true;
}

function threadTerminalUiStateEqual(
  left: ThreadTerminalUiState,
  right: ThreadTerminalUiState,
): boolean {
  return (
    left.terminalOpen === right.terminalOpen &&
    left.terminalHeight === right.terminalHeight &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups)
  );
}

const DEFAULT_THREAD_TERMINAL_UI_STATE: ThreadTerminalUiState = Object.freeze({
  terminalOpen: false,
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  terminalIds: [],
  activeTerminalId: "",
  terminalGroups: [],
  activeTerminalGroupId: "",
});

function createDefaultThreadTerminalUiState(): ThreadTerminalUiState {
  return {
    ...DEFAULT_THREAD_TERMINAL_UI_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_UI_STATE.terminalIds],
    terminalGroups: copyTerminalGroups(DEFAULT_THREAD_TERMINAL_UI_STATE.terminalGroups),
  };
}

function getDefaultThreadTerminalUiState(): ThreadTerminalUiState {
  return DEFAULT_THREAD_TERMINAL_UI_STATE;
}

function normalizeThreadTerminalUiState(state: ThreadTerminalUiState): ThreadTerminalUiState {
  const nextTerminalIds = normalizeTerminalIds(state.terminalIds);
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? "");
  const terminalGroups = normalizeTerminalGroups(state.terminalGroups, nextTerminalIds);
  const activeGroupIdFromState = terminalGroups.some(
    (group) => group.id === state.activeTerminalGroupId,
  )
    ? state.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;

  const normalized: ThreadTerminalUiState = {
    terminalOpen: state.terminalOpen,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId:
      activeGroupIdFromState ?? activeGroupIdFromTerminal ?? terminalGroups[0]?.id ?? "",
  };
  return threadTerminalUiStateEqual(state, normalized) ? state : normalized;
}

function isDefaultThreadTerminalUiState(state: ThreadTerminalUiState): boolean {
  const normalized = normalizeThreadTerminalUiState(state);
  return threadTerminalUiStateEqual(normalized, DEFAULT_THREAD_TERMINAL_UI_STATE);
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function terminalThreadKey(threadRef: ScopedThreadRef): string {
  return scopedThreadKey(threadRef);
}

function copyTerminalGroups(groups: ThreadTerminalGroup[]): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    id: group.id,
    terminalIds: [...group.terminalIds],
    ...(group.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
  }));
}

function upsertTerminalIntoGroups(
  state: ThreadTerminalUiState,
  terminalId: string,
  mode: "split" | "new",
  splitDirection: "horizontal" | "vertical" = "horizontal",
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  const effectiveMode: "split" | "new" = normalized.terminalIds.length === 0 ? "new" : mode;
  if (!isValidTerminalId(terminalId)) {
    return normalized;
  }

  const isNewTerminal = !normalized.terminalIds.includes(terminalId);
  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, terminalId]
    : normalized.terminalIds;
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);

  const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, terminalId);
  if (existingGroupIndex >= 0) {
    terminalGroups[existingGroupIndex]!.terminalIds = terminalGroups[
      existingGroupIndex
    ]!.terminalIds.filter((id) => id !== terminalId);
    if (terminalGroups[existingGroupIndex]!.terminalIds.length === 0) {
      terminalGroups.splice(existingGroupIndex, 1);
    }
  }

  if (effectiveMode === "new") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds);
    terminalGroups.push({ id: nextGroupId, terminalIds: [terminalId] });
    return normalizeThreadTerminalUiState({
      ...normalized,
      terminalOpen: true,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  let activeGroupIndex = terminalGroups.findIndex(
    (group) => group.id === normalized.activeTerminalGroupId,
  );
  if (activeGroupIndex < 0) {
    activeGroupIndex = findGroupIndexByTerminalId(terminalGroups, normalized.activeTerminalId);
  }
  if (activeGroupIndex < 0) {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(
      fallbackGroupId(normalized.activeTerminalId),
      usedGroupIds,
    );
    terminalGroups.push({ id: nextGroupId, terminalIds: [normalized.activeTerminalId] });
    activeGroupIndex = terminalGroups.length - 1;
  }

  const destinationGroup = terminalGroups[activeGroupIndex];
  if (!destinationGroup) {
    return normalized;
  }
  const destinationTerminalIdSet = new Set(destinationGroup.terminalIds);

  if (
    isNewTerminal &&
    !destinationTerminalIdSet.has(terminalId) &&
    destinationGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  if (!destinationTerminalIdSet.has(terminalId)) {
    const anchorIndex = destinationGroup.terminalIds.indexOf(normalized.activeTerminalId);
    if (anchorIndex >= 0) {
      destinationGroup.terminalIds.splice(anchorIndex + 1, 0, terminalId);
    } else {
      destinationGroup.terminalIds.push(terminalId);
    }
  }
  if (splitDirection === "vertical") {
    destinationGroup.splitDirection = "vertical";
  } else {
    delete destinationGroup.splitDirection;
  }

  return normalizeThreadTerminalUiState({
    ...normalized,
    terminalOpen: true,
    terminalIds,
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: destinationGroup.id,
  });
}

function setThreadTerminalOpen(state: ThreadTerminalUiState, open: boolean): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (open && normalized.terminalIds.length === 0) {
    return upsertTerminalIntoGroups(normalized, DEFAULT_THREAD_TERMINAL_ID, "new");
  }
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open };
}

function setThreadTerminalHeight(
  state: ThreadTerminalUiState,
  height: number,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

function splitThreadTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
  direction: "horizontal" | "vertical" = "horizontal",
): ThreadTerminalUiState {
  return upsertTerminalIntoGroups(state, terminalId, "split", direction);
}

function newThreadTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  return upsertTerminalIntoGroups(state, terminalId, "new");
}

function setThreadActiveTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const activeTerminalGroupId =
    normalized.terminalGroups.find((group) => group.terminalIds.includes(terminalId))?.id ??
    normalized.activeTerminalGroupId;
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId
  ) {
    return normalized;
  }
  return {
    ...normalized,
    activeTerminalId: terminalId,
    activeTerminalGroupId,
  };
}

function closeThreadTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalIds = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    return createDefaultThreadTerminalUiState();
  }

  const closedTerminalIndex = normalized.terminalIds.indexOf(terminalId);
  const nextActiveTerminalId =
    normalized.activeTerminalId === terminalId
      ? (remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
        remainingTerminalIds[0] ??
        "")
      : normalized.activeTerminalId;

  const terminalGroups: ThreadTerminalGroup[] = [];
  for (const group of normalized.terminalGroups) {
    const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
    if (terminalIds.length > 0) {
      terminalGroups.push({ ...group, terminalIds });
    }
  }

  const nextActiveTerminalGroupId =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(nextActiveTerminalId);

  return normalizeThreadTerminalUiState({
    terminalOpen: normalized.terminalOpen,
    terminalHeight: normalized.terminalHeight,
    terminalIds: remainingTerminalIds,
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: nextActiveTerminalGroupId,
  });
}

function reconcileThreadTerminalSessionIds(
  state: ThreadTerminalUiState,
  nextIds: string[],
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (arraysEqual(normalized.terminalIds, nextIds)) {
    return normalized;
  }

  const nextActiveTerminalId = nextIds.includes(normalized.activeTerminalId)
    ? normalized.activeTerminalId
    : (nextIds[0] ?? "");

  const terminalGroups = normalizeTerminalGroups(normalized.terminalGroups, nextIds);
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ?? null;

  return normalizeThreadTerminalUiState({
    ...normalized,
    terminalIds: nextIds,
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: activeGroupIdFromTerminal ?? terminalGroups[0]?.id ?? "",
  });
}

export function selectThreadTerminalUiState(
  terminalUiStateByThreadKey: Record<string, ThreadTerminalUiState>,
  threadRef: ScopedThreadRef | null | undefined,
): ThreadTerminalUiState {
  if (!threadRef || threadRef.threadId.length === 0) {
    return getDefaultThreadTerminalUiState();
  }
  return (
    terminalUiStateByThreadKey[terminalThreadKey(threadRef)] ?? getDefaultThreadTerminalUiState()
  );
}

/**
 * Decides which terminal ids a client surface should reconcile with, or null
 * when the local list already reflects the server.
 *
 * A client id the server does not report is ambiguous: it is either a local
 * open the server has not registered yet, or a session that disappeared
 * server-side. `pendingTerminalIds` — ids introduced locally and not yet
 * confirmed — is what separates the two. Keeping every client id would leave a
 * dead tab on screen forever; keeping none would drop a split opened moments
 * ago whenever the same update carries an unrelated new server id.
 *
 * Suppressed ids are dropped from both sides, so a close the server has not
 * processed cannot resurrect itself.
 */
export function reconcilableServerTerminalIds(
  serverTerminalIds: readonly string[],
  clientTerminalIds: readonly string[],
  suppressedTerminalIds: readonly string[],
  pendingTerminalIds: readonly string[],
): string[] | null {
  const suppressed = new Set(suppressedTerminalIds);
  const pending = new Set(pendingTerminalIds);
  const visibleServerIds =
    suppressed.size === 0
      ? [...serverTerminalIds]
      : serverTerminalIds.filter((terminalId) => !suppressed.has(terminalId));

  // An empty list is indistinguishable from "session metadata has not loaded
  // yet" (a reconnect serves `[]` before the first response), so it must never
  // clear a populated drawer.
  if (visibleServerIds.length === 0) {
    return null;
  }

  const visibleServerIdSet = new Set(visibleServerIds);
  const clientIdSet = new Set(clientTerminalIds);
  const keptClientIds = clientTerminalIds.filter(
    (terminalId) =>
      !suppressed.has(terminalId) &&
      (visibleServerIdSet.has(terminalId) || pending.has(terminalId)),
  );
  const unknownServerIds = visibleServerIds.filter((terminalId) => !clientIdSet.has(terminalId));

  const nextTerminalIds = [...keptClientIds, ...unknownServerIds];
  return arraysEqual(nextTerminalIds, [...clientTerminalIds]) ? null : nextTerminalIds;
}

function updateTerminalUiStateByThreadKey(
  terminalUiStateByThreadKey: Record<string, ThreadTerminalUiState>,
  threadRef: ScopedThreadRef,
  updater: (state: ThreadTerminalUiState) => ThreadTerminalUiState,
): Record<string, ThreadTerminalUiState> {
  if (threadRef.threadId.length === 0) {
    return terminalUiStateByThreadKey;
  }

  const threadKey = terminalThreadKey(threadRef);
  const current = selectThreadTerminalUiState(terminalUiStateByThreadKey, threadRef);
  const next = updater(current);
  if (next === current) {
    return terminalUiStateByThreadKey;
  }

  if (isDefaultThreadTerminalUiState(next)) {
    if (terminalUiStateByThreadKey[threadKey] === undefined) {
      return terminalUiStateByThreadKey;
    }
    const { [threadKey]: _removed, ...rest } = terminalUiStateByThreadKey;
    return rest;
  }

  return {
    ...terminalUiStateByThreadKey,
    [threadKey]: next,
  };
}

/** Adds or removes one terminal id from a per-thread id set (suppressed, pending). */
function updateThreadTerminalIdSet(
  idsByThreadKey: Record<string, string[]>,
  threadRef: ScopedThreadRef,
  terminalId: string,
  member: boolean,
): Record<string, string[]> {
  const normalizedTerminalId = terminalId.trim();
  if (normalizedTerminalId.length === 0) {
    return idsByThreadKey;
  }
  const threadKey = terminalThreadKey(threadRef);
  const currentIds = idsByThreadKey[threadKey] ?? [];
  const currentlyMember = currentIds.includes(normalizedTerminalId);
  if (currentlyMember === member) {
    return idsByThreadKey;
  }
  if (member) {
    return {
      ...idsByThreadKey,
      [threadKey]: [...currentIds, normalizedTerminalId],
    };
  }

  const remainingIds = currentIds.filter((id) => id !== normalizedTerminalId);
  if (remainingIds.length > 0) {
    return {
      ...idsByThreadKey,
      [threadKey]: remainingIds,
    };
  }
  return removeRecordEntry(idsByThreadKey, threadKey);
}

function removeRecordEntry<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (record[key] === undefined) {
    return record;
  }
  const { [key]: _removed, ...remaining } = record;
  return remaining;
}

interface TerminalUiStateStoreState {
  terminalUiStateByThreadKey: Record<string, ThreadTerminalUiState>;
  /** Closed ids hidden from stale server metadata until that id is explicitly opened again. */
  suppressedTerminalIdsByThreadKey: Record<string, string[]>;
  /**
   * Ids opened locally that the server has not confirmed yet. Reconcile keeps
   * these; every other client-only id is treated as a server-side close.
   */
  pendingTerminalIdsByThreadKey: Record<string, string[]>;
  setTerminalOpen: (threadRef: ScopedThreadRef, open: boolean) => void;
  setTerminalHeight: (threadRef: ScopedThreadRef, height: number) => void;
  splitTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  splitTerminalVertical: (threadRef: ScopedThreadRef, terminalId: string) => void;
  newTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  ensureTerminal: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    options?: { open?: boolean; active?: boolean },
  ) => void;
  setActiveTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  closeTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  unsuppressTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  abandonPendingTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  reconcileTerminalIds: (threadRef: ScopedThreadRef, nextIds: string[]) => void;
  clearTerminalUiState: (threadRef: ScopedThreadRef) => void;
  removeTerminalUiState: (threadRef: ScopedThreadRef) => void;
  removeOrphanedTerminalUiStates: (activeThreadKeys: Set<string>) => void;
}

export const useTerminalUiStateStore = create<TerminalUiStateStoreState>()(
  persist(
    (set, get) => {
      const updateTerminal = (
        threadRef: ScopedThreadRef,
        updater: (
          state: ThreadTerminalUiState,
          suppressedTerminalIds: readonly string[],
        ) => ThreadTerminalUiState,
        membership?: { terminalId: string; suppressed: boolean; pending?: boolean },
      ) => {
        set((state) => {
          const threadKey = terminalThreadKey(threadRef);
          const suppressedTerminalIds = state.suppressedTerminalIdsByThreadKey[threadKey] ?? [];
          const nextTerminalUiStateByThreadKey = updateTerminalUiStateByThreadKey(
            state.terminalUiStateByThreadKey,
            threadRef,
            (terminalState) => updater(terminalState, suppressedTerminalIds),
          );
          const nextSuppressedTerminalIdsByThreadKey = membership
            ? updateThreadTerminalIdSet(
                state.suppressedTerminalIdsByThreadKey,
                threadRef,
                membership.terminalId,
                membership.suppressed,
              )
            : state.suppressedTerminalIdsByThreadKey;
          const nextPendingTerminalIdsByThreadKey =
            membership?.pending === undefined
              ? state.pendingTerminalIdsByThreadKey
              : updateThreadTerminalIdSet(
                  state.pendingTerminalIdsByThreadKey,
                  threadRef,
                  membership.terminalId,
                  membership.pending,
                );
          if (
            nextTerminalUiStateByThreadKey === state.terminalUiStateByThreadKey &&
            nextSuppressedTerminalIdsByThreadKey === state.suppressedTerminalIdsByThreadKey &&
            nextPendingTerminalIdsByThreadKey === state.pendingTerminalIdsByThreadKey
          ) {
            return state;
          }
          return {
            pendingTerminalIdsByThreadKey: nextPendingTerminalIdsByThreadKey,
            terminalUiStateByThreadKey: nextTerminalUiStateByThreadKey,
            suppressedTerminalIdsByThreadKey: nextSuppressedTerminalIdsByThreadKey,
          };
        });
      };

      return {
        terminalUiStateByThreadKey: {},
        suppressedTerminalIdsByThreadKey: {},
        pendingTerminalIdsByThreadKey: {},
        setTerminalOpen: (threadRef, open) => {
          const terminalState = selectThreadTerminalUiState(
            get().terminalUiStateByThreadKey,
            threadRef,
          );
          updateTerminal(
            threadRef,
            (state) => setThreadTerminalOpen(state, open),
            // Not marked pending: this only materializes the default id in the
            // UI, without an open request behind it, so server truth still wins.
            open && terminalState.terminalIds.length === 0
              ? { terminalId: DEFAULT_THREAD_TERMINAL_ID, suppressed: false }
              : undefined,
          );
        },
        setTerminalHeight: (threadRef, height) =>
          updateTerminal(threadRef, (state) => setThreadTerminalHeight(state, height)),
        splitTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => splitThreadTerminal(state, terminalId), {
            terminalId,
            suppressed: false,
            pending: true,
          }),
        splitTerminalVertical: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => splitThreadTerminal(state, terminalId, "vertical"), {
            terminalId,
            suppressed: false,
            pending: true,
          }),
        newTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => newThreadTerminal(state, terminalId), {
            terminalId,
            suppressed: false,
            pending: true,
          }),
        ensureTerminal: (threadRef, terminalId, options) =>
          updateTerminal(
            threadRef,
            (state) => {
              let nextState = state;
              if (!state.terminalIds.includes(terminalId)) {
                nextState = newThreadTerminal(nextState, terminalId);
              }
              if (options?.active === false) {
                nextState = {
                  ...nextState,
                  activeTerminalId: state.activeTerminalId,
                  activeTerminalGroupId: state.activeTerminalGroupId,
                };
              }
              if (options?.active ?? true) {
                nextState = setThreadActiveTerminal(nextState, terminalId);
              }
              if (options?.open) {
                nextState = setThreadTerminalOpen(nextState, true);
              }
              return normalizeThreadTerminalUiState(nextState);
            },
            { terminalId, suppressed: false, pending: true },
          ),
        setActiveTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => setThreadActiveTerminal(state, terminalId)),
        closeTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => closeThreadTerminal(state, terminalId), {
            terminalId,
            suppressed: true,
            pending: false,
          }),
        // Rollback for an optimistic close the server rejected: the session is
        // still alive, and staying suppressed would hide it from reconcile for
        // the rest of the session.
        unsuppressTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => state, { terminalId, suppressed: false }),
        // Rollback for an open the server rejected. Pending ids are immune to
        // reconcile, so without this the never-created terminal would sit in the
        // drawer as a phantom tab forever. Not suppressed: if the session did
        // get created after all, reconcile is free to adopt it back.
        abandonPendingTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => closeThreadTerminal(state, terminalId), {
            terminalId,
            suppressed: false,
            pending: false,
          }),
        // Takes the raw server session list. The decision lives here because it
        // needs the pending set, which is what tells a local open the server has
        // not registered yet apart from a session that ended server-side.
        reconcileTerminalIds: (threadRef, serverTerminalIds) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const suppressedTerminalIds = state.suppressedTerminalIdsByThreadKey[threadKey] ?? [];
            const pendingTerminalIds = state.pendingTerminalIdsByThreadKey[threadKey] ?? [];

            // Anything the server now reports is confirmed and stops being pending,
            // so a later disappearance is read as a real close.
            const serverIdSet = new Set(serverTerminalIds);
            const confirmedPendingIds = pendingTerminalIds.filter(
              (terminalId) => !serverIdSet.has(terminalId),
            );
            const nextPendingTerminalIdsByThreadKey =
              confirmedPendingIds.length === pendingTerminalIds.length
                ? state.pendingTerminalIdsByThreadKey
                : confirmedPendingIds.length > 0
                  ? { ...state.pendingTerminalIdsByThreadKey, [threadKey]: confirmedPendingIds }
                  : removeRecordEntry(state.pendingTerminalIdsByThreadKey, threadKey);

            const clientTerminalIds = selectThreadTerminalUiState(
              state.terminalUiStateByThreadKey,
              threadRef,
            ).terminalIds;
            const nextTerminalIds = reconcilableServerTerminalIds(
              serverTerminalIds,
              clientTerminalIds,
              suppressedTerminalIds,
              confirmedPendingIds,
            );
            const nextTerminalUiStateByThreadKey =
              nextTerminalIds === null
                ? state.terminalUiStateByThreadKey
                : updateTerminalUiStateByThreadKey(
                    state.terminalUiStateByThreadKey,
                    threadRef,
                    (terminalState) =>
                      reconcileThreadTerminalSessionIds(terminalState, nextTerminalIds),
                  );

            if (
              nextTerminalUiStateByThreadKey === state.terminalUiStateByThreadKey &&
              nextPendingTerminalIdsByThreadKey === state.pendingTerminalIdsByThreadKey
            ) {
              return state;
            }
            return {
              terminalUiStateByThreadKey: nextTerminalUiStateByThreadKey,
              pendingTerminalIdsByThreadKey: nextPendingTerminalIdsByThreadKey,
            };
          }),
        clearTerminalUiState: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const nextTerminalUiStateByThreadKey = updateTerminalUiStateByThreadKey(
              state.terminalUiStateByThreadKey,
              threadRef,
              () => createDefaultThreadTerminalUiState(),
            );
            const hadSuppressedTerminalIds =
              state.suppressedTerminalIdsByThreadKey[threadKey] !== undefined;
            const hadPendingTerminalIds =
              state.pendingTerminalIdsByThreadKey[threadKey] !== undefined;
            if (
              nextTerminalUiStateByThreadKey === state.terminalUiStateByThreadKey &&
              !hadSuppressedTerminalIds &&
              !hadPendingTerminalIds
            ) {
              return state;
            }
            return {
              terminalUiStateByThreadKey: nextTerminalUiStateByThreadKey,
              suppressedTerminalIdsByThreadKey: removeRecordEntry(
                state.suppressedTerminalIdsByThreadKey,
                threadKey,
              ),
              pendingTerminalIdsByThreadKey: removeRecordEntry(
                state.pendingTerminalIdsByThreadKey,
                threadKey,
              ),
            };
          }),
        removeTerminalUiState: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const hadTerminalUiState = state.terminalUiStateByThreadKey[threadKey] !== undefined;
            const hadSuppressedTerminalIds =
              state.suppressedTerminalIdsByThreadKey[threadKey] !== undefined;
            const hadPendingTerminalIds =
              state.pendingTerminalIdsByThreadKey[threadKey] !== undefined;
            if (!hadTerminalUiState && !hadSuppressedTerminalIds && !hadPendingTerminalIds) {
              return state;
            }
            return {
              terminalUiStateByThreadKey: removeRecordEntry(
                state.terminalUiStateByThreadKey,
                threadKey,
              ),
              suppressedTerminalIdsByThreadKey: removeRecordEntry(
                state.suppressedTerminalIdsByThreadKey,
                threadKey,
              ),
              pendingTerminalIdsByThreadKey: removeRecordEntry(
                state.pendingTerminalIdsByThreadKey,
                threadKey,
              ),
            };
          }),
        removeOrphanedTerminalUiStates: (activeThreadKeys) =>
          set((state) => {
            const orphanedIds = new Set(
              [
                ...Object.keys(state.terminalUiStateByThreadKey),
                ...Object.keys(state.suppressedTerminalIdsByThreadKey),
                ...Object.keys(state.pendingTerminalIdsByThreadKey),
              ].filter((key) => !activeThreadKeys.has(key)),
            );
            if (orphanedIds.size === 0) {
              return state;
            }
            const nextTerminalUiStateByThreadKey = { ...state.terminalUiStateByThreadKey };
            const nextSuppressedTerminalIdsByThreadKey = {
              ...state.suppressedTerminalIdsByThreadKey,
            };
            const nextPendingTerminalIdsByThreadKey = { ...state.pendingTerminalIdsByThreadKey };
            for (const id of orphanedIds) {
              delete nextTerminalUiStateByThreadKey[id];
              delete nextSuppressedTerminalIdsByThreadKey[id];
              delete nextPendingTerminalIdsByThreadKey[id];
            }
            return {
              terminalUiStateByThreadKey: nextTerminalUiStateByThreadKey,
              suppressedTerminalIdsByThreadKey: nextSuppressedTerminalIdsByThreadKey,
              pendingTerminalIdsByThreadKey: nextPendingTerminalIdsByThreadKey,
            };
          }),
      };
    },
    {
      name: TERMINAL_UI_STATE_STORAGE_KEY,
      version: 4,
      storage: createJSONStorage(createTerminalUiStateStorage),
      migrate: migratePersistedTerminalUiStateStoreState,
      partialize: (state) => ({
        terminalUiStateByThreadKey: state.terminalUiStateByThreadKey,
      }),
    },
  ),
);
