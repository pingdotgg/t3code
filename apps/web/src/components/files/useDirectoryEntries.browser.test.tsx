import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { useEffect } from "react";
import { act, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

const { listEntries } = vi.hoisted(() => ({ listEntries: vi.fn() }));
vi.mock("~/state/projects", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  return {
    projectEnvironment: {
      listEntries: (request: unknown) => Atom.make(Effect.promise(() => listEntries(request))),
    },
  };
});

import { useDirectoryEntries } from "./useDirectoryEntries";

function setup() {
  let view!: ReturnType<typeof useDirectoryEntries>;
  const calls: Array<{ path: string; resolve: (entries: readonly ProjectEntry[]) => void }> = [];
  let activeQueries = 0;
  let peakQueries = 0;
  function Probe() {
    const result = useDirectoryEntries(EnvironmentId.make("files-test"), "/workspace");
    useEffect(() => {
      view = result;
    });
    return null;
  }

  async function settle(index: number, entries: readonly ProjectEntry[] = []) {
    await act(async () => calls[index]!.resolve(entries));
  }

  listEntries.mockReset().mockImplementation((request) => {
    activeQueries++;
    peakQueries = Math.max(peakQueries, activeQueries);
    return new Promise((resolve) => {
      calls.push({
        path: request.input.directoryPath,
        resolve: (entries) => {
          activeQueries--;
          resolve({ entries });
        },
      });
    });
  });
  return {
    Probe,
    settle,
    calls,
    get view() {
      return view;
    },
    get activeQueries() {
      return activeQueries;
    },
    resetPeakQueries() {
      peakQueries = activeQueries;
    },
    get peakQueries() {
      return peakQueries;
    },
  };
}

it.each([1, 2, 3, 4, 5])("coalesces 20 overlapping refreshes (sample %s)", async () => {
  const state = setup();
  await using screen = await render(<state.Probe />, { router: false });
  await state.settle(0);
  await act(async () => {
    for (let index = 0; index < 20; index++) state.view.refresh();
  });
  for (let index = 1; index < state.calls.length; index++) await state.settle(index);
  console.log(`20 overlapping refreshes: ${state.calls.length - 1} root listing requests`);
  expect(state.calls).toHaveLength(3); // Initial load, active refresh, one final rescan.
  expect(state.view.isPending).toBe(false);
});

it("rescans mutations during both the initial listing and the follow-up", async () => {
  const state = setup();
  await using screen = await render(<state.Probe />, { router: false });
  await act(async () => state.view.refresh());
  await state.settle(0);
  expect(state.calls).toHaveLength(2);
  await act(async () => {
    state.view.refresh();
    state.view.refresh();
  });
  await state.settle(1);
  expect(state.calls).toHaveLength(3);
  const entry = { path: "latest.txt", kind: "file" } as const;
  await state.settle(2, [entry]);
  expect(state.view.entries).toEqual([entry]);
  expect(state.view.isPending).toBe(false);
});

it("shares the follow-up promise and does not resolve callers before the final listing", async () => {
  const state = setup();
  await using screen = await render(<state.Probe />, { router: false });
  let completed = false;
  const first = state.view.load("", true);
  const second = state.view.load("", true);
  expect(second).toBe(first);
  void first.then(() => {
    completed = true;
  });
  await state.settle(0);
  expect(completed).toBe(false);
  await state.settle(1);
  expect(completed).toBe(true);
});

it("retains the four-query concurrency bound across directories and refreshes", async () => {
  const folders = Array.from({ length: 8 }, (_, index) => ({
    path: `folder-${index}`,
    kind: "directory" as const,
  }));
  const state = setup();
  await using screen = await render(<state.Probe />, { router: false });
  await state.settle(0, folders);
  await act(async () => {
    for (const folder of folders) void state.view.load(folder.path);
  });
  for (let index = 1; index < state.calls.length; index++) {
    await state.settle(index);
  }
  expect(state.activeQueries).toBe(0);
  const refreshStart = state.calls.length;
  state.resetPeakQueries();
  await act(async () => state.view.refresh());
  expect(state.peakQueries).toBe(4);
  expect(state.activeQueries).toBe(4);
  await act(async () => {
    for (let index = 0; index < 20; index++) state.view.refresh();
  });
  for (let index = refreshStart; index < state.calls.length; index++) {
    await state.settle(index, state.calls[index]!.path === "" ? folders : []);
    expect(state.activeQueries).toBeLessThanOrEqual(4);
  }
  console.log(
    `8 folders with 20 overlapping refreshes: ${state.calls.length} total listing requests, peak ${state.peakQueries} active queries`,
  );
  expect(state.peakQueries).toBe(4);
  expect(new Set(state.calls.map((call) => call.path)).size).toBe(9);
  for (const path of ["", ...folders.map((folder) => folder.path)]) {
    expect(state.calls.filter((call) => call.path === path).length).toBeLessThanOrEqual(3);
  }
  expect(state.view.isPending).toBe(false);
});

it("does not start a queued follow-up after unmount", async () => {
  const state = setup();
  await using screen = await render(<state.Probe />, { router: false });
  await act(async () => state.view.refresh());
  await screen.unmount();
  await state.settle(0);
  expect(state.calls).toHaveLength(1);
});
