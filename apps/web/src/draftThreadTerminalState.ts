import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_THREAD_TERMINAL_COUNT,
  type ThreadTerminalGroup,
} from "./types";

export interface DraftThreadTerminalState {
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
}

export type DraftThreadTerminalAction =
  | { type: "set-open"; open: boolean }
  | { type: "set-height"; height: number }
  | { type: "split"; terminalId: string }
  | { type: "new"; terminalId: string }
  | { type: "set-active"; terminalId: string }
  | { type: "close"; terminalId: string }
  | { type: "set-activity"; terminalId: string; hasRunningSubprocess: boolean };

function normalizeTerminalIds(terminalIds: string[]): string[] {
  return [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
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

function findGroupIndexByTerminalId(terminalGroups: ThreadTerminalGroup[], terminalId: string): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function normalizeTerminalGroups(
  terminalGroups: ThreadTerminalGroup[],
  terminalIds: string[],
): ThreadTerminalGroup[] {
  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: ThreadTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeTerminalIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) {
      continue;
    }

    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }

    nextGroups.push({
      id: assignUniqueGroupId(group.id, usedGroupIds),
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

  if (nextGroups.length === 0) {
    return [
      {
        id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      },
    ];
  }

  return nextGroups;
}

export function createDefaultDraftThreadTerminalState(): DraftThreadTerminalState {
  return {
    terminalOpen: false,
    terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    runningTerminalIds: [],
    activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
    terminalGroups: [
      {
        id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      },
    ],
    activeTerminalGroupId: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
  };
}

function normalizeDraftThreadTerminals(state: DraftThreadTerminalState): DraftThreadTerminalState {
  const terminalIds = normalizeTerminalIds(state.terminalIds);
  const nextTerminalIds = terminalIds.length > 0 ? terminalIds : [DEFAULT_THREAD_TERMINAL_ID];
  const runningTerminalIds = normalizeTerminalIds(state.runningTerminalIds).filter((terminalId) =>
    nextTerminalIds.includes(terminalId),
  );
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  const terminalGroups = normalizeTerminalGroups(state.terminalGroups, nextTerminalIds);
  const activeGroupIdFromState = terminalGroups.some((group) => group.id === state.activeTerminalGroupId)
    ? state.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;

  return {
    terminalOpen: state.terminalOpen,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    runningTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId:
      activeGroupIdFromState ??
      activeGroupIdFromTerminal ??
      terminalGroups[0]?.id ??
      fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
  };
}

function closeDraftTerminal(
  state: DraftThreadTerminalState,
  terminalId: string,
): DraftThreadTerminalState {
  if (!state.terminalIds.includes(terminalId)) {
    return state;
  }

  const remainingTerminalIds = state.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    return createDefaultDraftThreadTerminalState();
  }

  const closedTerminalIndex = state.terminalIds.indexOf(terminalId);
  const nextActiveTerminalId =
    state.activeTerminalId === terminalId
      ? (remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
        remainingTerminalIds[0] ??
        DEFAULT_THREAD_TERMINAL_ID)
      : state.activeTerminalId;

  const terminalGroups = state.terminalGroups
    .map((group) => ({
      ...group,
      terminalIds: group.terminalIds.filter((id) => id !== terminalId),
    }))
    .filter((group) => group.terminalIds.length > 0);

  const nextActiveTerminalGroupId =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(nextActiveTerminalId);

  return normalizeDraftThreadTerminals({
    terminalOpen: state.terminalOpen,
    terminalHeight: state.terminalHeight,
    terminalIds: remainingTerminalIds,
    runningTerminalIds: state.runningTerminalIds.filter((id) => id !== terminalId),
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: nextActiveTerminalGroupId,
  });
}

function copyTerminalGroups(groups: ThreadTerminalGroup[]): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    id: group.id,
    terminalIds: [...group.terminalIds],
  }));
}

export function reduceDraftThreadTerminalState(
  state: DraftThreadTerminalState,
  action: DraftThreadTerminalAction,
): DraftThreadTerminalState {
  const normalized = normalizeDraftThreadTerminals(state);

  if (action.type === "set-open") {
    if (normalized.terminalOpen === action.open) return normalized;
    return {
      ...normalized,
      terminalOpen: action.open,
    };
  }

  if (action.type === "set-height") {
    if (!Number.isFinite(action.height) || action.height <= 0 || normalized.terminalHeight === action.height) {
      return normalized;
    }
    return {
      ...normalized,
      terminalHeight: action.height,
    };
  }

  if (action.type === "set-active") {
    if (!normalized.terminalIds.includes(action.terminalId)) {
      return normalized;
    }
    const activeTerminalGroupId =
      normalized.terminalGroups.find((group) => group.terminalIds.includes(action.terminalId))?.id ??
      normalized.activeTerminalGroupId;
    return {
      ...normalized,
      activeTerminalId: action.terminalId,
      activeTerminalGroupId,
    };
  }

  if (action.type === "close") {
    return closeDraftTerminal(normalized, action.terminalId);
  }

  if (action.type === "set-activity") {
    if (!normalized.terminalIds.includes(action.terminalId)) {
      return normalized;
    }
    const runningTerminalIds = new Set(normalized.runningTerminalIds);
    if (action.hasRunningSubprocess) {
      runningTerminalIds.add(action.terminalId);
    } else {
      runningTerminalIds.delete(action.terminalId);
    }
    return {
      ...normalized,
      runningTerminalIds: [...runningTerminalIds],
    };
  }

  if (!action.terminalId || action.terminalId.trim().length === 0) {
    return normalized;
  }

  const isNewTerminal = !normalized.terminalIds.includes(action.terminalId);
  if (isNewTerminal && normalized.terminalIds.length >= MAX_THREAD_TERMINAL_COUNT) {
    return normalized;
  }

  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, action.terminalId]
    : normalized.terminalIds;
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);
  const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, action.terminalId);
  if (existingGroupIndex >= 0) {
    terminalGroups[existingGroupIndex]!.terminalIds = terminalGroups[existingGroupIndex]!.terminalIds.filter(
      (id) => id !== action.terminalId,
    );
    if (terminalGroups[existingGroupIndex]!.terminalIds.length === 0) {
      terminalGroups.splice(existingGroupIndex, 1);
    }
  }

  if (action.type === "new") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(action.terminalId), usedGroupIds);
    terminalGroups.push({ id: nextGroupId, terminalIds: [action.terminalId] });
    return normalizeDraftThreadTerminals({
      ...normalized,
      terminalOpen: true,
      terminalIds,
      activeTerminalId: action.terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  let activeGroupIndex = terminalGroups.findIndex((group) => group.id === normalized.activeTerminalGroupId);
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

  if (!destinationGroup.terminalIds.includes(action.terminalId)) {
    const anchorIndex = destinationGroup.terminalIds.indexOf(normalized.activeTerminalId);
    if (anchorIndex >= 0) {
      destinationGroup.terminalIds.splice(anchorIndex + 1, 0, action.terminalId);
    } else {
      destinationGroup.terminalIds.push(action.terminalId);
    }
  }

  return normalizeDraftThreadTerminals({
    ...normalized,
    terminalOpen: true,
    terminalIds,
    activeTerminalId: action.terminalId,
    terminalGroups,
    activeTerminalGroupId: destinationGroup.id,
  });
}
