import type { ThreadId, WorktreeId } from "@repo/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SerializedDockview } from "dockview";
import type { GroupviewPanelState } from "dockview";

export const WORKTREE_CHAT_LAYOUT_STORAGE_KEY = "t3code:worktree-chat-layouts:v1";

export interface WorktreeDockPanelParams {
  threadId: ThreadId;
  worktreeId: WorktreeId;
  title?: string;
}

interface WorktreeChatLayoutStoreState {
  layoutsByWorktreeId: Partial<Record<WorktreeId, SerializedDockview>>;
  setLayout: (worktreeId: WorktreeId, layout: SerializedDockview) => void;
  clearLayout: (worktreeId: WorktreeId) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeDockPanelParams(
  value: unknown,
  validThreadIds: ReadonlySet<ThreadId>,
  worktreeId: WorktreeId,
): WorktreeDockPanelParams | null {
  if (!isRecord(value)) {
    return null;
  }

  const threadId = value.threadId;
  const storedWorktreeId = value.worktreeId;
  const title = value.title;
  if (
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    !validThreadIds.has(threadId as ThreadId)
  ) {
    return null;
  }
  if (storedWorktreeId !== worktreeId) {
    return null;
  }

  return {
    threadId: threadId as ThreadId,
    worktreeId,
    ...(typeof title === "string" && title.length > 0 ? { title } : {}),
  };
}

function sanitizeSerializedGroupState(
  value: unknown,
  validPanelIds: ReadonlySet<string>,
): ({ activeView?: string; id: string; views: string[] } & Record<string, unknown>) | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = value.id;
  const views = Array.isArray(value.views)
    ? value.views.filter(
        (entry): entry is string => typeof entry === "string" && validPanelIds.has(entry),
      )
    : [];
  if (typeof id !== "string" || id.length === 0 || views.length === 0) {
    return null;
  }

  const activeView =
    typeof value.activeView === "string" && views.includes(value.activeView)
      ? value.activeView
      : (views[0] ?? undefined);

  return {
    ...value,
    id,
    views,
    ...(activeView ? { activeView } : {}),
  };
}

function sanitizeSerializedGridNode(
  value: unknown,
  validPanelIds: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.type === "leaf") {
    const data = sanitizeSerializedGroupState(value.data, validPanelIds);
    if (!data) {
      return null;
    }
    return {
      ...value,
      type: "leaf",
      data,
    };
  }

  if (value.type === "branch") {
    const children = Array.isArray(value.data)
      ? value.data
          .map((entry) => sanitizeSerializedGridNode(entry, validPanelIds))
          .filter((entry): entry is Record<string, unknown> => entry !== null)
      : [];
    if (children.length === 0) {
      return null;
    }
    return {
      ...value,
      type: "branch",
      data: children,
    };
  }

  return null;
}

export function sanitizeSerializedDockviewLayout(options: {
  layout: SerializedDockview;
  validThreadIds: ReadonlySet<ThreadId>;
  worktreeId: WorktreeId;
}): SerializedDockview | null {
  const nextPanels: Record<string, GroupviewPanelState> = {};
  for (const [panelId, panelState] of Object.entries(options.layout.panels)) {
    if (typeof panelId !== "string" || panelId.length === 0) {
      continue;
    }
    const params = sanitizeDockPanelParams(
      panelState.params,
      options.validThreadIds,
      options.worktreeId,
    );
    if (!params) {
      continue;
    }
    nextPanels[panelId] = {
      ...panelState,
      params,
    };
  }

  const validPanelIds = new Set(Object.keys(nextPanels));
  if (validPanelIds.size === 0) {
    return null;
  }

  const root = sanitizeSerializedGridNode(options.layout.grid?.root, validPanelIds);
  if (!root) {
    return null;
  }

  const activeGroup =
    typeof options.layout.activeGroup === "string" && options.layout.activeGroup.length > 0
      ? options.layout.activeGroup
      : undefined;

  return {
    grid: {
      ...options.layout.grid,
      root: root as unknown as SerializedDockview["grid"]["root"],
    },
    panels: nextPanels,
    ...(activeGroup ? { activeGroup } : {}),
  };
}

export const useWorktreeChatLayoutStore = create<WorktreeChatLayoutStoreState>()(
  persist(
    (set) => ({
      layoutsByWorktreeId: {},
      setLayout: (worktreeId, layout) =>
        set((state) => ({
          layoutsByWorktreeId: {
            ...state.layoutsByWorktreeId,
            [worktreeId]: layout,
          },
        })),
      clearLayout: (worktreeId) =>
        set((state) => {
          if (!state.layoutsByWorktreeId[worktreeId]) {
            return state;
          }
          const next = { ...state.layoutsByWorktreeId };
          delete next[worktreeId];
          return { layoutsByWorktreeId: next };
        }),
    }),
    {
      name: WORKTREE_CHAT_LAYOUT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        layoutsByWorktreeId: state.layoutsByWorktreeId,
      }),
    },
  ),
);
