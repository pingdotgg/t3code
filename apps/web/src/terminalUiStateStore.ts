/**
 * Single Zustand store for terminal UI state keyed by scoped thread identity.
 *
 * Terminal UI transition helpers are intentionally private to keep the public
 * API constrained to store actions/selectors.
 */

import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime";
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
  }));
}

function upsertTerminalIntoGroups(
  state: ThreadTerminalUiState,
  terminalId: string,
  mode: "split" | "new",
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
): ThreadTerminalUiState {
  return upsertTerminalIntoGroups(state, terminalId, "split");
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

interface TerminalUiStateStoreState {
  terminalUiStateByThreadKey: Record<string, ThreadTerminalUiState>;
  setTerminalOpen: (threadRef: ScopedThreadRef, open: boolean) => void;
  setTerminalHeight: (threadRef: ScopedThreadRef, height: number) => void;
  splitTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  newTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  ensureTerminal: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    options?: { open?: boolean; active?: boolean },
  ) => void;
  setActiveTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  closeTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  reconcileTerminalIds: (threadRef: ScopedThreadRef, nextIds: string[]) => void;
  clearTerminalUiState: (threadRef: ScopedThreadRef) => void;
  removeTerminalUiState: (threadRef: ScopedThreadRef) => void;
  removeOrphanedTerminalUiStates: (activeThreadKeys: Set<string>) => void;
}

export const useTerminalUiStateStore = create<TerminalUiStateStoreState>()(
  persist(
    (set) => {
      const updateTerminal = (
        threadRef: ScopedThreadRef,
        updater: (state: ThreadTerminalUiState) => ThreadTerminalUiState,
      ) => {
        set((state) => {
          const nextTerminalUiStateByThreadKey = updateTerminalUiStateByThreadKey(
            state.terminalUiStateByThreadKey,
            threadRef,
            updater,
          );
          if (nextTerminalUiStateByThreadKey === state.terminalUiStateByThreadKey) {
            return state;
          }
          return {
            terminalUiStateByThreadKey: nextTerminalUiStateByThreadKey,
          };
        });
      };

      return {
        terminalUiStateByThreadKey: {},
        setTerminalOpen: (threadRef, open) =>
          updateTerminal(threadRef, (state) => setThreadTerminalOpen(state, open)),
        setTerminalHeight: (threadRef, height) =>
          updateTerminal(threadRef, (state) => setThreadTerminalHeight(state, height)),
        splitTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => splitThreadTerminal(state, terminalId)),
        newTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => newThreadTerminal(state, terminalId)),
        ensureTerminal: (threadRef, terminalId, options) =>
          updateTerminal(threadRef, (state) => {
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
          }),
        setActiveTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => setThreadActiveTerminal(state, terminalId)),
        closeTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => closeThreadTerminal(state, terminalId)),
        reconcileTerminalIds: (threadRef, nextIds) =>
          updateTerminal(threadRef, (state) => reconcileThreadTerminalSessionIds(state, nextIds)),
        clearTerminalUiState: (threadRef) =>
          set((state) => {
            const nextTerminalUiStateByThreadKey = updateTerminalUiStateByThreadKey(
              state.terminalUiStateByThreadKey,
              threadRef,
              () => createDefaultThreadTerminalUiState(),
            );
            if (nextTerminalUiStateByThreadKey === state.terminalUiStateByThreadKey) {
              return state;
            }
            return {
              terminalUiStateByThreadKey: nextTerminalUiStateByThreadKey,
            };
          }),
        removeTerminalUiState: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const hadTerminalUiState = state.terminalUiStateByThreadKey[threadKey] !== undefined;
            if (!hadTerminalUiState) {
              return state;
            }
            const nextTerminalUiStateByThreadKey = { ...state.terminalUiStateByThreadKey };
            delete nextTerminalUiStateByThreadKey[threadKey];
            return {
              terminalUiStateByThreadKey: nextTerminalUiStateByThreadKey,
            };
          }),
        removeOrphanedTerminalUiStates: (activeThreadKeys) =>
          set((state) => {
            const orphanedIds = Object.keys(state.terminalUiStateByThreadKey).filter(
              (key) => !activeThreadKeys.has(key),
            );
            if (orphanedIds.length === 0) {
              return state;
            }
            const next = { ...state.terminalUiStateByThreadKey };
            for (const id of orphanedIds) {
              delete next[id];
            }
            return {
              terminalUiStateByThreadKey: next,
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
