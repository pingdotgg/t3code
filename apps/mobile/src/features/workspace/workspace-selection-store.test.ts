import type { NavigationState } from "@react-navigation/native";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));

import * as MobileDatabase from "../../persistence/mobile-database";
import * as MobilePreferences from "../../persistence/mobile-preferences";
import * as MobileSecureStorage from "../../persistence/mobile-secure-storage";
import { workspaceTabNavigationState } from "./workspace-tab-navigation";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resume) => {
    resolve = resume;
  });
  return { promise, resolve };
}

function threadState(threadId: string): NavigationState {
  return {
    stale: false,
    type: "stack",
    key: "root",
    routeNames: ["Home", "Thread"],
    index: 1,
    routes: [
      { name: "Home", key: "home" },
      { name: "Thread", key: threadId, params: { environmentId: "env", threadId } },
    ],
  };
}

const fallbackKey = "t3code.preferences.fallback";
const unrelated = { baseFontSize: 19, hiddenNavigationTabs: ["usage"] };

async function setup(
  options: {
    readonly platform?: "ios" | "android";
    readonly failures?: number;
    readonly fallbackSucceeds?: boolean;
    readonly holdFallback?: boolean;
    readonly initial?: MobilePreferences.Preferences;
  } = {},
) {
  vi.resetModules();
  const releaseFirst = deferred<void>();
  const fallbackStarted = deferred<void>();
  const releaseFallback = deferred<void>();
  const completions = new Map<string, ReturnType<typeof deferred<MobilePreferences.Preferences>>>();
  const completionFor = (id: string) => {
    let completion = completions.get(id);
    if (!completion) {
      completion = deferred<MobilePreferences.Preferences>();
      completions.set(id, completion);
    }
    return completion;
  };
  const stored = new Map<string, string>();
  let row: MobileDatabase.StoredPreferencesJson = {
    payload: JSON.stringify(options.initial ?? unrelated),
    updatedAt: 1,
  };
  const writes: MobilePreferences.Preferences[] = [];
  let loads = 0;
  let reads = 0;
  let deletes = 0;
  let fallbackWrites = 0;
  let failedWrites = 0;
  let requests = 0;
  let listener: ((status: string) => void) | undefined;
  const database = MobileDatabase.MobileDatabase.of({
    loadCache: () => Effect.succeed(Option.none()),
    listCache: () => Effect.succeed([]),
    saveCache: () => Effect.void,
    removeCache: () => Effect.void,
    clearCacheKind: () => Effect.void,
    clearEnvironmentCache: () => Effect.void,
    clearAllCaches: Effect.void,
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.sync(() => {
      loads += 1;
      return Option.some(row);
    }),
    savePreferencesJson: (payload, updatedAt) =>
      Effect.gen(function* () {
        writes.push(JSON.parse(payload));
        if (writes.length === 1) yield* Effect.promise(() => releaseFirst.promise);
        if (failedWrites < (options.failures ?? 0)) {
          failedWrites += 1;
          return yield* new MobileDatabase.MobileDatabaseError({
            operation: "save-preferences",
            cause: "fixture database unavailable",
          });
        }
        row = { payload, updatedAt };
      }),
  });
  const secureStorage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: (key) =>
      Effect.sync(() => {
        reads += 1;
        return stored.get(key) ?? null;
      }),
    setItem: (key, value) =>
      Effect.gen(function* () {
        fallbackWrites += 1;
        fallbackStarted.resolve();
        if (options.holdFallback) yield* Effect.promise(() => releaseFallback.promise);
        if (!options.fallbackSucceeds) {
          return yield* new MobileSecureStorage.MobileSecureStorageError({
            operation: "write",
            key,
            cause: "fixture secure storage unavailable",
          });
        }
        stored.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        deletes += 1;
        stored.delete(key);
      }),
  });
  vi.doMock("../../persistence/layer", () => ({
    layer: MobilePreferences.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(MobileDatabase.MobileDatabase, database),
          Layer.succeed(MobileSecureStorage.MobileSecureStorage, secureStorage),
        ),
      ),
    ),
  }));
  vi.doMock("../cloud/dpop", () => ({ layer: Layer.empty }));
  vi.doMock("../cloud/managedRelayLayer", () => ({ layer: () => Layer.empty }));
  vi.doMock("../cloud/publicConfig", () => ({ resolveCloudPublicConfig: () => ({ relay: {} }) }));
  vi.doMock("../observability/tracing", () => ({ layer: Layer.empty }));
  vi.doMock("../../lib/protectedData", () => ({
    whenProtectedDataAvailable: () => Promise.resolve(),
  }));
  vi.doMock("react-native", () => ({
    Platform: { OS: options.platform ?? "ios", isPad: true },
    Dimensions: { get: () => ({ width: 1024, height: 768 }) },
    AppState: {
      addEventListener: (_event: string, callback: typeof listener) => {
        listener = callback;
      },
    },
  }));
  vi.doMock("expo-linking", () => ({ createURL: (path: string) => `t3code://${path}` }));
  vi.doMock("../../native/native-layout-metrics", () => ({
    currentNativeLayoutMetrics: () => null,
    firstNativeLayoutMetrics: () => Promise.resolve(null),
  }));
  vi.doMock("../../connection/catalog", () => ({
    environmentCatalog: { catalogValueAtom: Atom.make({ isReady: false }) },
  }));
  vi.doMock("../../state/presentation", () => ({
    environmentPresentations: { presentationsAtom: Atom.make(new Map()) },
  }));
  const startOpeningEnvironmentThread = vi.fn();
  vi.doMock("../../state/threads", () => ({
    startOpeningEnvironmentThread,
    threadEnvironment: { snapshotAtom: () => Atom.make(undefined) },
    environmentThreadShells: { environmentThreadIndexAtom: () => Atom.make(new Map()) },
  }));
  const { runtime } = await import("../../lib/runtime");
  const runPromise = runtime.runPromise;
  const run = vi.spyOn(runtime, "runPromise").mockImplementation((effect, options) => {
    requests += 1;
    const promise = runPromise(effect, options);
    void promise.then(
      (value) => {
        const result = value as MobilePreferences.Preferences;
        const id = result.workspaceSelections?.threads?.threadId;
        if (id) completionFor(id).resolve(result);
      },
      () => undefined,
    );
    return promise;
  });
  const store = await import("./workspace-selection-store");
  const { appAtomRegistry } = await import("../../state/atom-registry");
  return {
    store,
    startOpeningEnvironmentThread,
    writes,
    stored,
    releaseFirst,
    releaseFallback,
    fallbackStarted,
    counts: () => ({ requests, loads, reads, deletes, fallbackWrites }),
    persisted: () => JSON.parse(row.payload) as MobilePreferences.Preferences,
    emit: (status: string) => listener?.(status),
    record: (id: string) => store.recordWorkspaceSelections(threadState(id)),
    completed: (id: string) => completionFor(id).promise,
    // A distinct final selection proves all earlier local requests have executed or skipped.
    finish: () => {
      store.recordWorkspaceSelections(threadState("final"));
      listener?.("background");
      return completionFor("final").promise;
    },
    [Symbol.asyncDispose]: async () => {
      releaseFirst.resolve();
      releaseFallback.resolve();
      appAtomRegistry.dispose();
      run.mockRestore();
      await runtime.dispose();
    },
  };
}

const ids = (writes: readonly MobilePreferences.Preferences[]) =>
  writes.map((write) => write.workspaceSelections?.threads?.threadId);

describe("workspace selection persistence", () => {
  it.each([
    { events: ["a", "a"], expected: ["a", "final"] },
    { events: ["a", "a", "b", "b"], expected: ["a", "b", "final"] },
  ])("persists $events as $expected after successful writes", async ({ events, expected }) => {
    await using fixture = await setup();
    await fixture.store.hydrateWorkspaceSelections();
    for (const [index, id] of events.entries()) {
      fixture.record(id);
      fixture.emit(index % 2 === 0 ? "inactive" : "background");
      if (index === 0) {
        // The first request reaches the real store and its storage barrier in this call stack.
        expect(fixture.counts().requests).toBe(2);
        expect(ids(fixture.writes)).toEqual(["a"]);
      }
    }
    const finished = fixture.finish();
    fixture.releaseFirst.resolve();
    await finished;
    expect({ writes: ids(fixture.writes), ...fixture.counts() }).toEqual({
      writes: expected,
      requests: expected.length + 1,
      loads: expected.length + 1,
      reads: expected.length + 1,
      deletes: expected.length,
      fallbackWrites: 0,
    });
    expect(fixture.persisted()).toEqual({
      ...unrelated,
      workspaceSelections: { threads: { environmentId: "env", threadId: "final", key: "final" } },
    });
  });

  it("keeps the second A request as a retry when the first A fails", async () => {
    await using fixture = await setup({ failures: 1 });
    await fixture.store.hydrateWorkspaceSelections();
    fixture.record("a");
    fixture.emit("inactive");
    fixture.emit("background");
    const finished = fixture.finish();
    fixture.releaseFirst.resolve();
    await finished;
    expect(ids(fixture.writes)).toEqual(["a", "a", "final"]);
    expect(fixture.counts().fallbackWrites).toBe(1);
    expect(fixture.persisted()).toMatchObject({
      ...unrelated,
      workspaceSelections: { threads: { threadId: "final" } },
    });
  });

  it("does not write an unchanged navigation snapshot after its save succeeds", async () => {
    await using fixture = await setup();
    await fixture.store.hydrateWorkspaceSelections();
    fixture.record("a");
    const selected = fixture.store.currentWorkspaceSelections();
    fixture.emit("inactive");
    fixture.releaseFirst.resolve();
    await fixture.completed("a");
    fixture.record("a");
    expect(fixture.store.currentWorkspaceSelections()).toBe(selected);
    fixture.emit("background");
    fixture.emit("inactive");
    await fixture.finish();
    expect(ids(fixture.writes)).toEqual(["a", "final"]);
    expect(fixture.persisted()).toMatchObject({
      ...unrelated,
      workspaceSelections: { threads: { threadId: "final" } },
    });
  });

  it.each([1, 3])(
    "retains queued retries after %i failed database and fallback writes",
    async (failures) => {
      await using fixture = await setup({ failures });
      await fixture.store.hydrateWorkspaceSelections();
      for (let attempt = 0; attempt <= failures; attempt += 1) {
        fixture.record("a");
        fixture.emit("background");
      }
      fixture.record("b");
      fixture.emit("inactive");
      fixture.emit("background");
      const finished = fixture.finish();
      fixture.releaseFirst.resolve();
      await finished;
      expect(ids(fixture.writes)).toEqual([
        ...Array.from({ length: failures + 1 }, () => "a"),
        "b",
        "final",
      ]);
      expect(fixture.counts().fallbackWrites).toBe(failures);
      expect(fixture.persisted()).toMatchObject({
        ...unrelated,
        workspaceSelections: { threads: { threadId: "final" } },
      });
    },
  );

  it("orders a new snapshot arriving while the preceding secure fallback is failing", async () => {
    await using fixture = await setup({ failures: 2, holdFallback: true });
    await fixture.store.hydrateWorkspaceSelections();
    fixture.record("a");
    fixture.emit("inactive");
    fixture.emit("background");
    fixture.releaseFirst.resolve();
    await fixture.fallbackStarted.promise;
    fixture.record("b");
    fixture.emit("inactive");
    fixture.emit("background");
    const finished = fixture.finish();
    fixture.releaseFallback.resolve();
    await finished;
    expect(ids(fixture.writes)).toEqual(["a", "a", "b", "final"]);
    expect(fixture.counts().fallbackWrites).toBe(2);
    expect(fixture.persisted()).toMatchObject({
      ...unrelated,
      workspaceSelections: { threads: { threadId: "final" } },
    });
  });

  it("recognizes a successful secure fallback and recovers it before saving the next selection", async () => {
    await using fixture = await setup({ failures: 1, fallbackSucceeds: true, holdFallback: true });
    await fixture.store.hydrateWorkspaceSelections();
    fixture.record("a");
    fixture.emit("inactive");
    fixture.emit("background");
    fixture.releaseFirst.resolve();
    await fixture.fallbackStarted.promise;
    const finished = fixture.finish();
    fixture.releaseFallback.resolve();
    await finished;
    expect(ids(fixture.writes)).toEqual(["a", "a", "final"]);
    expect(fixture.counts()).toEqual({
      requests: 3,
      loads: 3,
      reads: 3,
      deletes: 2,
      fallbackWrites: 1,
    });
    expect(fixture.stored.has(fallbackKey)).toBe(false);
    expect(fixture.writes[1]).toMatchObject({
      ...unrelated,
      workspaceSelections: { threads: { threadId: "a" } },
    });
    expect(fixture.persisted()).toMatchObject({
      ...unrelated,
      workspaceSelections: { threads: { threadId: "final" } },
    });
  });

  it.each(["ios", "android"] as const)(
    "does not write clean, active or unsupported selections on %s",
    async (platform) => {
      await using fixture = await setup({ platform });
      await fixture.store.hydrateWorkspaceSelections();
      fixture.emit("inactive");
      fixture.emit("background");
      fixture.store.recordWorkspaceSelections(undefined);
      fixture.record("a");
      fixture.emit("active");
      if (platform === "android") {
        fixture.emit("inactive");
        fixture.emit("background");
        expect(fixture.store.currentWorkspaceSelections()).toEqual({});
      }
      expect(fixture.counts().requests).toBe(platform === "ios" ? 1 : 0);
      expect(fixture.writes).toEqual([]);
      expect(fixture.persisted()).toEqual(unrelated);
    },
  );

  it("strips session route keys and drafts on hydration, while retaining reopening identities", async () => {
    await using fixture = await setup({
      initial: {
        ...unrelated,
        workspaceSelections: {
          threads: { environmentId: "env", threadId: "old", key: "stale-thread" },
          pullRequests: {
            environmentId: "env",
            projectId: "p",
            repository: "o/r",
            number: 7,
            key: "stale-pr",
          },
          settings: "SettingsAppearance",
          settingsKey: "stale-settings",
          threadsDraft: { key: "stale-draft", params: {} },
        },
      },
    });
    await fixture.store.hydrateWorkspaceSelections();
    await fixture.store.hydrateWorkspaceSelections();
    expect(fixture.store.currentWorkspaceSelections()).toEqual({
      threads: { environmentId: "env", threadId: "old" },
      pullRequests: { environmentId: "env", projectId: "p", repository: "o/r", number: 7 },
      settings: "SettingsAppearance",
    });
    expect(await fixture.store.launchWorkspaceURL()).toBe("t3code://threads/env/old");
    expect(fixture.startOpeningEnvironmentThread).toHaveBeenCalledWith("env", "old");
    expect(fixture.store.settingsLinkPage()).toBe("SettingsAppearance");
    fixture.record("a");
    const reopened = workspaceTabNavigationState(
      { routes: [{ name: "Home", key: "home" }] },
      "threads",
      fixture.store.currentWorkspaceSelections(),
      { columns: true, check: fixture.store.workspaceSelectionCheck },
    );
    expect(reopened.routes.at(-1)).toEqual(threadState("a").routes[1]);
    expect(fixture.counts().requests).toBe(1);
    expect(fixture.writes).toEqual([]);
  });

  it("keeps a page recorded before hydration resolves", async () => {
    await using fixture = await setup({
      initial: {
        workspaceSelections: {
          threads: { environmentId: "env", threadId: "old", key: "stale" },
          settings: "SettingsAppearance",
        },
      },
    });
    const hydration = fixture.store.hydrateWorkspaceSelections();
    fixture.record("a");
    await hydration;
    expect(fixture.store.currentWorkspaceSelections()).toEqual({
      threads: { environmentId: "env", threadId: "a", key: "a" },
      settings: "SettingsAppearance",
    });
    fixture.emit("background");
    expect(fixture.writes).toEqual([]);
  });
});
