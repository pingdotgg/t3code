import { assert, beforeEach, it } from "vite-plus/test";
import type { SourceControlDiscoveryResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  EMPTY_SOURCE_CONTROL_DISCOVERY_STATE,
  createSourceControlDiscoveryManager,
} from "./sourceControlDiscoveryState.ts";

const EMPTY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const GITHUB_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [
    {
      kind: "git",
      label: "Git",
      implemented: true,
      status: "available",
      version: Option.some("2.51.0"),
      installHint: "Install Git.",
      detail: Option.none(),
    },
  ],
  sourceControlProviders: [
    {
      kind: "github",
      label: "GitHub",
      status: "available",
      version: Option.some("2.85.0"),
      installHint: "Install GitHub CLI.",
      detail: Option.none(),
      auth: {
        status: "authenticated",
        account: Option.some("octo"),
        host: Option.some("github.com"),
        detail: Option.none(),
      },
    },
  ],
};

function unresolvedDiscovery() {
  throw new Error("Discovery resolver was not initialized.");
}

let registry = AtomRegistry.make();

const noop = () => undefined;

beforeEach(() => {
  registry.dispose();
  registry = AtomRegistry.make();
});

function flushAsyncWork(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

it("stores refreshed discovery data in an atom snapshot", async () => {
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => ({
      discoverSourceControl: async () => EMPTY_RESULT,
    }),
  });

  assert.deepStrictEqual(manager.getSnapshot({ key: null }), EMPTY_SOURCE_CONTROL_DISCOVERY_STATE);

  const result = await manager.refresh({ key: "primary" });

  assert.strictEqual(result, EMPTY_RESULT);
  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: EMPTY_RESULT,
    error: null,
    isPending: false,
  });
});

it("deduplicates in-flight discovery refreshes by target key", async () => {
  let resolveDiscovery: (result: SourceControlDiscoveryResult) => void = unresolvedDiscovery;
  let calls = 0;
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => ({
      discoverSourceControl: () => {
        calls += 1;
        return new Promise<SourceControlDiscoveryResult>((resolve) => {
          resolveDiscovery = resolve;
        });
      },
    }),
  });

  const first = manager.refresh({ key: "primary" });
  const second = manager.refresh({ key: "primary" });

  assert.strictEqual(first, second);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: null,
    error: null,
    isPending: true,
  });

  resolveDiscovery(EMPTY_RESULT);
  await first;

  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: EMPTY_RESULT,
    error: null,
    isPending: false,
  });
});

it("keeps the previous snapshot when refresh fails", async () => {
  let shouldFail = false;
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => ({
      discoverSourceControl: async () => {
        if (shouldFail) {
          throw new Error("probe failed");
        }
        return EMPTY_RESULT;
      },
    }),
  });

  await manager.refresh({ key: "primary" });
  shouldFail = true;

  const result = await manager.refresh({ key: "primary" });

  assert.strictEqual(result, EMPTY_RESULT);
  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: EMPTY_RESULT,
    error: "probe failed",
    isPending: false,
  });
});

it("invalidates a discovery target back to the initial snapshot", async () => {
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => ({
      discoverSourceControl: async () => GITHUB_RESULT,
    }),
  });

  await manager.refresh({ key: "primary" });
  manager.invalidate({ key: "primary" });

  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: null,
    error: null,
    isPending: true,
  });
});

it("ignores an in-flight refresh after the target is invalidated", async () => {
  let resolveDiscovery: (result: SourceControlDiscoveryResult) => void = unresolvedDiscovery;
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => ({
      discoverSourceControl: () =>
        new Promise<SourceControlDiscoveryResult>((resolve) => {
          resolveDiscovery = resolve;
        }),
    }),
  });

  const refresh = manager.refresh({ key: "primary" });
  manager.invalidate({ key: "primary" });
  resolveDiscovery(GITHUB_RESULT);

  const result = await refresh;

  assert.strictEqual(result, GITHUB_RESULT);
  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: null,
    error: null,
    isPending: true,
  });
});

it("watches a discovery target with ref-counted client-change subscriptions", async () => {
  let listener: () => void = noop;
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  let discoveryCalls = 0;
  const client = {
    discoverSourceControl: async () => {
      discoveryCalls += 1;
      return EMPTY_RESULT;
    },
  };
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => client,
    subscribeClientChanges: (nextListener) => {
      subscribeCalls += 1;
      listener = nextListener;
      return () => {
        unsubscribeCalls += 1;
      };
    },
  });

  const firstUnwatch = manager.watch({ key: "primary" });
  const secondUnwatch = manager.watch({ key: "primary" });
  await flushAsyncWork();

  assert.strictEqual(subscribeCalls, 1);
  assert.strictEqual(discoveryCalls, 1);
  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: EMPTY_RESULT,
    error: null,
    isPending: false,
  });

  listener();
  await flushAsyncWork();
  assert.strictEqual(discoveryCalls, 1);

  firstUnwatch();
  assert.strictEqual(unsubscribeCalls, 0);

  secondUnwatch();
  assert.strictEqual(unsubscribeCalls, 1);
});

it("reuses fresh watched discovery results on remount", async () => {
  let discoveryCalls = 0;
  const client = {
    discoverSourceControl: async () => {
      discoveryCalls += 1;
      return EMPTY_RESULT;
    },
  };
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => client,
    staleTimeMs: 60_000,
  });

  const firstUnwatch = manager.watch({ key: "primary" });
  await flushAsyncWork();
  firstUnwatch();

  const secondUnwatch = manager.watch({ key: "primary" });
  await flushAsyncWork();
  secondUnwatch();

  assert.strictEqual(discoveryCalls, 1);
});

it("refreshes a watched discovery target when the resolved client is replaced", async () => {
  let listener: () => void = noop;
  let activeResult = EMPTY_RESULT;
  let discoveryCalls = 0;
  const firstClient = {
    discoverSourceControl: async () => {
      discoveryCalls += 1;
      return activeResult;
    },
  };
  const secondClient = {
    discoverSourceControl: async () => {
      discoveryCalls += 1;
      return activeResult;
    },
  };
  let activeClient = firstClient;
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => activeClient,
    subscribeClientChanges: (nextListener) => {
      listener = nextListener;
      return () => undefined;
    },
  });

  const unwatch = manager.watch({ key: "primary" });
  await flushAsyncWork();

  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: EMPTY_RESULT,
    error: null,
    isPending: false,
  });

  activeClient = secondClient;
  activeResult = GITHUB_RESULT;
  listener();
  await flushAsyncWork();

  assert.strictEqual(discoveryCalls, 2);
  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: GITHUB_RESULT,
    error: null,
    isPending: false,
  });

  unwatch();
});
