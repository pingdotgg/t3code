// @effect-diagnostics nodeBuiltinImport:off - exercises the hook with Metro's release transform.
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import {
  EnvironmentId,
  ProjectListEntriesError,
  type ProjectEntry,
  type ProjectListEntriesResult,
} from "@t3tools/contracts";
import * as fileTree from "./fileTree";
import * as Cause from "effect/Cause";
import * as React from "react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type Hook = typeof import("./useFileTreeEntries").useFileTreeEntries;
type Input = Parameters<Hook>[0];
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

const require = NodeModule.createRequire(import.meta.url);
const babel: {
  transformFileSync(file: string, options: Record<string, unknown>): { code: string };
} = require("@babel/core");
const sourcePath = require.resolve("./useFileTreeEntries.ts");
const rootEntries: ProjectEntry[] = [{ kind: "directory", path: "src" }];
const firstTarget = { cwd: "/first", environmentId: EnvironmentId.make("first") };

function compileModule(sourcePath: string) {
  const { code } = babel.transformFileSync(sourcePath, {
    babelrc: false,
    configFile: false,
    presets: [[require.resolve("babel-preset-expo"), { unstable_transformImportMeta: true }]],
    caller: {
      name: "metro",
      bundler: "metro",
      platform: "ios",
      isDev: false,
      isServer: false,
      isNodeModule: false,
      supportsStaticESM: false,
      supportsReactCompiler: true,
    },
  });

  return NodeVM.compileFunction(code, ["require", "exports"], { filename: sourcePath });
}

function setup(withBrowser = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const requests: {
    readonly query: Query;
    readonly signal?: AbortSignal;
    readonly resolve: (result: Result) => void;
  }[] = [];
  let responseTimestamp = 0;
  const rootQuery = {
    success: null as AsyncResult.Success<ProjectListEntriesResult, Error> | null,
    data: { entries: rootEntries, truncated: false },
    error: null as string | null,
    failure: null as ProjectListEntriesError | null,
    isPending: false,
    refresh: vi.fn(),
  };
  const searchQuery = {
    ...rootQuery,
    data: { entries: [] as ReadonlyArray<ProjectEntry>, truncated: false },
  };
  const modules: Record<string, unknown> = {
    "@t3tools/contracts": { ProjectListEntriesError },
    react: React,
    "react/compiler-runtime": require("react/compiler-runtime"),
    "effect/Cause": Cause,
    "@t3tools/client-runtime/state/runtime": {
      executeAtomQuery: (_registry: unknown, query: Query, options: { signal?: AbortSignal }) =>
        new Promise<Result>((resolve) => requests.push({ query, signal: options.signal, resolve })),
    },
    "../../state/atom-registry": { appAtomRegistry: { refresh: vi.fn() } },
    "../../state/projects": {
      projectEnvironment: {
        listEntries: (query: Query) => query,
        searchEntries: (query: Query) => query,
      },
    },
    "../../state/queries": { useDebouncedValue: (value: string) => value },
  };
  const queryExports = {} as typeof import("../../state/query");
  const results = new WeakMap<
    object,
    {
      data: ProjectListEntriesResult;
      error: string | null;
      pending: boolean;
      result: AsyncResult.AsyncResult<ProjectListEntriesResult, Error>;
    }
  >();
  const queryModules: Record<string, unknown> = {
    "react/compiler-runtime": require("react/compiler-runtime"),
    "@effect/atom-react": {
      useAtomValue: (atom: Query) => {
        const result = atom.input?.query === undefined ? rootQuery : searchQuery;
        if (result.success) return result.success;
        const cached = results.get(result);
        if (
          cached &&
          cached.data === result.data &&
          cached.error === result.error &&
          cached.pending === result.isPending
        ) {
          return cached.result;
        }
        const value = result.error
          ? AsyncResult.fail(result.failure ?? new Error(result.error), {
              previousSuccess: Option.some(AsyncResult.success(result.data)),
            })
          : AsyncResult.success(result.data, {
              waiting: result.isPending,
              timestamp: ++responseTimestamp,
            });
        results.set(result, {
          data: result.data,
          error: result.error,
          pending: result.isPending,
          result: value,
        });
        return value;
      },
      useAtomRefresh: () => rootQuery.refresh,
    },
    "effect/Cause": Cause,
    "effect/Option": Option,
    "effect/reactivity": { AsyncResult, Atom },
  };
  compileModule(require.resolve("../../state/query.ts"))((name: string) => {
    if (name.startsWith("@babel/runtime/"))
      return NodeModule.createRequire(require.resolve("babel-preset-expo"))(name);
    if (!(name in queryModules)) throw new Error(`Unexpected query dependency: ${name}`);
    return queryModules[name];
  }, queryExports);
  modules["../../state/query"] = queryExports;
  const exports = {} as { useFileTreeEntries: Hook };
  compileModule(sourcePath)((name: string) => {
    if (name.startsWith("@babel/runtime/"))
      return NodeModule.createRequire(require.resolve("babel-preset-expo"))(name);
    if (!(name in modules)) throw new Error(`Unexpected hook dependency: ${name}`);
    return modules[name];
  }, exports);
  const browserExports = {} as typeof import("./FileTreeBrowser");
  const empty = () => null;
  const browserModules: Record<string, unknown> = {
    ...modules,
    "react/jsx-runtime": require("react/jsx-runtime"),
    "react-native": {
      Platform: { OS: "ios" },
      View: empty,
      Pressable: empty,
      RefreshControl: empty,
    },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0 }) },
    "../../native/native-layout-metrics": { useNativeColumnLayoutMetrics: () => null },
    "@legendapp/list/react-native": { LegendList: empty },
    "../../components/ui/Button": { Button: empty },
    "../../components/ui/AppActivityIndicator": { AppActivityIndicator: empty },
    "../../components/ui/AppSymbol": { SymbolView: empty },
    "../../components/ui/AppText": { AppText: empty },
    "../../components/PierreEntryIcon": { PierreEntryIcon: empty },
    "../../lib/cn": { cn: () => "" },
    "./fileTree": fileTree,
  };
  compileModule(require.resolve("./FileTreeBrowser.tsx"))((name: string) => {
    if (name.startsWith("@babel/runtime/"))
      return NodeModule.createRequire(require.resolve("babel-preset-expo"))(name);
    if (!(name in browserModules)) throw new Error(`Unexpected browser dependency: ${name}`);
    return browserModules[name];
  }, browserExports);
  const useFileTreeEntries = exports.useFileTreeEntries;
  const root = createRoot(document.createElement("div"));
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
      <browserExports.FileTreeBrowser
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
  const unmount = () => act(() => root.unmount());
  return {
    requests,
    rootQuery,
    searchQuery,
    get searchSuccess() {
      const result = searchQuery.success ?? results.get(searchQuery)?.result;
      if (result?._tag !== "Success") throw new Error("Search has not succeeded");
      return result;
    },
    get responseTimestamp() {
      return responseTimestamp;
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
          timestamp: ++responseTimestamp,
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
  it("evicts the least recently visited workspace instead of retaining unbounded history", async () => {
    using screen = setup(true);
    screen.render();
    screen.updateView(["src"], "src/first.ts");
    const nested = Array.from({ length: 66 }, (_, index) => `src/directory-${index}`);
    await screen.succeed(0, [
      { kind: "file", path: "src/first.ts" },
      ...nested.map((path) => ({ kind: "directory" as const, path })),
    ]);
    for (const path of nested) {
      const retained = [...screen.current.expandedPaths];
      screen.updateView([...retained, path], "src/first.ts");
      await screen.succeed(screen.requests.length - 1, [
        { kind: "directory", path: `${path}/child` },
      ]);
      screen.updateView([...retained, path, `${path}/child`], "src/first.ts");
      await screen.succeed(screen.requests.length - 1);
    }
    expect(screen.requests).toHaveLength(133);
    expect(screen.current.isPending).toBe(false);
    expect(screen.current.loadedDirectories.size).toBe(133);
    expect(screen.current.expandedPaths.size).toBe(133);
    const activeView = screen.current;
    screen.render({ cwd: "/other" });
    screen.render();
    expect(screen.current.loadedDirectories.size).toBeLessThanOrEqual(64);
    expect(screen.current.expandedPaths.size).toBeLessThanOrEqual(64);
    const retainedPaths = new Set([
      ...screen.current.loadedDirectories,
      ...screen.current.expandedPaths,
    ]);
    expect(retainedPaths.size).toBeLessThanOrEqual(64);
    for (const path of nested) {
      if (!screen.current.expandedPaths.has(path)) {
        expect(screen.current.expandedPaths.has(`${path}/child`)).toBe(false);
        expect(screen.current.loadedDirectories.has(`${path}/child`)).toBe(false);
      }
    }
    expect(activeView.loadedDirectories.size).toBe(133);
    expect(activeView.expandedPaths.size).toBe(133);
    expect(screen.current.selectedPath).toBe("src/first.ts");
    const returnRequests = screen.requests.length;
    for (let index = 133; index < returnRequests; index++) {
      await screen.succeed(index);
    }
    expect(screen.current.isPending).toBe(false);
    screen.render();
    expect(screen.requests).toHaveLength(returnRequests);
    for (let index = 1; index <= 8; index++) screen.render({ cwd: `/workspace-${index}` });
    screen.render();
    expect([...screen.current.loadedDirectories]).toEqual([]);
    expect([...screen.current.expandedPaths]).toEqual([]);
    expect(screen.current.selectedPath).toBeNull();
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
        entries: [
          { kind: "directory", path },
          { kind: "file", path: `${path}/file.ts` },
        ],
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
        entries: [
          { kind: "directory", path },
          { kind: "file", path: `${path}/file.ts` },
        ],
        truncated: false,
      };
      screen.render({ searchQuery: "new" });
      for (const equalContents of [false, true]) {
        // A later parent listing wins over retained discovery evidence.
        if (path.includes("/")) {
          screen.load("src", true);
          await screen.succeed(screen.requests.length - 1, []);
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
