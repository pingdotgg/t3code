import {
  EnvironmentId,
  ProjectListEntriesError,
  type ProjectEntry,
  type ProjectListEntriesResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type Query = {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly cwd: string;
    readonly query?: string;
    readonly directoryPath?: string;
  };
};
type Result =
  | {
      readonly _tag: "Success";
      readonly value: ProjectListEntriesResult;
      readonly timestamp: number;
    }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<Error> };
type QueryState = {
  success: AsyncResult.Success<ProjectListEntriesResult, Error> | null;
  data: ProjectListEntriesResult;
  error: string | null;
  failure: ProjectListEntriesError | null;
  isPending: boolean;
  refresh: () => void;
};

const rootEntries: ProjectEntry[] = [{ kind: "directory", path: "src" }];
const firstTarget = { cwd: "/first", environmentId: EnvironmentId.make("first") };

const mocks = vi.hoisted(() => {
  const createState = () => ({
    requests: [] as {
      readonly query: Query;
      readonly signal?: AbortSignal;
      readonly resolve: (result: Result) => void;
    }[],
    responseTimestamp: 0,
    reconnect: () => {},
    rootQuery: null as unknown as QueryState,
    searchQuery: null as unknown as QueryState,
    results: new WeakMap<
      object,
      {
        data: ProjectListEntriesResult;
        error: string | null;
        pending: boolean;
        result: AsyncResult.AsyncResult<ProjectListEntriesResult, Error>;
      }
    >(),
  });
  return { createState, state: createState() };
});

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: (_registry: unknown, query: Query, options: { signal?: AbortSignal }) =>
    new Promise<Result>((resolve) =>
      mocks.state.requests.push({ query, signal: options.signal, resolve }),
    ),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { refresh: () => {} } }));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    listEntries: (query: Query) => query,
    searchEntries: (query: Query) => query,
  },
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { sessionGenerationAtom: () => ({}) },
}));
vi.mock("../../state/queries", () => ({ useDebouncedValue: (value: string) => value }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Partial<Query>) => {
    const state = mocks.state;
    const query = atom.input?.query === undefined ? state.rootQuery : state.searchQuery;
    if (query.success) return query.success;
    const cached = state.results.get(query);
    if (
      cached &&
      cached.data === query.data &&
      cached.error === query.error &&
      cached.pending === query.isPending
    ) {
      return cached.result;
    }
    const result = query.error
      ? AsyncResult.fail(query.failure ?? new Error(query.error), {
          previousSuccess: Option.some(AsyncResult.success(query.data)),
        })
      : AsyncResult.success(query.data, {
          waiting: query.isPending,
          timestamp: ++state.responseTimestamp,
        });
    state.results.set(query, {
      data: query.data,
      error: query.error,
      pending: query.isPending,
      result,
    });
    return result;
  },
  useAtomRefresh: () => mocks.state.rootQuery.refresh,
  useAtomMount: () => {},
  useAtomSubscribe: (_atom: unknown, callback: () => void) => {
    mocks.state.reconnect = callback;
  },
}));

const { Children, Nothing } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Nothing: () => null,
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: Children,
  RefreshControl: Nothing,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: Nothing }));
vi.mock("../../native/native-layout-metrics", () => ({ useNativeColumnLayoutMetrics: () => null }));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: <T,>(props: {
    data: ReadonlyArray<T>;
    keyExtractor: (item: T) => string;
    renderItem: (info: { item: T }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.length === 0
        ? props.ListEmptyComponent
        : props.data.map((item) => (
            <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
          ))}
    </div>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button aria-label={label} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: Nothing }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: Nothing }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/PierreEntryIcon", () => ({ PierreEntryIcon: Nothing }));
vi.mock("../../lib/cn", () => ({ cn: () => "" }));

import { FileTreeBrowser } from "./FileTreeBrowser";
import { useFileTreeEntries } from "./useFileTreeEntries";

type Hook = typeof useFileTreeEntries;
type Input = Parameters<Hook>[0];

function setup(withBrowser = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const state = mocks.createState();
  mocks.state = state;
  const rootQuery: QueryState = {
    success: null,
    data: { entries: rootEntries, truncated: false },
    error: null,
    failure: null,
    isPending: false,
    refresh: vi.fn(),
  };
  state.rootQuery = rootQuery;
  const searchQuery: QueryState = { ...rootQuery, data: { entries: [], truncated: false } };
  state.searchQuery = searchQuery;
  const { requests } = state;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let current: ReturnType<Hook>;
  let renders = 0;
  let controlledSelection: string | undefined;
  function Probe(input: Input) {
    if (++renders > 100 && withBrowser) throw new Error("File tree did not settle");
    const result = useFileTreeEntries(input);
    useLayoutEffect(() => {
      current = result;
    });
    return withBrowser ? (
      <FileTreeBrowser
        key={JSON.stringify([input.environmentId, input.cwd])}
        {...result}
        selectedPath={controlledSelection ?? result.selectedPath}
        searchQuery=""
        onLoadDirectory={result.loadDirectory}
        onRefresh={result.refresh}
        onSelectFile={result.selectPath}
      />
    ) : null;
  }
  const unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return {
    requests,
    rootQuery,
    searchQuery,
    get searchSuccess() {
      const result = searchQuery.success ?? state.results.get(searchQuery)?.result;
      if (result?._tag !== "Success") throw new Error("Search has not succeeded");
      return result;
    },
    get responseTimestamp() {
      return state.responseTimestamp;
    },
    controlSelection(path: string) {
      controlledSelection = path;
    },
    updateView(expanded: string[], selected: string) {
      renders = 0;
      act(() => {
        current.setExpandedPaths(() => new Set(expanded));
        current.selectPath(selected);
      });
    },
    unmount,
    get current() {
      return current;
    },
    get rows() {
      return [...container.querySelectorAll("button")].map((button) =>
        button.getAttribute("aria-label"),
      );
    },
    press(label: string) {
      renders = 0;
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      if (!button) throw new Error(`No row labelled ${label}`);
      act(() => button.click());
    },
    render(target: Partial<Input> = {}) {
      renders = 0;
      const probe = <Probe {...firstTarget} searchQuery="" {...target} />;
      act(() => root.render(probe));
    },
    load(path = "src", refresh = false) {
      renders = 0;
      act(() => {
        void current.loadDirectory(path, refresh);
      });
    },
    async succeed(index: number, entries: ProjectEntry[] = []) {
      renders = 0;
      await act(async () => {
        requests[index]!.resolve({
          _tag: "Success",
          value: { entries, truncated: false },
          timestamp: ++state.responseTimestamp,
        });
      });
    },
    async fail(index: number, message = "Directory unavailable") {
      renders = 0;
      await act(async () => {
        requests[index]!.resolve({ _tag: "Failure", cause: Cause.fail(new Error(message)) });
      });
    },
    [Symbol.dispose]: unmount,
  };
}

describe("file tree workspace state", () => {
  it("retries failed folders once on reconnect", async () => {
    using screen = setup();
    screen.render();
    screen.load();
    await screen.fail(0);
    act(() => mocks.state.reconnect());
    expect(screen.requests).toHaveLength(2);
    act(() => mocks.state.reconnect());
    expect(screen.requests).toHaveLength(2);
    await screen.succeed(1);
    act(() => mocks.state.reconnect());
    expect(screen.requests).toHaveLength(2);
  });

  it("publishes immutable loading and loaded snapshots", async () => {
    using screen = setup();
    screen.render();
    const initial = screen.current;
    screen.load();
    const loading = screen.current;
    expect(loading.isPending).toBe(true);
    expect([...loading.loadingDirectories]).toEqual(["src"]);
    expect([...initial.loadingDirectories]).toEqual([]);
    await screen.succeed(0, [{ kind: "file", path: "src/first.ts" }]);
    expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src", "src/first.ts"]);
    expect([...screen.current.loadedDirectories]).toEqual(["src"]);
    expect(screen.current.isPending).toBe(false);
    expect([...screen.current.loadingDirectories]).toEqual([]);
    expect(loading.entries.map((entry) => entry.path)).toEqual(["src"]);
    expect([...loading.loadedDirectories]).toEqual([]);
    expect([...loading.loadingDirectories]).toEqual(["src"]);
  });

  it.each([{ cwd: "/second" }, { environmentId: EnvironmentId.make("second") }])(
    "isolates directory state and restores it on return from %j",
    async (target) => {
      using screen = setup();
      screen.render();
      screen.load();
      await screen.succeed(0, [{ kind: "file", path: "src/first.ts" }]);

      screen.updateView(["src"], "src/first.ts");
      const firstView = screen.current;
      screen.render(target);
      expect([...screen.current.expandedPaths]).toEqual([]);
      expect(screen.current.selectedPath).toBeNull();
      expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src"]);
      expect([...screen.current.loadedDirectories]).toEqual([]);
      expect([...screen.current.loadingDirectories]).toEqual([]);
      screen.load();
      expect(screen.requests[1]!.query).toEqual({
        environmentId: target.environmentId ?? firstTarget.environmentId,
        input: { cwd: target.cwd ?? firstTarget.cwd, directoryPath: "src" },
      });
      await screen.succeed(1, [{ kind: "file", path: "src/second.ts" }]);

      screen.updateView([], "src/second.ts");
      expect([...firstView.expandedPaths]).toEqual(["src"]);
      expect(firstView.selectedPath).toBe("src/first.ts");
      screen.render();
      expect([...screen.current.expandedPaths]).toEqual(["src"]);
      expect(screen.current.selectedPath).toBe("src/first.ts");
      expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src", "src/first.ts"]);
      expect([...screen.current.loadedDirectories]).toEqual(["src"]);
      screen.load();
      expect(screen.requests).toHaveLength(3);
      await screen.succeed(2, [{ kind: "file", path: "src/first.ts" }]);

      screen.render(target);
      expect([...screen.current.expandedPaths]).toEqual([]);
      expect(screen.current.selectedPath).toBe("src/second.ts");
      expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src", "src/second.ts"]);
      expect([...screen.current.loadedDirectories]).toEqual(["src"]);
    },
  );

  it("ignores stale successes and failures after leaving and returning to a workspace", async () => {
    using screen = setup();
    screen.render();
    screen.load();
    screen.load("src/other");
    screen.render({ cwd: "/second" });
    screen.render();
    screen.load();

    await screen.succeed(0, [{ kind: "file", path: "src/stale.ts" }]);
    await screen.fail(1, "Stale error");
    expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src"]);
    expect(screen.current.error).toBeNull();
    expect([...screen.current.loadingDirectories]).toEqual(["src"]);
    expect(screen.current.isPending).toBe(true);

    await screen.succeed(2, [{ kind: "file", path: "src/current.ts" }]);
    expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src", "src/current.ts"]);
    expect(screen.current.error).toBeNull();
    expect(screen.current.isPending).toBe(false);
    expect([...screen.current.loadingDirectories]).toEqual([]);
  });

  it("retains recent listings and expansion when leaving a large workspace", async () => {
    using screen = setup();
    screen.render();
    const paths = Array.from({ length: 70 }, (_, index) => `src/directory-${index}`);
    screen.load();
    await screen.succeed(
      0,
      paths.map((path) => ({ kind: "directory", path })),
    );
    for (const path of paths) {
      screen.load(path);
      await screen.succeed(screen.requests.length - 1, [{ kind: "file", path: `${path}/file.ts` }]);
    }
    screen.updateView(["src", ...paths], `${paths[69]}/file.ts`);
    screen.render({ cwd: "/other" });
    screen.render();
    expect(screen.current.loadedDirectories.size).toBe(64);
    expect(screen.current.loadedDirectories.has(paths[69]!)).toBe(true);
    expect(screen.current.expandedPaths.size).toBe(71);
    expect(screen.current.selectedPath).toBe(`${paths[69]}/file.ts`);
    for (let index = 1; index <= 8; index++) screen.render({ cwd: `/workspace-${index}` });
    screen.render();
    expect(screen.current.loadedDirectories.size).toBe(0);
    expect(screen.current.expandedPaths.size).toBe(0);
    expect(screen.current.selectedPath).toBeNull();
  });

  it("retries a failed folder only when the user expands it again", async () => {
    using screen = setup(true);
    screen.render();
    expect(screen.rows).toEqual(["src"]);
    expect(screen.requests).toHaveLength(0);

    screen.press("src");
    expect(screen.requests).toHaveLength(1);
    await screen.fail(0);
    expect(screen.current.error).toBe("Directory unavailable");
    // Re-rendering and the browser's passive expansion effect never retry a failed listing.
    screen.render();
    screen.render();
    expect(screen.requests).toHaveLength(1);
    expect(screen.rows).toEqual(["src"]);

    screen.press("src");
    expect([...screen.current.expandedPaths]).toEqual([]);
    expect(screen.requests).toHaveLength(1);
    screen.press("src");
    expect([...screen.current.expandedPaths]).toEqual(["src"]);
    expect(screen.requests).toHaveLength(2);
    await screen.succeed(1, [{ kind: "file", path: "src/file.ts" }]);
    expect(screen.current.error).toBeNull();
    expect(screen.rows).toEqual(["src", "src/file.ts"]);

    // A loaded folder serves from cache on collapse and expand.
    screen.press("src");
    screen.press("src");
    expect(screen.rows).toEqual(["src", "src/file.ts"]);
    expect(screen.requests).toHaveLength(2);
  });

  it("reveals a controlled leaf-only search result after search clears", () => {
    using screen = setup(true);
    screen.render();
    screen.searchQuery.data = {
      entries: [{ kind: "file", path: "src/new/file.ts" }],
      truncated: false,
    };
    screen.controlSelection("src/new/file.ts");
    screen.render({ searchQuery: "file" });
    expect([...screen.current.expandedPaths]).toEqual(["src", "src/new"]);
    screen.render();
    expect(screen.current.entries.map((entry) => entry.path)).toContain("src/new/file.ts");
  });

  it.each(["collapse", "delete"])("settles controlled selection after %s", async (action) => {
    using screen = setup(true);
    screen.render();
    screen.updateView([], "src/nested/file.ts");
    await screen.succeed(0, [{ kind: "directory", path: "src/nested" }]);
    expect([...screen.current.expandedPaths]).toEqual(["src", "src/nested"]);
    if (action === "collapse") {
      screen.updateView([], "src/nested/file.ts");
      expect([...screen.current.expandedPaths]).toEqual([]);
      screen.render({ cwd: "/second" });
      screen.render();
      expect([...screen.current.expandedPaths]).toEqual([]);
    }
    screen.rootQuery.data = { entries: [], truncated: false };
    screen.render();
    expect([...screen.current.expandedPaths]).toEqual([]);
    expect(screen.current.selectedPath).toBeNull();
    if (action === "delete") {
      screen.controlSelection("src/nested/file.ts");
      screen.searchQuery.data = {
        entries: [
          { kind: "directory", path: "src" },
          { kind: "directory", path: "src/nested" },
          { kind: "file", path: "src/nested/file.ts" },
        ],
        truncated: false,
      };
      screen.rootQuery.failure = new ProjectListEntriesError({
        cwd: "/first",
        failure: "workspace_root_not_found",
      });
      screen.rootQuery.error = screen.rootQuery.failure.message;
      const requestCount = screen.requests.length;
      for (const error of [null, "Search unavailable"]) {
        screen.searchQuery.error = error;
        screen.render({ searchQuery: "nested" });
        expect(screen.current.entries).toEqual([]);
        expect([...screen.current.expandedPaths]).toEqual([]);
        expect([...screen.current.loadedDirectories]).toEqual([]);
        expect(screen.current.isPending).toBe(false);
        expect(screen.requests).toHaveLength(requestCount);
      }
    }
  });

  it.each(["return", "missing root"])(
    "revalidates retained children after %s without clearing for transient errors",
    async (scenario) => {
      using screen = setup();
      screen.render();
      screen.load();
      await screen.succeed(0, [{ kind: "file", path: "src/old.ts" }]);
      screen.updateView(["src"], "src/old.ts");
      screen.render({ cwd: "/second" });
      screen.render();
      screen.rootQuery.error = "Connection unavailable";
      screen.render();
      expect(screen.current.selectedPath).toBe("src/old.ts");
      expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src", "src/old.ts"]);
      if (scenario === "missing root") {
        screen.rootQuery.failure = new ProjectListEntriesError({
          cwd: "/first",
          failure: "workspace_root_not_found",
        });
        screen.rootQuery.error = screen.rootQuery.failure.message;
        expect(screen.rootQuery.error).toBe("Failed to list workspace entries in '/first'.");
        screen.render();
        expect(screen.current.selectedPath).toBeNull();
        expect([...screen.current.expandedPaths]).toEqual([]);
        expect([...screen.current.loadedDirectories]).toEqual([]);
      }
      screen.rootQuery.error = null;
      screen.rootQuery.failure = null;
      screen.render();
      if (scenario === "missing root") {
        expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src"]);
        expect(screen.current.selectedPath).toBeNull();
      }
      screen.load();
      expect(screen.requests).toHaveLength(2);
      await screen.succeed(1, []);
      expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src"]);
      expect(screen.current.selectedPath).toBeNull();
    },
  );

  it.each(["new", "src/new"])(
    "keeps search discovery %s until its parent listing revalidates it",
    async (path) => {
      using screen = setup();
      screen.render();
      screen.load();
      await screen.succeed(0, []);
      screen.searchQuery.data = {
        entries: [{ kind: "file", path: `${path}/file.ts` }],
        truncated: false,
      };
      screen.render({ searchQuery: "new" });
      const expanded = path.includes("/") ? ["src", path] : [path];
      screen.updateView(expanded, `${path}/file.ts`);
      expect(screen.current.selectedPath).toBe(`${path}/file.ts`);
      expect([...screen.current.expandedPaths]).toEqual(expanded);
      screen.load(path);
      await screen.succeed(1, [
        { kind: "file", path: `${path}/file.ts` },
        { kind: "file", path: `${path}/other.ts` },
      ]);
      expect([...screen.current.loadedDirectories]).toEqual(["src", path]);

      const cachedSearch = screen.searchSuccess;
      for (const searchQuery of ["", "other"]) {
        screen.searchQuery.data = { entries: [], truncated: false };
        screen.render({ searchQuery });
        expect(screen.current.selectedPath).toBe(`${path}/file.ts`);
        expect([...screen.current.expandedPaths]).toEqual(expanded);
        expect([...screen.current.loadedDirectories]).toEqual(["src", path]);
        expect(screen.current.entries).toContainEqual({ kind: "file", path: `${path}/file.ts` });
        expect(screen.current.entries).toContainEqual({ kind: "file", path: `${path}/other.ts` });
      }

      screen.render();
      for (const target of [{ cwd: "/second" }, { environmentId: EnvironmentId.make("second") }]) {
        screen.render(target);
        screen.render();
        expect(screen.current.selectedPath).toBe(`${path}/file.ts`);
        expect([...screen.current.expandedPaths]).toEqual(expanded);
        expect([...screen.current.loadedDirectories]).toEqual(["src", path]);
        expect(screen.current.entries).toContainEqual({ kind: "file", path: `${path}/other.ts` });
      }

      screen.searchQuery.data = {
        entries: [{ kind: "file", path: `${path}/file.ts` }],
        truncated: false,
      };
      screen.render({ searchQuery: "new" });
      for (const equalContents of [false, true]) {
        // A later parent listing wins over retained discovery evidence.
        if (path.includes("/")) {
          // Refresh re-lists the root and every reachable folder; the empty parent prunes the child.
          const refreshed = screen.requests.length;
          act(() => {
            void screen.current.refresh();
          });
          expect(screen.requests.slice(refreshed).map((request) => request.query.input)).toEqual([
            { cwd: "/first", directoryPath: "" },
            { cwd: "/first", query: "new", limit: 200 },
            { cwd: "/first", directoryPath: "src" },
            { cwd: "/first", directoryPath: path },
          ]);
          // The parent settles last so its listing carries the newest response timestamp.
          for (const index of [refreshed, refreshed + 1, refreshed + 3, refreshed + 2]) {
            await screen.succeed(index, []);
          }
        } else {
          const cachedData = screen.rootQuery.data;
          screen.rootQuery.isPending = true;
          screen.render({ searchQuery: "new" });
          expect(screen.current.selectedPath).toBe(`${path}/file.ts`);
          screen.rootQuery.isPending = false;
          expect(screen.rootQuery.data).toBe(cachedData);
          screen.render({ searchQuery: "new" });
        }
        expect(screen.current.selectedPath).toBeNull();
        expect([...screen.current.expandedPaths]).toEqual(path.includes("/") ? ["src"] : []);
        expect([...screen.current.loadedDirectories]).toEqual(["src"]);

        // Cover an older cache and the timestamp's ambiguous same-millisecond boundary.
        for (const success of [
          cachedSearch,
          AsyncResult.success(cachedSearch.value, { timestamp: screen.responseTimestamp }),
        ]) {
          screen.searchQuery.data = { entries: [], truncated: false };
          screen.render({ searchQuery: "other" });
          screen.searchQuery.success = success;
          screen.searchQuery.data = success.value;
          screen.render({ searchQuery: "new" });
          screen.updateView(expanded, `${path}/file.ts`);
          const requestCount = screen.requests.length;
          screen.load(path);
          expect(screen.requests).toHaveLength(requestCount + 1);
          await screen.fail(requestCount);
          screen.searchQuery.success = null;
          screen.render();
          expect(screen.current.selectedPath).toBeNull();
          expect([...screen.current.expandedPaths]).toEqual(path.includes("/") ? ["src"] : []);
          expect([...screen.current.loadedDirectories]).toEqual(["src"]);
          expect(
            screen.current.entries.some(
              (entry) => entry.path === path || entry.path.startsWith(`${path}/`),
            ),
          ).toBe(false);
        }

        const cachedSearchData = screen.searchQuery.data;
        screen.searchQuery.isPending = true;
        screen.render({ searchQuery: "new" });
        expect(screen.current.selectedPath).toBeNull();
        expect([...screen.current.loadedDirectories]).toEqual(["src"]);
        screen.searchQuery.isPending = false;
        if (!equalContents) {
          screen.searchQuery.data = {
            ...cachedSearchData,
            entries: [...cachedSearchData.entries, { kind: "file", path: `${path}/added.ts` }],
          };
        }
        expect(screen.searchQuery.data === cachedSearchData).toBe(equalContents);
        screen.render({ searchQuery: "new" });
        screen.updateView(expanded, `${path}/file.ts`);
        screen.load(path);
        await screen.succeed(screen.requests.length - 1, [
          { kind: "file", path: `${path}/file.ts` },
          { kind: "file", path: `${path}/recreated.ts` },
        ]);
        expect(screen.current.selectedPath).toBe(`${path}/file.ts`);
        expect([...screen.current.expandedPaths]).toEqual(expanded);
        expect([...screen.current.loadedDirectories]).toEqual(["src", path]);
        expect(screen.current.entries).toContainEqual({ kind: "file", path: `${path}/file.ts` });
        expect(screen.current.entries).toContainEqual({
          kind: "file",
          path: `${path}/recreated.ts`,
        });
      }
    },
  );

  it("prunes deleted directory contents, expansion and selection after a fresh parent listing", async () => {
    using screen = setup();
    screen.render();
    screen.load();
    await screen.succeed(0, [{ kind: "directory", path: "src/nested" }]);
    screen.load("src/nested");
    await screen.succeed(1, [{ kind: "file", path: "src/nested/file.ts" }]);
    screen.updateView(["src", "src/nested"], "src/nested/file.ts");
    screen.rootQuery.data = { entries: [], truncated: true };
    screen.render();
    expect([...screen.current.loadedDirectories]).toEqual(["src", "src/nested"]);
    expect(screen.current.selectedPath).toBe("src/nested/file.ts");
    screen.rootQuery.data = { entries: [], truncated: false };
    screen.render();
    expect(screen.current.entries).toEqual([]);
    expect([...screen.current.loadedDirectories]).toEqual([]);
    expect([...screen.current.expandedPaths]).toEqual([]);
    expect(screen.current.selectedPath).toBeNull();
    screen.rootQuery.data = { entries: rootEntries, truncated: false };
    screen.render();
    expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src"]);
  });
});
