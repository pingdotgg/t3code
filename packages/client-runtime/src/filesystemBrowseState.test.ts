import { assert, beforeEach, it } from "vitest";
import type { FilesystemBrowseResult } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  EMPTY_FILESYSTEM_BROWSE_STATE,
  createFilesystemBrowseManager,
} from "./filesystemBrowseState.ts";

const ROOT_RESULT: FilesystemBrowseResult = {
  parentPath: "/Users/julius",
  entries: [
    {
      name: "code",
      fullPath: "/Users/julius/code",
    },
  ],
};

let registry = AtomRegistry.make();

beforeEach(() => {
  registry.dispose();
  registry = AtomRegistry.make();
});

function unresolvedBrowse() {
  throw new Error("Browse resolver was not initialized.");
}

function flushAsyncWork(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

it("stores browsed folder data in an atom snapshot", async () => {
  const manager = createFilesystemBrowseManager({
    getRegistry: () => registry,
    getClient: () => ({
      browse: async () => ROOT_RESULT,
    }),
  });

  assert.deepStrictEqual(
    manager.getSnapshot({ key: null, input: null }),
    EMPTY_FILESYSTEM_BROWSE_STATE,
  );

  const target = { key: "env-1", input: { partialPath: "~" } };
  const result = await manager.refresh(target);

  assert.strictEqual(result, ROOT_RESULT);
  assert.deepStrictEqual(manager.getSnapshot(target), {
    data: ROOT_RESULT,
    error: null,
    isPending: false,
  });
});

it("deduplicates in-flight browse refreshes by target input", async () => {
  let resolveBrowse: (result: FilesystemBrowseResult) => void = unresolvedBrowse;
  let calls = 0;
  const target = { key: "env-1", input: { partialPath: "~" } };
  const manager = createFilesystemBrowseManager({
    getRegistry: () => registry,
    getClient: () => ({
      browse: () => {
        calls += 1;
        return new Promise<FilesystemBrowseResult>((resolve) => {
          resolveBrowse = resolve;
        });
      },
    }),
  });

  const first = manager.refresh(target);
  const second = manager.refresh(target);

  assert.strictEqual(first, second);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(manager.getSnapshot(target), {
    data: null,
    error: null,
    isPending: true,
  });

  resolveBrowse(ROOT_RESULT);
  await first;

  assert.deepStrictEqual(manager.getSnapshot(target), {
    data: ROOT_RESULT,
    error: null,
    isPending: false,
  });
});

it("keeps fresh watched browse results on remount", async () => {
  let browseCalls = 0;
  const target = { key: "env-1", input: { partialPath: "~" } };
  const manager = createFilesystemBrowseManager({
    getRegistry: () => registry,
    getClient: () => ({
      browse: async () => {
        browseCalls += 1;
        return ROOT_RESULT;
      },
    }),
    staleTimeMs: 60_000,
  });

  const firstUnwatch = manager.watch(target);
  await flushAsyncWork();
  firstUnwatch();

  const secondUnwatch = manager.watch(target);
  await flushAsyncWork();
  secondUnwatch();

  assert.strictEqual(browseCalls, 1);
});
