import { AuthFilesystemReadScope, EnvironmentId } from "@t3tools/contracts";
import { RegistryContext, RegistryProvider } from "@effect/atom-react";
import type { VcsRefTarget } from "@t3tools/client-runtime/state/vcs";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  sessionAtom: {},
  searchError: null as string | null,
  searchEntries: vi.fn(() => null),
  shellState: { generation: 0, status: "synchronizing" },
  listRefs: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: () => mocks.sessionAtom },
}));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: "connected", error: null } },
  }),
}));
vi.mock("./pull-requests", () => ({ composerPullRequests: {} }));
vi.mock("./projects", () => ({
  projectEnvironment: { searchEntries: mocks.searchEntries },
}));
vi.mock("./atom-registry", () => ({ appAtomRegistry: { refresh: mocks.refresh } }));
vi.mock("./orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("./vcs", () => ({ vcsEnvironment: { listRefs: mocks.listRefs } }));
vi.mock("./shell", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentShell: { stateValueAtom: Atom.family(() => Atom.make(mocks.shellState)) } };
});
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return { olderSettledThreads: { olderSettledAtom: () => Atom.make(null) }, threadFamilies: {} };
});
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === mocks.sessionAtom
        ? { authenticated: true, scopes: [AuthFilesystemReadScope] }
        : null,
    error: atom === mocks.sessionAtom ? null : mocks.searchError,
    isPending: false,
    refresh: () => {},
  }),
}));

import {
  useComposerPathSearch,
  usePaginatedBranches,
  useThreadSearch,
  type ComposerPathSearchTarget,
} from "./queries";

it.each([
  { status: "synchronizing", generation: 0, query: "missing", pending: true },
  { status: "synchronizing", generation: 1, query: "missing", pending: false },
  { status: "live", generation: 1, query: "missing", pending: false },
  { status: "cached", generation: 0, query: "missing", pending: false },
  { status: "empty", generation: 0, query: "missing", pending: false },
  { status: "synchronizing", generation: 0, query: "", pending: false },
  { status: "synchronizing", generation: 0, query: "a", pending: true },
])("reports title search loading for $status generation $generation query '$query'", (state) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.shellState = { status: state.status, generation: state.generation };
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  let pending: boolean | undefined;
  function Probe() {
    const result = useThreadSearch([EnvironmentId.make(JSON.stringify(state))], state.query, {
      titlesOnly: true,
    });
    useLayoutEffect(() => {
      pending = result.isPending;
    });
    return null;
  }
  act(() =>
    root.render(
      <RegistryProvider>
        <Probe />
      </RegistryProvider>,
    ),
  );
  expect(pending).toBe(state.pending);
});

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mocks.searchEntries.mockClear();
  mocks.searchError = null;
  const root = createRoot(document.createElement("div"));
  let result: ReturnType<typeof useComposerPathSearch>;
  function Probe({ target }: { readonly target: ComposerPathSearchTarget }) {
    const state = useComposerPathSearch(target);
    useLayoutEffect(() => {
      result = state;
    });
    return null;
  }

  return {
    get result() {
      return result;
    },
    render(target: ComposerPathSearchTarget) {
      act(() => root.render(<Probe target={{ ...target }} />));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      vi.useRealTimers();
    },
  };
}

const target = {
  environmentId: EnvironmentId.make("test-environment"),
  cwd: "/repo",
  query: "src",
};

it("keeps the original search deadline when rerenders have equivalent targets", () => {
  using harness = setup();
  harness.render({ ...target, query: null });
  harness.render({ ...target, query: " src " });
  act(() => vi.advanceTimersByTime(100));
  harness.render(target);
  act(() => vi.advanceTimersByTime(99));
  expect(mocks.searchEntries).not.toHaveBeenCalled();

  act(() => vi.advanceTimersByTime(1));
  expect(mocks.searchEntries).toHaveBeenCalledExactlyOnceWith({
    environmentId: target.environmentId,
    input: { cwd: target.cwd, query: target.query, limit: 20 },
  });
});

it.each([
  { field: "environment", changed: { ...target, environmentId: EnvironmentId.make("other") } },
  { field: "project directory", changed: { ...target, cwd: "/other" } },
  { field: "query", changed: { ...target, query: "test" } },
])("hides the previous error while the $field change debounces", ({ changed }) => {
  using harness = setup();
  mocks.searchError = "File search failed";
  harness.render(target);
  expect(harness.result.error).toBe("File search failed");

  harness.render(changed);
  expect(harness.result).toMatchObject({ error: null, isPending: true });

  act(() => vi.advanceTimersByTime(200));
  expect(harness.result).toMatchObject({ error: "File search failed", isPending: false });
});

it.each([
  { field: "environment", changed: { ...target, environmentId: EnvironmentId.make("other") } },
  { field: "project directory", changed: { ...target, cwd: "/other" } },
  { field: "query", changed: { ...target, query: "test" } },
])("restarts the search deadline when the $field changes", ({ changed }) => {
  using harness = setup();
  harness.render({ ...target, query: null });
  harness.render(target);
  act(() => vi.advanceTimersByTime(100));
  harness.render(changed);

  act(() => vi.advanceTimersByTime(100));
  expect(mocks.searchEntries).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(99));
  expect(mocks.searchEntries).not.toHaveBeenCalled();

  act(() => vi.advanceTimersByTime(1));
  expect(mocks.searchEntries).toHaveBeenCalledExactlyOnceWith({
    environmentId: changed.environmentId,
    input: { cwd: changed.cwd, query: changed.query, limit: 20 },
  });
});

it("keeps compiled branch results stable and resets pagination for a new target or refresh", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  const pages = Atom.family((key: string) => {
    const [, cwd, cursor] = JSON.parse(key) as [string, string, number | null];
    return Atom.make(
      AsyncResult.success({
        refs: [
          { name: `${cwd}-${cursor ?? 0}`, current: false, isDefault: false, worktreePath: null },
        ],
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: cursor === null ? 100 : null,
        totalCount: 2,
      }),
    );
  });
  mocks.listRefs.mockImplementation(
    ({
      environmentId,
      input,
    }: {
      environmentId: EnvironmentId;
      input: { cwd: string; cursor?: number };
    }) => pages(JSON.stringify([environmentId, input.cwd, input.cursor ?? null])),
  );
  mocks.refresh.mockClear();
  const root = createRoot(document.createElement("div"));
  using _cleanup = {
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
    },
  };
  let current: ReturnType<typeof usePaginatedBranches>;
  function Probe({ target }: { target: VcsRefTarget }) {
    const result = usePaginatedBranches(target);
    useLayoutEffect(() => {
      current = result;
    });
    return null;
  }
  const render = (cwd: string | null, options: Partial<VcsRefTarget> = {}) =>
    act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <Probe target={{ environmentId: target.environmentId, cwd, ...options }} />
        </RegistryContext.Provider>,
      ),
    );
  render("/repo");
  const first = current!;
  render("/repo");
  expect(current!.data).toBe(first.data);
  expect(current!.refs).toBe(first.refs);
  expect(current!.refresh).toBe(first.refresh);
  expect(current!.loadNext).toBe(first.loadNext);
  act(() =>
    registry.set(
      pages(JSON.stringify([target.environmentId, "/repo", null])),
      AsyncResult.success({
        ...first.data!,
        refs: [{ name: "/repo-0", current: true, isDefault: false, worktreePath: null }],
      }),
    ),
  );
  expect(current!.refs[0]?.current).toBe(true);
  act(() => current!.loadNext());
  expect(current!.refs.map((ref) => ref.name)).toEqual(["/repo-0", "/repo-100"]);
  act(() => current!.refresh());
  expect(current!.refs.map((ref) => ref.name)).toEqual(["/repo-0"]);
  expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(
    pages(JSON.stringify([target.environmentId, "/repo", null])),
  );
  act(() => current!.loadNext());
  render("/other");
  expect(current!.refs.map((ref) => ref.name)).toEqual(["/other-0"]);
  act(() => current!.loadNext());
  render("/other", { query: "feature" });
  expect(current!.refs).toHaveLength(1);
  act(() => current!.loadNext());
  render("/other", { environmentId: EnvironmentId.make("other-environment"), query: "feature" });
  expect(current!.refs).toHaveLength(1);
  render(null);
  expect(current!.data).toBeNull();
  expect(current!.refs).toEqual([]);
});
