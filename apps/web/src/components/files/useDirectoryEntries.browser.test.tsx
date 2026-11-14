import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { useEffect } from "react";
import { act, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

const { listEntries, mocks } = vi.hoisted(() => ({
  listEntries: vi.fn(),
  mocks: {
    reconnect: false,
    generation: 0,
    reachable: null as unknown as Atom.Writable<boolean>,
    connectedSession: null as unknown as Atom.Writable<number>,
  },
}));
vi.mock("~/connection/catalog", () => ({
  environmentCatalog: {
    sessionGenerationAtom: () => Atom.make((get) => get(mocks.connectedSession)),
  },
}));
vi.mock("~/state/projects", () => {
  const queries = new Map<string, ReturnType<typeof makeQuery>>();
  const makeQuery = (request: unknown) => Atom.make(Effect.promise(() => listEntries(request)));
  return {
    projectEnvironment: {
      listEntries: (request: unknown) =>
        mocks.reconnect
          ? Atom.make((get) =>
              get(mocks.reachable)
                ? AsyncResult.success({
                    entries: [{ path: "README.md", kind: "file" }],
                    truncated: false,
                  })
                : AsyncResult.failure(Cause.fail(new Error("Environment is reconnecting."))),
            )
          : (() => {
              const key = JSON.stringify([mocks.generation, request]);
              let query = queries.get(key);
              if (!query) {
                query = makeQuery(request);
                queries.set(key, query);
              }
              return query;
            })(),
    },
  };
});

import { useDirectoryEntries } from "./useDirectoryEntries";

function setup() {
  mocks.reconnect = false;
  mocks.generation++;
  mocks.reachable = Atom.make(false);
  mocks.connectedSession = Atom.make(1);
  let view!: ReturnType<typeof useDirectoryEntries>;
  const calls: Array<{ path: string; resolve: (entries: readonly ProjectEntry[]) => void }> = [];
  let activeQueries = 0;
  let peakQueries = 0;
  function HookProbe() {
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
    Probe: () => (
      <RegistryContext.Provider value={appAtomRegistry}>
        <HookProbe />
      </RegistryContext.Provider>
    ),
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

it("coalesces 20 overlapping refreshes", async () => {
  const state = setup();
  // The hook probe does not navigate.
  await using _screen = await render(<state.Probe />, { router: false });
  await state.settle(0);
  await act(async () => {
    for (let index = 0; index < 20; index++) state.view.refresh();
  });
  for (let index = 1; index < state.calls.length; index++) await state.settle(index);
  expect(state.calls).toHaveLength(3); // Initial load, active refresh, one final rescan.
  expect(state.view.isPending).toBe(false);
});

it("rescans mutations during both the initial listing and the follow-up", async () => {
  const state = setup();
  // The hook probe does not navigate.
  await using _screen = await render(<state.Probe />, { router: false });
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

  const folder = { path: "src", kind: "directory" } as const;
  const child = { path: "src/new.ts", kind: "file" } as const;
  await act(async () => {
    void state.view.load("src");
  });
  await state.settle(3, [child]);
  await act(async () => {
    void state.view.load("", true);
  });
  await state.settle(4, [folder]);
  expect(state.view.entries).toEqual([folder, child]);
});

it("shares the follow-up promise and does not resolve callers before the final listing", async () => {
  const state = setup();
  // The hook probe does not navigate.
  await using _screen = await render(<state.Probe />, { router: false });
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
  // The hook probe does not navigate.
  await using _screen = await render(<state.Probe />, { router: false });
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
  expect(state.peakQueries).toBe(4);
  expect(new Set(state.calls.map((call) => call.path)).size).toBe(9);
  for (const path of ["", ...folders.map((folder) => folder.path)]) {
    expect(state.calls.filter((call) => call.path === path).length).toBeLessThanOrEqual(3);
  }
  expect(state.view.isPending).toBe(false);
});

it("does not start a queued follow-up after unmount", async () => {
  const state = setup();
  // The hook probe does not navigate.
  await using screen = await render(<state.Probe />, { router: false });
  await act(async () => state.view.refresh());
  await screen.unmount();
  await state.settle(0);
  expect(state.calls).toHaveLength(1);
});

function ReconnectProbe() {
  const directory = useDirectoryEntries(EnvironmentId.make("env-files"), "/repo");
  return (
    <output>{directory.error ?? directory.entries.map((entry) => entry.path).join(",")}</output>
  );
}

it("reads a folder that failed while unreachable again once a new session is up", async () => {
  setup();
  mocks.reconnect = true;
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ReconnectProbe />
    </RegistryContext.Provider>,
    // The hook probe does not navigate.
    { router: false },
  );
  await expect.element(screen.getByText("Environment is reconnecting.")).toBeInTheDocument();
  await act(() => {
    appAtomRegistry.set(mocks.reachable, true);
    appAtomRegistry.set(mocks.connectedSession, 2);
  });
  await expect.element(screen.getByText("README.md")).toBeInTheDocument();
});

it("reloads a removed folder when it reappears under the same name", async () => {
  const state = setup();
  // The hook probe does not navigate.
  await using _screen = await render(<state.Probe />, { router: false });
  const folder = { path: "src", kind: "directory" } as const;
  await state.settle(0, [folder]);
  await act(async () => {
    void state.view.load("src");
  });
  await state.settle(1, [{ path: "src/old.ts", kind: "file" }]);

  await act(async () => {
    state.view.refresh();
    void state.view.load("src", true);
  });
  await state.settle(2, []);
  expect(state.view.entries).toEqual([]);

  await act(async () => state.view.refresh());
  await state.settle(4, [folder]);
  await act(async () => {
    void state.view.load("src");
  });
  const replacementRefresh = state.view.load("src", true);
  await state.settle(3, [{ path: "src/old.ts", kind: "file" }]);
  expect(state.view.load("src", true)).toBe(replacementRefresh);
  expect(state.view.entries).toEqual([folder]);
  expect(state.view.loadingDirectories.has("src")).toBe(true);
  await state.settle(5, [{ path: "src/new.ts", kind: "file" }]);
  await state.settle(6, [{ path: "src/new.ts", kind: "file" }]);
  await replacementRefresh;
  expect(state.view.entries).toEqual([folder, { path: "src/new.ts", kind: "file" }]);
  expect(state.view.isPending).toBe(false);
});
