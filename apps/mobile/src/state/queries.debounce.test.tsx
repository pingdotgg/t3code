import { AuthFilesystemReadScope, EnvironmentId } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import type { VcsRefTarget } from "@t3tools/client-runtime/state/vcs";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  sessionAtom: {},
  searchEntriesAtom: {},
  searchEntries: vi.fn((): unknown => mocks.searchEntriesAtom),
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
vi.mock("./threads", () => ({ olderSettledThreads: {}, threadFamilies: {} }));
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === mocks.sessionAtom
        ? { authenticated: true, scopes: [AuthFilesystemReadScope] }
        : atom === mocks.searchEntriesAtom
          ? { entries: [{ path: "src/only-in-original.ts", kind: "file" }] }
          : null,
    error: null,
    isPending: false,
    refresh: () => {},
  }),
}));

import {
  useComposerPathSearch,
  usePaginatedBranches,
  type ComposerPathSearchTarget,
} from "./queries";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mocks.searchEntries.mockClear();
  const root = createRoot(document.createElement("div"));
  let latest: ReturnType<typeof useComposerPathSearch> | null = null;
  function Probe({ target }: { readonly target: ComposerPathSearchTarget }) {
    latest = useComposerPathSearch(target);
    return null;
  }

  return {
    get result() {
      return latest;
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

it.each([
  { query: "src", expected: "src" },
  { query: "a".repeat(256), expected: "a".repeat(256) },
  {
    query: ["a".repeat(86), "b".repeat(86), "c".repeat(86), "unique.ts"].join("/"),
    expected: ["a".repeat(86), "b".repeat(86), "c".repeat(82)].join("/"),
  },
  { query: `${"a".repeat(255)}😀/boundary.ts`, expected: "a".repeat(255) },
  { query: `${"a".repeat(254)}😀/boundary.ts`, expected: `${"a".repeat(254)}😀` },
])("keeps the search deadline and bounds the request for query: $query", ({ query, expected }) => {
  using harness = setup();
  harness.render({ ...target, query: null });
  harness.render({ ...target, query: ` ${query} ` });
  act(() => vi.advanceTimersByTime(100));
  harness.render({ ...target, query });
  act(() => vi.advanceTimersByTime(99));
  expect(mocks.searchEntries).not.toHaveBeenCalled();

  act(() => vi.advanceTimersByTime(1));
  expect(mocks.searchEntries).toHaveBeenCalledExactlyOnceWith({
    environmentId: target.environmentId,
    input: { cwd: target.cwd, query: expected, limit: 20 },
  });
});

it.each([
  { field: "environment", changed: { ...target, environmentId: EnvironmentId.make("other") } },
  { field: "project directory", changed: { ...target, cwd: "/other" } },
  { field: "query", changed: { ...target, query: "test" } },
  {
    field: "query suffix beyond the request limit",
    initial: { ...target, query: `${"src/".repeat(65)}first.ts` },
    changed: { ...target, query: `${"src/".repeat(65)}other.ts` },
  },
])("restarts the search deadline when the $field changes", ({ initial = target, changed }) => {
  using harness = setup();
  harness.render({ ...target, query: null });
  harness.render(initial);
  act(() => vi.advanceTimersByTime(100));
  harness.render(changed);

  act(() => vi.advanceTimersByTime(100));
  expect(mocks.searchEntries).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(99));
  expect(mocks.searchEntries).not.toHaveBeenCalled();

  act(() => vi.advanceTimersByTime(1));
  expect(mocks.searchEntries).toHaveBeenCalledExactlyOnceWith({
    environmentId: changed.environmentId,
    input: { cwd: changed.cwd, query: changed.query.slice(0, 256), limit: 20 },
  });
});

it.each([
  { field: "environment", changed: { ...target, environmentId: EnvironmentId.make("other") } },
  { field: "project directory", changed: { ...target, cwd: "/other" } },
])("reports settled results as pending when the $field changes", ({ changed }) => {
  using harness = setup();
  harness.render(target);
  act(() => vi.advanceTimersByTime(200));
  expect(harness.result?.isPending).toBe(false);
  expect(harness.result?.entries).toHaveLength(1);

  harness.render(changed);
  expect(harness.result?.isPending).toBe(true);
  expect(harness.result?.entries).toEqual([]);
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
