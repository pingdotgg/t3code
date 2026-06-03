import { assert, beforeEach, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  type ComposerPathSearchClient,
  createComposerPathSearchManager,
  EMPTY_COMPOSER_PATH_SEARCH_STATE,
  getComposerPathSearchTargetKey,
} from "./composerPathSearchState.ts";

let registry = AtomRegistry.make();

const noop = () => undefined;

beforeEach(() => {
  registry.dispose();
  registry = AtomRegistry.make();
});

function flushAsyncWork(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

const TARGET = {
  environmentId: "env-local" as EnvironmentId,
  cwd: "/repo",
  query: "src",
};

it("derives null keys for inactive path searches", () => {
  assert.strictEqual(getComposerPathSearchTargetKey({ ...TARGET, query: "" }), null);
  assert.strictEqual(getComposerPathSearchTargetKey({ ...TARGET, cwd: null }), null);
  assert.strictEqual(getComposerPathSearchTargetKey({ ...TARGET, environmentId: null }), null);
});

it("stores path search results in atom state", async () => {
  const manager = createComposerPathSearchManager({
    getRegistry: () => registry,
    debounceMs: 0,
    getClient: () => ({
      searchEntries: async () => ({
        entries: [
          { path: "src/index.ts", kind: "file" },
          { path: "src/components", kind: "directory" },
        ],
        truncated: false,
      }),
    }),
  });

  manager.search(TARGET);
  await flushAsyncWork();

  assert.deepStrictEqual(manager.getSnapshot(TARGET), {
    entries: [
      { path: "src/index.ts", kind: "file" },
      { path: "src/components", kind: "directory" },
    ],
    isPending: false,
    error: null,
  });
});

it("reuses fresh cached path search results", async () => {
  const searchEntries = vi.fn(async () => ({
    entries: [{ path: "src/index.ts", kind: "file" as const }],
    truncated: false,
  }));
  const manager = createComposerPathSearchManager({
    getRegistry: () => registry,
    debounceMs: 0,
    staleTimeMs: 15_000,
    getClient: () => ({ searchEntries }),
  });

  manager.search(TARGET);
  await flushAsyncWork();
  manager.search(TARGET);
  await flushAsyncWork();

  assert.strictEqual(searchEntries.mock.calls.length, 1);
  assert.deepStrictEqual(manager.getSnapshot(TARGET), {
    entries: [{ path: "src/index.ts", kind: "file" }],
    isPending: false,
    error: null,
  });
});

it("invalidates watched path searches and refreshes without clearing entries", async () => {
  type SearchResult = Awaited<ReturnType<ComposerPathSearchClient["searchEntries"]>>;

  let resolveSecond: (value: SearchResult) => void = noop;
  let callCount = 0;
  const searchEntries = vi.fn((() => {
    callCount += 1;
    if (callCount === 1) {
      return Promise.resolve({
        entries: [{ path: "src/old.ts", kind: "file" as const }],
        truncated: false,
      });
    }
    return new Promise((resolve) => {
      resolveSecond = resolve;
    });
  }) satisfies ComposerPathSearchClient["searchEntries"]);
  const manager = createComposerPathSearchManager({
    getRegistry: () => registry,
    debounceMs: 0,
    staleTimeMs: 15_000,
    getClient: () => ({ searchEntries }),
  });

  const unwatch = manager.watch(TARGET);
  await flushAsyncWork();
  manager.invalidate();

  assert.deepStrictEqual(manager.getSnapshot(TARGET), {
    entries: [{ path: "src/old.ts", kind: "file" }],
    isPending: true,
    error: null,
  });

  resolveSecond({
    entries: [{ path: "src/new.ts", kind: "file" }],
    truncated: false,
  });
  await flushAsyncWork();

  assert.deepStrictEqual(manager.getSnapshot(TARGET), {
    entries: [{ path: "src/new.ts", kind: "file" }],
    isPending: false,
    error: null,
  });
  assert.strictEqual(searchEntries.mock.calls.length, 2);
  unwatch();
});

it("ignores stale path search results after a newer request starts", async () => {
  let resolveFirst: (value: {
    entries: ReadonlyArray<{ path: string; kind: "file" | "directory" }>;
    truncated: boolean;
  }) => void = noop;
  const manager = createComposerPathSearchManager({
    getRegistry: () => registry,
    debounceMs: 0,
    getClient: () => ({
      searchEntries: (input: Parameters<ComposerPathSearchClient["searchEntries"]>[0]) => {
        if (input.query === "first") {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({
          entries: [{ path: "second.ts", kind: "file" }],
          truncated: false,
        });
      },
    }),
  });

  manager.search({ ...TARGET, query: "first" });
  manager.search({ ...TARGET, query: "second" });
  await flushAsyncWork();
  resolveFirst({ entries: [{ path: "first.ts", kind: "file" }], truncated: false });
  await flushAsyncWork();

  assert.deepStrictEqual(manager.getSnapshot({ ...TARGET, query: "second" }), {
    entries: [{ path: "second.ts", kind: "file" }],
    isPending: false,
    error: null,
  });
});

it("returns the empty snapshot for inactive targets", () => {
  const manager = createComposerPathSearchManager({
    getRegistry: () => registry,
    getClient: () => null,
  });

  assert.deepStrictEqual(
    manager.getSnapshot({ environmentId: null, cwd: null, query: null }),
    EMPTY_COMPOSER_PATH_SEARCH_STATE,
  );
});
