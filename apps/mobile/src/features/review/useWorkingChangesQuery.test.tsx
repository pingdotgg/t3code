// @vitest-environment jsdom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  revision: 0,
  generation: 0,
  requests: { all: 0, staged: 0, unstaged: 0 },
  listeners: new Set<() => void>(),
}));

function subscribe(listener: () => void) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}
function notify() {
  for (const listener of state.listeners) listener();
}
const refresh = {
  all: () => {
    state.requests.all++;
    // Bound a regression so the old feedback loop fails without hanging the test.
    if (state.requests.all > 20) return;
    state.revision++;
    notify();
  },
  staged: () => state.requests.staged++,
  unstaged: () => state.requests.unstaged++,
};

vi.mock("../../state/review", () => ({
  reviewEnvironment: {
    diffPreview: ({ input }: { input: { workingTreeScope?: "staged" | "unstaged" } }) =>
      input.workingTreeScope ?? "all",
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (scope: keyof typeof refresh) => {
    const revision = useSyncExternalStore(subscribe, () => state.revision);
    return { data: { revision }, error: null, isPending: false, refresh: refresh[scope] };
  },
}));

import { useWorkingChangesQuery } from "./useWorkingChangesQuery";

function Reader() {
  // The parent subscribes to the combined preview's response timestamp.
  const revision = useSyncExternalStore(subscribe, () => String(state.revision));
  const generation = useSyncExternalStore(subscribe, () => state.generation);
  const input = { environmentId: EnvironmentId.make("env"), cwd: "/repo", revision, generation };
  useWorkingChangesQuery({ ...input, scope: undefined });
  useWorkingChangesQuery({ ...input, scope: "staged" });
  useWorkingChangesQuery({ ...input, scope: "unstaged" });
  return null;
}

let root: Root | undefined;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.revision = 0;
  state.generation = 0;
  state.requests = { all: 0, staged: 0, unstaged: 0 };
  state.listeners.clear();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

it("settles after a combined response rather than refreshing its own timestamp forever", async () => {
  await act(async () => root!.render(<Reader />));
  expect(state.requests.all).toBe(1);
  const scoped = { ...state.requests };
  await act(async () => {
    state.revision++;
    notify();
  });
  expect(state.requests.all).toBe(1);
  expect(state.requests.staged).toBe(scoped.staged + 1);
  expect(state.requests.unstaged).toBe(scoped.unstaged + 1);
});

it("refreshes all three previews after a Git mutation and then settles", async () => {
  await act(async () => root!.render(<Reader />));
  const before = { ...state.requests };
  await act(async () => {
    state.generation++;
    notify();
  });
  expect(state.requests.all).toBe(before.all + 1);
  expect(state.requests.staged).toBeGreaterThan(before.staged);
  expect(state.requests.unstaged).toBeGreaterThan(before.unstaged);
  const settled = { ...state.requests };
  await act(async () => notify());
  expect(state.requests).toEqual(settled);
});
