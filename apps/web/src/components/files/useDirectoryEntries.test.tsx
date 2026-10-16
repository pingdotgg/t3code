import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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

let renderer: ReactTestRenderer | null;
let view: ReturnType<typeof useDirectoryEntries>;
let calls: Array<{ path: string; resolve: (entries: readonly ProjectEntry[]) => void }>;
let activeQueries: number;
let peakQueries: number;

function Probe() {
  const result = useDirectoryEntries(EnvironmentId.make("files-test"), "/workspace");
  useEffect(() => {
    view = result;
  });
  return null;
}

async function mount() {
  await act(async () => {
    renderer = create(<Probe />);
  });
}

async function settle(index: number, entries: readonly ProjectEntry[] = []) {
  await act(async () => calls[index]!.resolve(entries));
}

beforeEach(() => {
  renderer = null;
  calls = [];
  activeQueries = 0;
  peakQueries = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it.each([1, 2, 3, 4, 5])("coalesces 20 overlapping refreshes (sample %s)", async () => {
  await mount();
  await settle(0);
  await act(async () => {
    for (let index = 0; index < 20; index++) view.refresh();
  });
  for (let index = 1; index < calls.length; index++) await settle(index);
  console.log(`20 overlapping refreshes: ${calls.length - 1} root listing requests`);
  expect(calls).toHaveLength(3); // Initial load, active refresh, one final rescan.
  expect(view.isPending).toBe(false);
});

it("rescans mutations during both the initial listing and the follow-up", async () => {
  await mount();
  await act(async () => view.refresh());
  await settle(0);
  expect(calls).toHaveLength(2);
  await act(async () => {
    view.refresh();
    view.refresh();
  });
  await settle(1);
  expect(calls).toHaveLength(3);
  const entry = { path: "latest.txt", kind: "file" } as const;
  await settle(2, [entry]);
  expect(view.entries).toEqual([entry]);
  expect(view.isPending).toBe(false);
});

it("shares the follow-up promise and does not resolve callers before the final listing", async () => {
  await mount();
  let completed = false;
  const first = view.load("", true);
  const second = view.load("", true);
  expect(second).toBe(first);
  void first.then(() => {
    completed = true;
  });
  await settle(0);
  expect(completed).toBe(false);
  await settle(1);
  expect(completed).toBe(true);
});

it("retains the four-query concurrency bound across directories and refreshes", async () => {
  const folders = Array.from({ length: 8 }, (_, index) => ({
    path: `folder-${index}`,
    kind: "directory" as const,
  }));
  await mount();
  await settle(0, folders);
  await act(async () => {
    for (const folder of folders) void view.load(folder.path);
    for (let index = 0; index < 20; index++) view.refresh();
  });
  for (let index = 1; index < calls.length; index++) {
    await settle(index, calls[index]!.path === "" ? folders : []);
    expect(activeQueries).toBeLessThanOrEqual(4);
  }
  console.log(
    `8 folders with 20 overlapping refreshes: ${calls.length} total listing requests, peak ${peakQueries} active queries`,
  );
  expect(peakQueries).toBe(4);
  expect(new Set(calls.map((call) => call.path)).size).toBe(9);
  for (const path of ["", ...folders.map((folder) => folder.path)]) {
    expect(calls.filter((call) => call.path === path).length).toBeLessThanOrEqual(3);
  }
  expect(view.isPending).toBe(false);
});

it("does not start a queued follow-up after unmount", async () => {
  await mount();
  await act(async () => view.refresh());
  await act(async () => renderer?.unmount());
  renderer = null;
  await settle(0);
  expect(calls).toHaveLength(1);
});
