import type { ThreadId, WorktreeId } from "@repo/contracts";
import type { SerializedDockview } from "dockview";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKTREE_ID = "worktree-1" as WorktreeId;
const OTHER_WORKTREE_ID = "worktree-2" as WorktreeId;
const THREAD_A = "thread-a" as ThreadId;
const THREAD_B = "thread-b" as ThreadId;
const THREAD_C = "thread-c" as ThreadId;

type WorktreeChatLayoutStoreModule = typeof import("./worktreeChatLayoutStore");

let worktreeChatLayoutStoreModule: WorktreeChatLayoutStoreModule;

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function createLayout(): SerializedDockview {
  return {
    grid: {
      root: {
        type: "leaf",
        size: 1,
        data: {
          id: "group-1",
          views: [THREAD_A, THREAD_B],
          activeView: THREAD_A,
        },
      },
      height: 800,
      width: 1200,
      orientation: "horizontal" as SerializedDockview["grid"]["orientation"],
    },
    panels: {
      [THREAD_A]: {
        id: THREAD_A,
        contentComponent: "thread-chat",
        title: "Thread A",
        params: {
          threadId: THREAD_A,
          worktreeId: WORKTREE_ID,
          title: "Thread A",
        },
      },
      [THREAD_B]: {
        id: THREAD_B,
        contentComponent: "thread-chat",
        title: "Thread B",
        params: {
          threadId: THREAD_B,
          worktreeId: WORKTREE_ID,
          title: "Thread B",
        },
      },
    },
    activeGroup: "group-1",
  } as SerializedDockview;
}

describe("worktreeChatLayoutStore", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", createMemoryStorage());
    worktreeChatLayoutStoreModule = await import("./worktreeChatLayoutStore");
    worktreeChatLayoutStoreModule.useWorktreeChatLayoutStore.setState({ layoutsByWorktreeId: {} });
  });

  it("stores layouts by worktree id", () => {
    const layout = createLayout();

    worktreeChatLayoutStoreModule.useWorktreeChatLayoutStore
      .getState()
      .setLayout(WORKTREE_ID, layout);

    expect(
      worktreeChatLayoutStoreModule.useWorktreeChatLayoutStore.getState().layoutsByWorktreeId[
        WORKTREE_ID
      ],
    ).toEqual(layout);
  });

  it("falls back to an empty state when persisted JSON is invalid", async () => {
    localStorage.setItem(worktreeChatLayoutStoreModule.WORKTREE_CHAT_LAYOUT_STORAGE_KEY, "{");

    vi.resetModules();
    const { useWorktreeChatLayoutStore: rehydratedStore } =
      await import("./worktreeChatLayoutStore");

    expect(rehydratedStore.getState().layoutsByWorktreeId).toEqual({});
  });

  it("sanitizes missing or deleted panel ids from a restored layout", () => {
    const sanitized = worktreeChatLayoutStoreModule.sanitizeSerializedDockviewLayout({
      layout: createLayout(),
      validThreadIds: new Set([THREAD_A]),
      worktreeId: WORKTREE_ID,
    });

    expect(sanitized).not.toBeNull();
    expect(Object.keys(sanitized?.panels ?? {})).toEqual([THREAD_A]);
    expect(sanitized?.grid.root).toEqual({
      type: "leaf",
      size: 1,
      data: {
        id: "group-1",
        views: [THREAD_A],
        activeView: THREAD_A,
      },
    });
  });

  it("drops layouts whose panels belong to another worktree", () => {
    const layout = createLayout();
    const threadAPanel = layout.panels[THREAD_A]!;
    layout.panels[THREAD_A] = {
      ...threadAPanel,
      params: {
        threadId: THREAD_A,
        worktreeId: OTHER_WORKTREE_ID,
      },
    } as typeof threadAPanel;

    const sanitized = worktreeChatLayoutStoreModule.sanitizeSerializedDockviewLayout({
      layout,
      validThreadIds: new Set([THREAD_A, THREAD_B, THREAD_C]),
      worktreeId: WORKTREE_ID,
    });

    expect(sanitized).not.toBeNull();
    expect(Object.keys(sanitized?.panels ?? {})).toEqual([THREAD_B]);
  });
});
