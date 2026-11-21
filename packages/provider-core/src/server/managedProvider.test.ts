import { describe, it, assert } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Cache from "effect/Cache";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderHost from "./ProviderHost.ts";
import { makeManagedServerProvider } from "./managedProvider.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });
const fastModeCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

interface TestSettings {
  readonly enabled: boolean;
}

const maintenanceCapabilities = {
  provider: ProviderDriverKind.make("codex"),
  packageName: "@openai/codex",
  update: {
    command: "npm install -g @openai/codex@latest",

    executable: "npm",

    args: ["install", "-g", "@openai/codex@latest"],

    lockKey: "npm-global",
  },
} as const;

const initialSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  message: "Checking provider availability...",
  models: [],
  slashCommands: [],
  skills: [],
};

const refreshedSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:01.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const enrichedSnapshot: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:02.000Z",
  models: [
    {
      slug: "composer-2",
      name: "Composer 2",
      isCustom: false,
      capabilities: fastModeCapabilities,
    },
  ],
};

const refreshedSnapshotSecond: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:03.000Z",
  message: "Refreshed provider availability again.",
};

function layerProviderHost(input: {
  readonly runBackgroundWork: boolean;
  readonly settings?: Pick<ProviderHost.ProviderHost["Service"], "settings">["settings"];
  readonly awaitServerReady?: Effect.Effect<void>;
}) {
  return Layer.succeed(
    ProviderHost.ProviderHost,
    ProviderHost.ProviderHost.of({
      compatibility: () => Effect.undefined,
      paths: {
        cwd: process.cwd(),
        baseDir: "/t3",
        stateDir: "/t3/userdata",
        providerStatusCacheDir: "/t3/caches",
        attachmentsDir: "/t3/userdata/attachments",
      },
      settings: input.settings ?? {
        get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
        changes: Stream.empty,
        subscribe: Effect.succeed(Stream.empty),
      },
      shouldRunBackgroundWork: () => Effect.succeed(input.runBackgroundWork),
      ...(input.awaitServerReady ? { awaitServerReady: input.awaitServerReady } : {}),
      resolveAttachmentPath: () => null,
      credentials: () => Effect.die("unused"),
    }),
  );
}

const layerAlwaysRunTest = layerProviderHost({ runBackgroundWork: true });

const enrichedSnapshotSecond: ServerProvider = {
  ...refreshedSnapshotSecond,
  checkedAt: "2026-04-10T00:00:04.000Z",
  models: [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: emptyCapabilities,
    },
  ],
};

describe("makeManagedServerProvider", () => {
  it.effect("invalidates cached usage and queues one refresh behind an in-flight refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const probeStarted = yield* Deferred.make<void>();
        const releaseProbe = yield* Deferred.make<void>();
        const cache = yield* Cache.makeWith(
          () =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(calls, (count) => count + 1);
              if (count === 2) {
                yield* Deferred.succeed(probeStarted, undefined);
                yield* Deferred.await(releaseProbe);
              }
              return {
                ...refreshedSnapshot,
                usageLimits: {
                  checkedAt: refreshedSnapshot.checkedAt,
                  windows: [
                    {
                      id: "five_hour",
                      kind: "session",
                      label: "Session",
                      usedPercent: count === 1 ? 20 : 100,
                    },
                  ],
                },
              } satisfies ServerProvider;
            }),
          { capacity: 1, timeToLive: () => "5 minutes" },
        );
        const warmed = yield* Cache.get(cache, "claude");
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.die("usage refresh must not resolve maintenance"),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          initialSnapshot: () => Effect.succeed(warmed),
          checkProvider: Cache.get(cache, "claude"),
          invalidateUsageCache: Cache.invalidateAll(cache),
          refreshOnInterval: false,
        });
        yield* provider.streamChanges.pipe(Stream.take(1), Stream.runDrain);
        assert.strictEqual(yield* Ref.get(calls), 1);
        const refresh = yield* provider.refreshUsage!.pipe(Effect.forkChild);
        yield* Deferred.await(probeStarted);
        const queued = yield* provider.refreshUsage!.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* provider.refreshUsage!;
        assert.strictEqual(yield* Ref.get(calls), 2);
        assert.strictEqual((yield* provider.getSnapshot).usageLimits?.windows[0]?.usedPercent, 20);
        yield* Deferred.succeed(releaseProbe, undefined);
        yield* Fiber.join(refresh);
        yield* Fiber.join(queued);
        assert.strictEqual(yield* Ref.get(calls), 3);
        assert.strictEqual((yield* provider.getSnapshot).usageLimits?.windows[0]?.usedPercent, 100);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
  it.effect("keeps the waiting usage refresh's claim when the running one is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const usageProbeStarted = yield* Deferred.make<void>();
        const statusProbeStarted = yield* Deferred.make<void>();
        const releaseStatusProbe = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(calls, (count) => count + 1);
            if (count === 2) {
              yield* Deferred.succeed(usageProbeStarted, undefined);
              return yield* Effect.never;
            }
            if (count === 3) {
              yield* Deferred.succeed(statusProbeStarted, undefined);
              yield* Deferred.await(releaseStatusProbe);
            }
            return {
              ...refreshedSnapshot,
              usageLimits: { checkedAt: refreshedSnapshot.checkedAt, windows: [] },
            } satisfies ServerProvider;
          }),
          refreshOnInterval: false,
        });
        yield* provider.streamChanges.pipe(Stream.take(1), Stream.runDrain);
        const running = yield* provider.refreshUsage!.pipe(Effect.forkChild);
        yield* Deferred.await(usageProbeStarted);
        const status = yield* provider.refresh.pipe(Effect.forkChild({ startImmediately: true }));
        const waiting = yield* provider.refreshUsage!.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(running);
        yield* Deferred.await(statusProbeStarted);
        const extra = yield* provider.refreshUsage!.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(releaseStatusProbe, undefined);
        yield* Fiber.join(status);
        yield* Fiber.join(waiting);
        yield* Fiber.join(extra);
        assert.strictEqual(yield* Ref.get(calls), 4);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
  it.effect(
    "runs the initial provider check in the background and streams the refreshed snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const checkCalls = yield* Ref.make(0);
          const releaseCheck = yield* Deferred.make<void>();
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
              Effect.flatMap(() => Deferred.await(releaseCheck)),
              Effect.as(refreshedSnapshot),
            ),
            refreshInterval: "1 hour",
          });

          const initial = yield* provider.getSnapshot;
          assert.deepStrictEqual(initial, initialSnapshot);
          assert.strictEqual(yield* provider.isAwaitingFirstCheck!, true);

          const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(checkCalls), 1);

          yield* Deferred.succeed(releaseCheck, undefined);

          const updates = Array.from(yield* Fiber.join(updatesFiber));
          const latest = yield* provider.getSnapshot;

          assert.deepStrictEqual(updates, [refreshedSnapshot]);
          assert.deepStrictEqual(latest, refreshedSnapshot);
          assert.strictEqual(yield* provider.isAwaitingFirstCheck!, false);
          assert.strictEqual(yield* Ref.get(checkCalls), 1);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("holds the first provider check until server startup finishes", () =>
    Effect.gen(function* () {
      const serverReady = yield* Deferred.make<void>();
      const checkStarted = yield* Deferred.make<void>();
      const checkCalls = yield* Ref.make(0);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(checkStarted, undefined)),
              Effect.as(refreshedSnapshot),
            ),
            refreshInterval: "1 hour",
          });

          yield* TestClock.adjust("10 seconds");
          assert.strictEqual(yield* Ref.get(checkCalls), 0);
          assert.deepStrictEqual(yield* provider.getSnapshot, initialSnapshot);
          assert.isTrue(yield* provider.isAwaitingFirstCheck!);

          yield* Deferred.succeed(serverReady, undefined);
          yield* Deferred.await(checkStarted);
          assert.strictEqual(yield* Ref.get(checkCalls), 1);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerProviderHost({
              runBackgroundWork: false,
              awaitServerReady: Deferred.await(serverReady),
            }),
            TestClock.layer(),
          ),
        ),
      );
    }),
  );

  it.effect("skips periodic provider refreshes without foreground provider-status demand", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          refreshOnInterval: () => true,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: "1 second",
        });

        yield* Deferred.await(initialCheckDone);
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;

        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(layerProviderHost({ runBackgroundWork: false }), TestClock.layer()),
      ),
    ),
  );

  it.effect("stops periodic recovery checks once the snapshot is ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const failedSnapshot = { ...refreshedSnapshot, status: "error" as const };
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          refreshOnInterval: (snapshot) => snapshot.status === "error",
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Deferred.await(releaseInitialCheck).pipe(
            Effect.andThen(Ref.updateAndGet(checkCalls, (count) => count + 1)),
            Effect.map((count) => (count === 1 ? failedSnapshot : refreshedSnapshot)),
          ),
          refreshInterval: "1 second",
        });
        const updates = yield* provider.streamChanges.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseInitialCheck, undefined);
        yield* TestClock.adjust("1 second");

        assert.deepStrictEqual(Array.from(yield* Fiber.join(updates)), [
          failedSnapshot,
          refreshedSnapshot,
        ]);
        yield* TestClock.adjust("3 seconds");
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect("rechecks a ready provider after one failed periodic check before publishing it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        const failedSnapshot: ServerProvider = {
          ...refreshedSnapshot,
          status: "error",
          auth: { status: "unknown" },
          message: "Codex app-server provider probe failed: workspace routing discovery timed out.",
        };
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.map((count) => (count === 2 ? failedSnapshot : refreshedSnapshot)),
          ),
          refreshInterval: "5 minutes",
        });
        yield* Deferred.await(initialCheckDone);
        const published = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
        yield* provider.streamChanges.pipe(
          Stream.runForEach((snapshot) => Ref.update(published, (all) => [...all, snapshot])),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* TestClock.adjust("5 minutes");
        yield* TestClock.adjust("1 minute");

        assert.strictEqual((yield* provider.getSnapshot).status, "ready");
        assert.deepStrictEqual(
          (yield* Ref.get(published)).filter((snapshot) => snapshot.status === "error"),
          [],
        );
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect("reruns the provider check when streamed settings change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsRef = yield* Ref.make<TestSettings>({ enabled: true });
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const releaseSettingsCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Ref.get(settingsRef),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(releaseInitialCheck).pipe(Effect.as(refreshedSnapshot))
                : Deferred.await(releaseSettingsCheck).pipe(Effect.as(refreshedSnapshotSecond)),
            ),
          ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseInitialCheck, undefined);
        yield* Ref.set(settingsRef, { enabled: false });
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Deferred.succeed(releaseSettingsCheck, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, refreshedSnapshotSecond]);
        assert.deepStrictEqual(latest, refreshedSnapshotSecond);
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("keeps consuming settings changes after a provider check fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const thirdCheckStarted = yield* Deferred.make<void>();
        const releaseRecoveredCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(releaseInitialCheck).pipe(Effect.as(refreshedSnapshot))
                : count === 2
                  ? Effect.fail(
                      new ServerSettingsError({
                        settingsPath: "/t3/userdata/settings.json",
                        operation: "read-file",
                      }),
                    )
                  : Deferred.succeed(thirdCheckStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseRecoveredCheck)),
                      Effect.as(refreshedSnapshotSecond),
                    ),
            ),
          ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseInitialCheck, undefined);

        // The first change fails its provider check; the failed application never
        // advances the stored settings, so the same change still differs next time.
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 2);

        // The subscription must survive that failure and retry on the next change;
        // on main the dead consumer never starts the third check and this times out.
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Deferred.await(thirdCheckStarted);
        assert.strictEqual(yield* Ref.get(checkCalls), 3);
        yield* Deferred.succeed(releaseRecoveredCheck, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        assert.deepStrictEqual(updates, [refreshedSnapshot, refreshedSnapshotSecond]);
        assert.deepStrictEqual(yield* provider.getSnapshot, refreshedSnapshotSecond);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect(
    "rechecks an auth failure when settings are applied, even if this provider's did not change",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const settingsChanges = yield* PubSub.unbounded<
            TestSettings & { readonly revision: number }
          >();
          const checkCalls = yield* Ref.make(0);
          const seenRevisions: Array<number> = [];
          const releaseInitialCheck = yield* Deferred.make<void>();
          const markerApplied = yield* Deferred.make<void>();
          const unauthenticatedSnapshot: ServerProvider = {
            ...refreshedSnapshot,
            status: "error",
            auth: { status: "unauthenticated" },
            message: "Codex CLI is not authenticated. Run `codex login` and try again.",
          };
          const provider = yield* makeManagedServerProvider<
            TestSettings & { readonly revision: number }
          >({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true, revision: 0 }),
            streamSettings: Stream.fromPubSub(settingsChanges),
            haveSettingsChanged: (previous, next) => {
              seenRevisions.push(next.revision);
              if (next.revision === 2) Deferred.doneUnsafe(markerApplied, Effect.void);
              return previous.enabled !== next.enabled;
            },
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            // The credential is fixed (e.g. `codex login`) after the first, failed probe.
            checkProvider: Deferred.await(releaseInitialCheck).pipe(
              Effect.andThen(Ref.updateAndGet(checkCalls, (count) => count + 1)),
              Effect.map((count) => (count === 1 ? unauthenticatedSnapshot : refreshedSnapshot)),
            ),
            refreshInterval: "1 hour",
          });
          const initialProbe = yield* provider.streamChanges.pipe(
            Stream.take(1),
            Stream.runDrain,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* Deferred.succeed(releaseInitialCheck, undefined);
          yield* Fiber.join(initialProbe);
          assert.deepStrictEqual(yield* provider.getSnapshot, unauthenticatedSnapshot);

          // A settings apply that does not touch this provider's settings, then a marker:
          // the consumer is sequential, so the first apply has finished once the marker is seen.
          yield* PubSub.publish(settingsChanges, { enabled: true, revision: 1 });
          yield* PubSub.publish(settingsChanges, { enabled: true, revision: 2 });
          yield* Deferred.await(markerApplied);

          assert.deepStrictEqual(seenRevisions, [1, 2]);
          assert.isAtLeast(yield* Ref.get(checkCalls), 2);
          assert.deepStrictEqual((yield* provider.getSnapshot).auth, refreshedSnapshot.auth);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("streams supplemental snapshot updates after the base provider check completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseEnrichment = yield* Deferred.make<void>();
        const releaseCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Deferred.await(releaseCheck).pipe(Effect.as(refreshedSnapshot)),
          enrichSnapshot: ({ publishSnapshot }) =>
            Deferred.await(releaseEnrichment).pipe(
              Effect.flatMap(() => publishSnapshot(enrichedSnapshot)),
            ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseCheck, undefined);

        yield* Deferred.succeed(releaseEnrichment, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, enrichedSnapshot]);
        assert.deepStrictEqual(latest, enrichedSnapshot);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("ignores stale enrichment callbacks after a newer refresh advances generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const publishCallbacks: Array<(snapshot: ServerProvider) => Effect.Effect<void>> = [];
        const refreshCount = yield* Ref.make(0);
        const firstCallbackReady = yield* Deferred.make<void>();
        const secondCallbackReady = yield* Deferred.make<void>();
        const allowFirstRefresh = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(refreshCount, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(allowFirstRefresh).pipe(Effect.as(refreshedSnapshot))
                : Effect.succeed(refreshedSnapshotSecond),
            ),
          ),
          enrichSnapshot: ({ publishSnapshot }) =>
            Effect.gen(function* () {
              publishCallbacks.push(publishSnapshot);
              if (publishCallbacks.length === 1) {
                yield* Deferred.succeed(firstCallbackReady, undefined).pipe(Effect.ignore);
              } else if (publishCallbacks.length === 2) {
                yield* Deferred.succeed(secondCallbackReady, undefined).pipe(Effect.ignore);
              }
            }),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(allowFirstRefresh, undefined);
        yield* Deferred.await(firstCallbackReady);

        yield* provider.refresh;
        yield* Deferred.await(secondCallbackReady);

        yield* publishCallbacks[0]!(enrichedSnapshot);
        yield* publishCallbacks[1]!(enrichedSnapshotSecond);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [
          refreshedSnapshot,
          refreshedSnapshotSecond,
          enrichedSnapshotSecond,
        ]);
        assert.deepStrictEqual(latest, enrichedSnapshotSecond);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("applies runtime usage updates onto the published snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.succeed({
            ...refreshedSnapshot,
            usageLimits: {
              checkedAt: "2026-04-10T00:00:01.000Z",
              windows: [
                { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 },
                {
                  id: "seven_day",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 20,
                  resetsAt: "2026-04-17T00:00:00.000Z",
                },
              ],
            },
          } satisfies ServerProvider),
          refreshInterval: "1 hour",
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);

        const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:05:00.000Z",
          windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 25 }],
          authLabel: "tier-1",
        });
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:06:00.000Z",
          windows: [],
          authLabel: "tier-2",
        });

        const [update] = Array.from(yield* Fiber.join(updatesFiber));
        assert.strictEqual(update?.auth.label, "tier-1");
        assert.deepStrictEqual(update?.usageLimits, {
          checkedAt: "2026-04-10T00:05:00.000Z",
          windows: [
            { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 },
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 25,
              resetsAt: "2026-04-17T00:00:00.000Z",
            },
          ],
        });
        assert.deepStrictEqual(yield* provider.getSnapshot, update);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect.each([
    { name: "a live plan", clearPlan: false },
    { name: "a cleared plan", clearPlan: true },
  ])("keeps $name and usage across a failed probe and stale enrichment", ({ clearPlan }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseEnrichment = yield* Deferred.make<void>();
        const refreshCount = yield* Ref.make(0);
        const probedLimits = {
          checkedAt: "2026-04-10T00:00:01.000Z",
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 10 }],
        } as const;
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(refreshCount, (count) => count + 1).pipe(
            Effect.map((count) =>
              count === 1
                ? {
                    ...refreshedSnapshot,
                    auth: { ...refreshedSnapshot.auth, workspaceId: "ws-a", label: "tier-1" },
                    usageLimits: probedLimits,
                  }
                : {
                    ...refreshedSnapshotSecond,
                    ...(count === 3
                      ? { auth: { ...refreshedSnapshotSecond.auth, workspaceId: "ws-b" } }
                      : {}),
                    usageLimits: {
                      checkedAt: "2026-04-10T00:00:03.000Z",
                      windows: [],
                      unavailable: { reason: "probeFailed" },
                    },
                  },
            ),
          ),
          enrichSnapshot: ({ snapshot, publishSnapshot }) =>
            Deferred.await(releaseEnrichment).pipe(
              Effect.flatMap(() =>
                publishSnapshot({
                  ...enrichedSnapshot,
                  ...snapshot,
                  models: enrichedSnapshot.models,
                }),
              ),
            ),
          refreshInterval: "1 hour",
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);

        const liveWindow = {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 60,
        } as const;
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:00:02.000Z",
          authLabel: "tier-2",
          windows: [liveWindow],
        });

        if (clearPlan) {
          yield* provider.applyUsageLimits({
            checkedAt: "2026-04-10T00:00:02.000Z",
            complete: true,
            windows: [liveWindow],
          });
        }

        yield* Deferred.succeed(releaseEnrichment, undefined);
        const enriched = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)[0]!),
        );
        assert.deepStrictEqual(enriched.models, enrichedSnapshot.models);
        assert.deepStrictEqual(enriched.usageLimits?.windows, [liveWindow]);
        assert.strictEqual(enriched.auth.label, clearPlan ? undefined : "tier-2");

        const refreshed = yield* provider.refresh;
        assert.strictEqual(refreshed.message, refreshedSnapshotSecond.message);
        assert.deepStrictEqual(refreshed.usageLimits?.windows, [liveWindow]);
        assert.strictEqual(refreshed.auth.workspaceId, "ws-a");
        assert.strictEqual(refreshed.auth.label, clearPlan ? undefined : "tier-2");

        const switched = yield* provider.refresh;
        assert.strictEqual(switched.auth.workspaceId, "ws-b");
        assert.strictEqual(switched.usageLimits?.unavailable?.reason, "probeFailed");
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect.each([
    { name: "an empty reading", hasUsage: true, clearPlan: false },
    { name: "no reading", hasUsage: false, clearPlan: false },
    { name: "an empty reading after clearing the plan", hasUsage: true, clearPlan: true },
    { name: "no reading after clearing the plan", hasUsage: false, clearPlan: true },
  ])("keeps the live plan and limits after $name", ({ hasUsage, clearPlan }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const count = yield* Ref.make(0);
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.gen(function* () {
            if ((yield* Ref.updateAndGet(count, (n) => n + 1)) > 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
            return {
              ...refreshedSnapshot,
              auth: { status: "authenticated", label: "tier-1" },
              ...(hasUsage
                ? { usageLimits: { checkedAt: refreshedSnapshot.checkedAt, windows: [] } }
                : {}),
            } satisfies ServerProvider;
          }),
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
        const refresh = yield* provider.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:00:04.000Z",
          authLabel: "tier-2",
          complete: true,
          windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 70 }],
        });
        if (clearPlan) {
          yield* provider.applyUsageLimits({
            checkedAt: "2026-04-10T00:00:04.000Z",
            complete: true,
            windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 70 }],
          });
        }
        yield* Deferred.succeed(release, undefined);
        const refreshed = yield* Fiber.join(refresh);
        assert.strictEqual(refreshed.auth.label, clearPlan ? undefined : "tier-2");
        assert.strictEqual(refreshed.usageLimits?.windows[0]?.usedPercent, 70);
        assert.strictEqual(refreshed.usageLimits?.unavailable, undefined);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("drops an earlier plan override after a complete reading without a label", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const usageLimits = {
          checkedAt: "2026-04-10T00:00:04.000Z",
          windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 70 }],
        } as const;
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.succeed({ ...refreshedSnapshot, usageLimits }),
          refreshOnInterval: false,
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
        yield* provider.applyUsageLimits({ ...usageLimits, complete: true, authLabel: "tier-2" });
        assert.strictEqual((yield* provider.refresh).auth.label, "tier-2");

        yield* provider.applyUsageLimits({ ...usageLimits, complete: true });
        assert.strictEqual((yield* provider.getSnapshot).auth.label, undefined);
        const refreshed = yield* provider.refresh;
        assert.strictEqual(refreshed.auth.label, undefined);
        assert.deepStrictEqual(refreshed.usageLimits, usageLimits);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("keeps sparse usage unavailable after probe failure until a full probe recovers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failedLimits = {
          checkedAt: "2026-04-10T00:00:01.000Z",
          windows: [],
          unavailable: { reason: "probeFailed", message: "Usage probe timed out." },
        } as const;
        const probeSnapshot = yield* Ref.make<ServerProvider>({
          ...refreshedSnapshot,
          usageLimits: failedLimits,
        });
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.get(probeSnapshot),
          refreshOnInterval: false,
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);

        const weekly = {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 20,
        } as const;
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:00:02.000Z",
          windows: [weekly],
        });
        const partial = yield* provider.getSnapshot;
        assert.deepStrictEqual(partial.usageLimits, {
          checkedAt: "2026-04-10T00:00:02.000Z",
          windows: [weekly],
          unavailable: failedLimits.unavailable,
        });
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:00:03.000Z",
          windows: [{ ...weekly }],
        });
        assert.strictEqual(yield* provider.getSnapshot, partial);
        assert.deepStrictEqual((yield* provider.refresh).usageLimits, failedLimits);

        const completeLimits = {
          checkedAt: "2026-04-10T00:00:04.000Z",
          windows: [
            { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 },
            { ...weekly, usedPercent: 25 },
          ],
        } as const;
        yield* Ref.set(probeSnapshot, { ...refreshedSnapshot, usageLimits: completeLimits });
        assert.deepStrictEqual((yield* provider.refresh).usageLimits, completeLimits);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect(
    "keeps versionAdvisory across re-probes while enrichment runs and clears it on version change",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const placeholderAdvisory = (currentVersion: string, checkedAt: string) =>
            ({
              status: "unknown",
              currentVersion,
              latestVersion: null,
              updateCommand: null,
              canUpdate: false,
              canInstallVersion: false,
              checkedAt,
              message: null,
            }) as const;
          const behindAdvisory = {
            status: "behind_latest",
            currentVersion: "1.0.0",
            latestVersion: "2.0.0",
            updateCommand: "npm install -g @openai/codex@latest",
            canUpdate: true,
            canInstallVersion: true,
            checkedAt: "2026-04-10T00:00:02.000Z",
            message: "Install the update now or review provider settings.",
          } as const;
          const probedRef = yield* Ref.make<ServerProvider>({
            ...refreshedSnapshot,
            version: "1.0.0",
            versionAdvisory: placeholderAdvisory("1.0.0", "2026-04-10T00:00:01.000Z"),
          });
          const enrichCalls = yield* Ref.make(0);
          const secondEnrichStarted = yield* Deferred.make<void>();
          const releaseSecondEnrich = yield* Deferred.make<void>();
          const thirdEnrichStarted = yield* Deferred.make<void>();
          const releaseThirdEnrich = yield* Deferred.make<void>();

          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.get(probedRef),
            refreshInterval: "1 minute",
            enrichSnapshot: ({ snapshot, publishSnapshot }) =>
              Effect.gen(function* () {
                const call = yield* Ref.updateAndGet(enrichCalls, (n) => n + 1);
                if (call === 1) {
                  yield* publishSnapshot({ ...snapshot, versionAdvisory: behindAdvisory });
                  return;
                }
                if (call === 2) {
                  yield* Deferred.succeed(secondEnrichStarted, undefined);
                  yield* Deferred.await(releaseSecondEnrich);
                  yield* publishSnapshot({ ...snapshot, versionAdvisory: behindAdvisory });
                  return;
                }
                yield* Deferred.succeed(thirdEnrichStarted, undefined);
                yield* Deferred.await(releaseThirdEnrich);
              }),
          });

          // Initial probe + enrichment settles with behind_latest.
          yield* provider.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.versionAdvisory?.status === "behind_latest"),
            Stream.take(1),
            Stream.runDrain,
          );

          // Periodic re-probe for the same version must not drop versionAdvisory while enrichment runs.
          yield* Ref.set(probedRef, {
            ...refreshedSnapshot,
            version: "1.0.0",
            checkedAt: "2026-04-10T00:01:01.000Z",
            versionAdvisory: placeholderAdvisory("1.0.0", "2026-04-10T00:01:01.000Z"),
          });
          const periodicProbe = yield* provider.streamChanges.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 minute");
          yield* Deferred.await(secondEnrichStarted);
          const [duringPeriodicEnrich] = Array.from(yield* Fiber.join(periodicProbe));
          assert.deepStrictEqual(duringPeriodicEnrich?.versionAdvisory, behindAdvisory);
          yield* Deferred.succeed(releaseSecondEnrich, undefined);

          // Once the installed version changes, the stale behind_latest advisory must not carry over.
          const updatedPlaceholder = placeholderAdvisory("2.0.0", "2026-04-10T00:02:01.000Z");
          yield* Ref.set(probedRef, {
            ...refreshedSnapshot,
            version: "2.0.0",
            checkedAt: "2026-04-10T00:02:01.000Z",
            versionAdvisory: updatedPlaceholder,
          });
          const upgradedProbe = yield* provider.streamChanges.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 minute");
          yield* Deferred.await(thirdEnrichStarted);
          const [duringUpgradeEnrich] = Array.from(yield* Fiber.join(upgradedProbe));
          assert.deepStrictEqual(duringUpgradeEnrich?.versionAdvisory, updatedPlaceholder);
          yield* Deferred.succeed(releaseThirdEnrich, undefined);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect(
    "awaits one-shot enrichment on explicit refresh without publishing an un-enriched snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const enrichCalls = yield* Ref.make(0);
          const secondEnrichStarted = yield* Deferred.make<void>();
          const releaseSecondEnrich = yield* Deferred.make<void>();
          const behindAdvisory = {
            status: "behind_latest",
            currentVersion: "1.0.0",
            latestVersion: "2.0.0",
            updateCommand: "npm install -g @openai/codex@latest",
            canUpdate: true,
            canInstallVersion: true,
            checkedAt: "2026-04-10T00:00:02.000Z",
            message: "Install the update now or review provider settings.",
          } as const;
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Effect.succeed({ ...refreshedSnapshot, version: "1.0.0" }),
            refreshOnInterval: false,
            enrichSnapshot: ({ snapshot, publishSnapshot }) =>
              Effect.gen(function* () {
                const call = yield* Ref.updateAndGet(enrichCalls, (n) => n + 1);
                if (call === 1) {
                  yield* publishSnapshot({
                    ...snapshot,
                    versionAdvisory: {
                      ...behindAdvisory,
                      status: "current",
                      latestVersion: "1.0.0",
                      message: null,
                    },
                  });
                  return;
                }
                yield* Deferred.succeed(secondEnrichStarted, undefined);
                yield* Deferred.await(releaseSecondEnrich);
                yield* publishSnapshot({ ...snapshot, versionAdvisory: behindAdvisory });
              }),
          });
          yield* provider.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.versionAdvisory?.status === "current"),
            Stream.take(1),
            Stream.runDrain,
          );

          const published = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
          const behindPublished = yield* Deferred.make<void>();
          yield* provider.streamChanges.pipe(
            Stream.runForEach((snapshot) =>
              Ref.update(published, (all) => [...all, snapshot]).pipe(
                Effect.andThen(
                  snapshot.versionAdvisory?.status === "behind_latest"
                    ? Deferred.succeed(behindPublished, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ),
              ),
            ),
            Effect.forkChild,
          );
          yield* Effect.yieldNow;

          const refresh = yield* provider.refresh.pipe(Effect.forkChild);
          yield* Deferred.await(secondEnrichStarted);
          assert.isUndefined(refresh.pollUnsafe());
          assert.deepStrictEqual(yield* Ref.get(published), []);

          yield* Deferred.succeed(releaseSecondEnrich, undefined);
          const refreshed = yield* Fiber.join(refresh);
          assert.deepStrictEqual(refreshed.versionAdvisory, behindAdvisory);
          yield* Deferred.await(behindPublished);
          assert.deepStrictEqual(
            (yield* Ref.get(published)).map((snapshot) => snapshot.versionAdvisory),
            [behindAdvisory],
          );
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect(
    "completes an overlapping explicit refresh when a newer refresh supersedes its enrichment before it starts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const probeCalls = yield* Ref.make(0);
          const initialEnrichDone = yield* Deferred.make<void>();
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.updateAndGet(probeCalls, (n) => n + 1).pipe(
              Effect.map((call) => ({
                ...refreshedSnapshot,
                version: `1.0.${call}`,
              })),
            ),
            refreshOnInterval: false,
            enrichSnapshot: ({ snapshot, publishSnapshot }) =>
              publishSnapshot({
                ...snapshot,
                versionAdvisory: {
                  status: "behind_latest",
                  currentVersion: snapshot.version,
                  latestVersion: "2.0.0",
                  updateCommand: "npm install -g @openai/codex@latest",
                  canUpdate: true,
                  canInstallVersion: true,
                  checkedAt: "2026-04-10T00:00:02.000Z",
                  message: "Update available.",
                },
              }).pipe(Effect.andThen(Deferred.succeed(initialEnrichDone, undefined))),
          });
          yield* Deferred.await(initialEnrichDone);

          // Fork both immediately so the second refresh interrupts the first enrichment fiber
          // before its `onExit` handler runs; the first refresh must still observe the replacement.
          const first = yield* Effect.forkChild(provider.refresh, { startImmediately: true });
          const second = yield* Effect.forkChild(provider.refresh, { startImmediately: true });
          const [firstSnapshot, secondSnapshot] = yield* Effect.all([
            Fiber.join(first),
            Fiber.join(second),
          ]);
          assert.strictEqual(firstSnapshot.versionAdvisory?.status, "behind_latest");
          assert.strictEqual(secondSnapshot.versionAdvisory?.status, "behind_latest");
          assert.strictEqual(secondSnapshot.version, "1.0.3");
        }),
      ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect(
    "holds usage limit updates until deferred enrichment publishes and merges them into the enriched snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const enrichCalls = yield* Ref.make(0);
          const secondEnrichStarted = yield* Deferred.make<void>();
          const releaseSecondEnrich = yield* Deferred.make<void>();
          const versionRef = yield* Ref.make("1.0.0");
          const behindAdvisory = (currentVersion: string) =>
            ({
              status: "behind_latest",
              currentVersion,
              latestVersion: "3.0.0",
              updateCommand: "npm install -g @openai/codex@latest",
              canUpdate: true,
              canInstallVersion: true,
              checkedAt: "2026-04-10T00:00:02.000Z",
              message: "Update available.",
            }) as const;
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.get(versionRef).pipe(
              Effect.map((version) => ({
                ...refreshedSnapshot,
                version,
                versionAdvisory: {
                  status: "unknown",
                  currentVersion: version,
                  latestVersion: null,
                  updateCommand: null,
                  canUpdate: false,
                  canInstallVersion: false,
                  checkedAt: "2026-04-10T00:00:01.000Z",
                  message: null,
                },
              })),
            ),
            refreshOnInterval: false,
            enrichSnapshot: ({ snapshot, publishSnapshot }) =>
              Effect.gen(function* () {
                const call = yield* Ref.updateAndGet(enrichCalls, (n) => n + 1);
                if (call === 2) {
                  yield* Deferred.succeed(secondEnrichStarted, undefined);
                  yield* Deferred.await(releaseSecondEnrich);
                }
                yield* publishSnapshot({
                  ...snapshot,
                  versionAdvisory: behindAdvisory(snapshot.version ?? "1.0.0"),
                });
              }),
          });
          yield* provider.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.versionAdvisory?.status === "behind_latest"),
            Stream.take(1),
            Stream.runDrain,
          );

          const published = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
          const secondPublished = yield* Deferred.make<void>();
          yield* provider.streamChanges.pipe(
            Stream.runForEach((snapshot) =>
              Ref.update(published, (all) => [...all, snapshot]).pipe(
                Effect.andThen(
                  snapshot.version === "2.0.0" &&
                    snapshot.versionAdvisory?.status === "behind_latest"
                    ? Deferred.succeed(secondPublished, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ),
              ),
            ),
            Effect.forkChild,
          );
          yield* Effect.yieldNow;

          // Move to 2.0.0 so the placeholder advisory is not carried from 1.0.0.
          yield* Ref.set(versionRef, "2.0.0");
          const refresh = yield* provider.refresh.pipe(Effect.forkChild);
          yield* Deferred.await(secondEnrichStarted);

          yield* provider.applyUsageLimits({
            checkedAt: "2026-04-10T00:05:00.000Z",
            windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 40 }],
            authLabel: "Pro",
          });
          yield* Effect.yieldNow;
          // The usage tick must not flush the un-enriched placeholder snapshot early.
          assert.deepStrictEqual(yield* Ref.get(published), []);

          yield* Deferred.succeed(releaseSecondEnrich, undefined);
          const refreshed = yield* Fiber.join(refresh);
          yield* Deferred.await(secondPublished);

          assert.strictEqual(refreshed.versionAdvisory?.status, "behind_latest");
          assert.strictEqual(refreshed.auth.label, "Pro");
          assert.strictEqual(refreshed.usageLimits?.windows[0]?.usedPercent, 40);
          const emitted = yield* Ref.get(published);
          assert.strictEqual(emitted.length, 1);
          assert.strictEqual(emitted[0]?.versionAdvisory?.status, "behind_latest");
          assert.strictEqual(emitted[0]?.usageLimits?.windows[0]?.usedPercent, 40);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect(
    "publishes the probed snapshot when one-shot enrichment skips publishing or times out",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hangEnrichmentRef = yield* Ref.make(false);
          const hungEnrichStarted = yield* Deferred.make<void>();
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Effect.succeed(refreshedSnapshot),
            refreshOnInterval: false,
            enrichSnapshot: () =>
              Effect.gen(function* () {
                if (!(yield* Ref.get(hangEnrichmentRef))) {
                  // Finishes without calling publishSnapshot.
                  return;
                }
                yield* Deferred.succeed(hungEnrichStarted, undefined);
                return yield* Effect.never;
              }),
          });
          yield* provider.streamChanges.pipe(Stream.take(1), Stream.runDrain);

          // Enrichment exits without publishing -> pending snapshot is published on exit.
          const noopPublished = yield* provider.streamChanges.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          assert.deepStrictEqual(yield* provider.refresh, refreshedSnapshot);
          assert.deepStrictEqual(Array.from(yield* Fiber.join(noopPublished)), [refreshedSnapshot]);

          // Enrichment hangs -> refresh times out after 25s and publishes the probed snapshot.
          yield* Ref.set(hangEnrichmentRef, true);
          const timeoutPublished = yield* provider.streamChanges.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          const hungRefresh = yield* provider.refresh.pipe(Effect.forkChild);
          yield* Deferred.await(hungEnrichStarted);
          assert.isUndefined(hungRefresh.pollUnsafe());

          yield* TestClock.adjust("25 seconds");
          assert.deepStrictEqual(yield* Fiber.join(hungRefresh), refreshedSnapshot);
          assert.deepStrictEqual(Array.from(yield* Fiber.join(timeoutPublished)), [
            refreshedSnapshot,
          ]);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect("does not block explicit refresh when awaitEnrichmentOnRefresh is false", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.succeed(refreshedSnapshot),
          refreshOnInterval: false,
          awaitEnrichmentOnRefresh: false,
          enrichSnapshot: () => Effect.never,
        });
        yield* provider.streamChanges.pipe(Stream.take(1), Stream.runDrain);
        assert.deepStrictEqual(yield* provider.refresh, refreshedSnapshot);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
});
