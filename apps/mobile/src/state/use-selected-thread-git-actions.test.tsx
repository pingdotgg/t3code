// @vitest-environment jsdom
import { act, useEffect, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  selection: {
    selectedThread: { environmentId: "environment-1", id: "thread-1" } as unknown,
    selectedThreadProject: { workspaceRoot: "/repo" } as unknown,
    selectedEnvironmentRuntime: { connectionState: "connected" } as unknown,
  },
  worktree: { selectedThreadCwd: "/repo" as string | null, selectedThreadWorktreePath: null },
  refreshStatusCalls: [] as Array<unknown>,
  renderCount: 0,
  // Mirrors refreshStatus invalidating refs: settled refreshes rerender consumers.
  onRefreshSettled: () => {},
}));

vi.mock("./use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "refreshStatus"
      ? async (input: unknown) => {
          harness.refreshStatusCalls.push(input);
          harness.onRefreshSettled();
          return AsyncResult.success({});
        }
      : async () => AsyncResult.success({}),
}));
vi.mock("./vcs", () => ({
  vcsEnvironment: { refreshStatus: "refreshStatus" },
  vcsActionManager: { runStackedAction: () => "runStackedAction", track: vi.fn() },
}));
vi.mock("./threads", () => ({ threadEnvironment: { updateMetadata: "updateMetadata" } }));
vi.mock("./queries", () => ({ useBranches: () => ({ data: null, refresh: () => {} }) }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid" }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("./use-remote-environment-registry", () => ({ setPendingConnectionError: () => {} }));
vi.mock("./use-vcs-action-state", () => ({ showGitActionResult: () => {} }));
// Runs on every render: a refresh loop fails fast here instead of exhausting memory.
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => {
    harness.renderCount += 1;
    if (harness.renderCount > 50) {
      throw new Error("Consumer rerendered more than 50 times");
    }
    return harness.selection;
  },
}));
vi.mock("./use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => harness.worktree,
}));

import { useSelectedThreadGitActions } from "./use-selected-thread-git-actions";

let root: Root | null = null;
let rerender: () => void = () => {};

// Stands in for a Git sheet: every settled refresh causes a rerender, as the
// refs invalidation does on device.
function Consumer() {
  const [, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    rerender = bump;
  });
  useSelectedThreadGitActions();
  return null;
}

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.selection = {
    selectedThread: { environmentId: "environment-1", id: "thread-1" },
    selectedThreadProject: { workspaceRoot: "/repo" },
    selectedEnvironmentRuntime: { connectionState: "connected" },
  };
  harness.worktree = { selectedThreadCwd: "/repo", selectedThreadWorktreePath: null };
  harness.refreshStatusCalls = [];
  harness.renderCount = 0;
  harness.onRefreshSettled = () => rerender();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe("useSelectedThreadGitActions", () => {
  it("refreshes once on mount and does not loop when refreshes rerender the consumer", async () => {
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Consumer />));
    await flush();

    // Shell updates replace the thread object without changing the selection.
    harness.selection = {
      selectedThread: { environmentId: "environment-1", id: "thread-1" },
      selectedThreadProject: { workspaceRoot: "/repo" },
      selectedEnvironmentRuntime: { connectionState: "connected" },
    };
    act(() => rerender());
    await flush();

    expect(harness.refreshStatusCalls).toEqual([
      { environmentId: "environment-1", input: { cwd: "/repo" } },
    ]);
  });

  it("refreshes again when the selected thread or cwd changes", async () => {
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Consumer />));
    await flush();

    harness.selection = {
      selectedThread: { environmentId: "environment-1", id: "thread-2" },
      selectedThreadProject: { workspaceRoot: "/repo" },
      selectedEnvironmentRuntime: { connectionState: "connected" },
    };
    act(() => rerender());
    await flush();

    harness.worktree = { selectedThreadCwd: "/repo/worktree", selectedThreadWorktreePath: null };
    act(() => rerender());
    await flush();

    expect(harness.refreshStatusCalls).toEqual([
      { environmentId: "environment-1", input: { cwd: "/repo" } },
      { environmentId: "environment-1", input: { cwd: "/repo" } },
      { environmentId: "environment-1", input: { cwd: "/repo/worktree" } },
    ]);
  });

  it("refreshes once after the environment reconnects and not while it is away", async () => {
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Consumer />));
    await flush();

    for (const connectionState of ["reconnecting", "connecting", "offline"]) {
      harness.selection = {
        ...harness.selection,
        selectedEnvironmentRuntime: { connectionState },
      };
      act(() => rerender());
      await flush();
    }
    expect(harness.refreshStatusCalls).toHaveLength(1);

    // The server's cached status can be stale after a long background, so the
    // new session refreshes it once.
    harness.selection = {
      ...harness.selection,
      selectedEnvironmentRuntime: { connectionState: "connected" },
    };
    act(() => rerender());
    await flush();
    act(() => rerender());
    await flush();

    expect(harness.refreshStatusCalls).toEqual([
      { environmentId: "environment-1", input: { cwd: "/repo" } },
      { environmentId: "environment-1", input: { cwd: "/repo" } },
    ]);
  });

  it("waits for the environment to connect before the first refresh", async () => {
    harness.selection = {
      ...harness.selection,
      selectedEnvironmentRuntime: { connectionState: "connecting" },
    };
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Consumer />));
    await flush();
    expect(harness.refreshStatusCalls).toEqual([]);

    harness.selection = {
      ...harness.selection,
      selectedEnvironmentRuntime: { connectionState: "connected" },
    };
    act(() => rerender());
    await flush();

    expect(harness.refreshStatusCalls).toEqual([
      { environmentId: "environment-1", input: { cwd: "/repo" } },
    ]);
  });
});
