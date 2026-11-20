import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerProvider,
  ServerSettingsError,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as ProviderHost from "./ProviderHost.ts";
import {
  applyUsageLimitsUpdate,
  makeUsageLimits,
  resolveUsageLimitsAfterProbe,
} from "./usageLimits.ts";
import type { ManagedServerProvider } from "./snapshot.ts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
  // null preserves an explicitly cleared plan across probes and enrichment.
  readonly usageAuthLabel: string | null | undefined;
  readonly checked: boolean;
  // False while an explicit refresh holds publication for its one-shot enrichment.
  readonly published: boolean;
}

function isPlaceholderVersionAdvisory(advisory: ServerProvider["versionAdvisory"]): boolean {
  return (
    advisory === undefined ||
    (advisory.status === "unknown" &&
      advisory.latestVersion === null &&
      advisory.updateCommand === null &&
      !advisory.canUpdate &&
      !advisory.canInstallVersion &&
      advisory.message === null)
  );
}

function preserveVersionAdvisoryAcrossProbe(
  previous: ServerProvider,
  probed: ServerProvider,
): ServerProvider {
  const previousAdvisory = previous.versionAdvisory;
  if (
    !probed.enabled ||
    !probed.installed ||
    previousAdvisory === undefined ||
    isPlaceholderVersionAdvisory(previousAdvisory) ||
    !isPlaceholderVersionAdvisory(probed.versionAdvisory)
  ) {
    return probed;
  }
  const probedVersion =
    probed.installedVersion !== undefined ? probed.installedVersion : probed.version;
  if (probedVersion === null || probedVersion !== previousAdvisory.currentVersion) {
    return probed;
  }
  return { ...probed, versionAdvisory: previousAdvisory };
}

function withUsageLimits(
  snapshot: ServerProvider,
  usageLimits: ServerProvider["usageLimits"],
): ServerProvider {
  if (snapshot.usageLimits === usageLimits) {
    return snapshot;
  }
  const { usageLimits: _previous, ...rest } = snapshot;
  return usageLimits ? { ...rest, usageLimits } : rest;
}

const FAILED_CHECK_RECHECK_DELAY = "30 seconds";
// Bounds `provider.refresh` so a stalled or long-lived enrichment cannot wedge callers indefinitely.
const ENRICHMENT_REFRESH_TIMEOUT = Duration.seconds(25);

/**
 * True inside a `checkProvider` whose failure over a ready provider is discarded for a recheck.
 * A provider that also records check results in its own state must leave that failure out of it.
 */
export const DeferringFailedCheck = Context.Reference<boolean>("t3/provider/DeferringFailedCheck", {
  defaultValue: () => false,
});

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly resolveMaintenance: ManagedServerProvider["resolveMaintenance"];
  readonly getSettings: Effect.Effect<Settings, ServerSettingsError>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => Effect.Effect<ServerProvider>;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly checkUsageLimits?: Effect.Effect<ServerProvider["usageLimits"]>;
  readonly invalidateUsageCache?: Effect.Effect<void>;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  /** Set false when `enrichSnapshot` subscribes to a long-lived stream that never terminates. */
  readonly awaitEnrichmentOnRefresh?: boolean;
  readonly refreshInterval?: Duration.Input;
  readonly refreshOnInterval?: boolean | ((snapshot: ServerProvider) => boolean);
  readonly checkProviderOnSettingsChange?: (previous: Settings, next: Settings) => boolean;
}): Effect.fn.Return<
  ManagedServerProvider,
  ServerSettingsError,
  Scope.Scope | ProviderHost.ProviderHost
> {
  const host = yield* ProviderHost.ProviderHost;
  const refreshSemaphore = yield* Semaphore.make(1);
  const usageRefreshQueued = yield* Ref.make<symbol | null>(null);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = yield* input.initialSnapshot(initialSettings);
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
    usageAuthLabel: undefined,
    checked: false,
    published: true,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const recheckPendingRef = yield* Ref.make(false);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const enrichmentDoneRef = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  const scope = yield* Effect.scope;
  const awaitEnrichmentOnRefresh =
    input.enrichSnapshot !== undefined && input.awaitEnrichmentOnRefresh !== false;

  const publishPendingSnapshot = (generation: number) =>
    Ref.modify(snapshotStateRef, (state) =>
      state.enrichmentGeneration === generation && !state.published
        ? ([state.snapshot, { ...state, published: true }] as const)
        : ([null, state] as const),
    ).pipe(
      Effect.flatMap((snapshot) =>
        snapshot === null ? Effect.void : PubSub.publish(changesPubSub, snapshot),
      ),
    );

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  ) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (state.enrichmentGeneration !== generation) {
        return [null, state] as const;
      }
      // Enrichment must not revert usage updates newer than its input snapshot.
      const merged = withUsageLimits(
        state.usageAuthLabel === undefined
          ? nextSnapshot
          : {
              ...nextSnapshot,
              auth: { ...nextSnapshot.auth, label: state.usageAuthLabel ?? undefined },
            },
        state.snapshot.usageLimits,
      );
      if (state.published && Equal.equals(state.snapshot, merged)) {
        return [null, state] as const;
      }
      return [merged, { ...state, snapshot: merged, published: true }] as const;
    });
    if (snapshotToPublish === null) {
      return;
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish);
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const enrichmentDone =
      input.enrichSnapshot && snapshot.enabled ? yield* Deferred.make<void>() : null;
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // Publish the replacement barrier before interrupting the previous fiber so callers waiting
        // on the old barrier observe the new one instead of a transient null gap. Complete the
        // replaced barrier ourselves too in case the previous fiber is interrupted before its
        // `onExit` handler ever runs.
        const previousDone = yield* Ref.getAndSet(enrichmentDoneRef, enrichmentDone);
        const releasePrevious =
          previousDone === null
            ? Effect.void
            : Deferred.succeed(previousDone, undefined).pipe(Effect.asVoid);
        const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
        if (previousFiber) {
          yield* restore(Fiber.interrupt(previousFiber).pipe(Effect.ignore)).pipe(
            Effect.ensuring(releasePrevious),
          );
        } else {
          yield* releasePrevious;
        }

        if (!input.enrichSnapshot || !snapshot.enabled || enrichmentDone === null) {
          return;
        }

        const fiber = yield* Effect.interruptible(
          input.enrichSnapshot({
            settings,
            snapshot,
            getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
            publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
          }),
        ).pipe(
          Effect.onExit((exit) =>
            (Exit.hasInterrupts(exit) ? Effect.void : publishPendingSnapshot(generation)).pipe(
              Effect.ensuring(Deferred.succeed(enrichmentDone, undefined)),
            ),
          ),
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(scope),
        );

        yield* Ref.set(enrichmentFiberRef, fiber);
      }).pipe(
        Effect.onInterrupt(() =>
          publishPendingSnapshot(generation).pipe(
            Effect.ensuring(
              enrichmentDone === null
                ? Effect.void
                : Ref.update(enrichmentDoneRef, (current) =>
                    current === enrichmentDone ? null : current,
                  ).pipe(
                    Effect.andThen(Deferred.succeed(enrichmentDone, undefined)),
                    Effect.asVoid,
                  ),
            ),
          ),
        ),
      ),
    );
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: {
      readonly forceRefresh?: boolean;
      readonly deferFailure?: boolean;
      readonly deferPublish?: boolean;
    },
  ) {
    const previousSettings = yield* Ref.get(settingsRef);
    const settingsChanged =
      options?.forceRefresh === true || input.haveSettingsChanged(previousSettings, nextSettings);
    // Nothing watches credential files, so any settings apply rechecks a failed sign-in.
    const { snapshot: currentSnapshot } = yield* Ref.get(snapshotStateRef);
    const forceRefresh =
      options?.forceRefresh === true ||
      (currentSnapshot.enabled && currentSnapshot.auth.status === "unauthenticated");
    if (!forceRefresh && !settingsChanged) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    if (
      !forceRefresh &&
      input.checkProviderOnSettingsChange?.(previousSettings, nextSettings) === false
    ) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const { snapshot, generation } = yield* Ref.modify(snapshotStateRef, (state) => {
            const nextGeneration = state.enrichmentGeneration + 1;
            return [
              { snapshot: state.snapshot, generation: nextGeneration },
              { ...state, enrichmentGeneration: nextGeneration },
            ] as const;
          });
          yield* Ref.set(settingsRef, nextSettings);
          yield* restore(restartSnapshotEnrichment(nextSettings, snapshot, generation)).pipe(
            Effect.onInterrupt(() => publishPendingSnapshot(generation)),
          );
          return snapshot;
        }),
      );
    }

    // A probe without usage must not erase a report published while its I/O was in flight.
    const usageBeforeProbe = (yield* Ref.get(snapshotStateRef)).snapshot.usageLimits;
    const probedSnapshot = yield* input.checkProvider.pipe(
      Effect.provideService(DeferringFailedCheck, options?.deferFailure === true),
    );
    // One failed periodic check over a ready provider is often transient; recheck before showing it.
    if (
      options?.deferFailure === true &&
      probedSnapshot.status === "error" &&
      probedSnapshot.auth.status !== "unauthenticated"
    ) {
      const { snapshot } = yield* Ref.get(snapshotStateRef);
      if (snapshot.enabled && snapshot.status === "ready") {
        yield* Ref.set(recheckPendingRef, true);
        return snapshot;
      }
    }
    const deferPublish =
      options?.deferPublish === true &&
      input.enrichSnapshot !== undefined &&
      probedSnapshot.enabled;
    const nextSnapshot = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const { snapshot, generation } = yield* Ref.modify(snapshotStateRef, (state) => {
          const nextGeneration = input.enrichSnapshot
            ? state.enrichmentGeneration + 1
            : state.enrichmentGeneration;
          // Failed reads retain limits only for the same account and original workspace.
          const previous = state.snapshot.auth;
          const differs = (a: string | undefined, b: string | undefined) =>
            a !== undefined && b !== undefined && a !== b;
          const switchedAccount =
            differs(probedSnapshot.auth.email?.toLowerCase(), previous.email?.toLowerCase()) ||
            (probedSnapshot.auth.workspaceId !== undefined &&
              probedSnapshot.auth.workspaceId !== previous.workspaceId);
          const usageLimits = switchedAccount
            ? probedSnapshot.usageLimits
            : probedSnapshot.usageLimits === undefined &&
                state.snapshot.usageLimits !== usageBeforeProbe
              ? state.snapshot.usageLimits
              : resolveUsageLimitsAfterProbe({
                  published: state.snapshot.usageLimits,
                  probed: probedSnapshot.usageLimits,
                });
          const workspaceId =
            usageLimits === probedSnapshot.usageLimits
              ? undefined
              : state.snapshot.auth.workspaceId;
          const usageAuthLabel =
            !switchedAccount && usageLimits?.checkedAt === state.snapshot.usageLimits?.checkedAt
              ? state.usageAuthLabel
              : undefined;
          const labeledProbe =
            usageAuthLabel === undefined
              ? probedSnapshot
              : {
                  ...probedSnapshot,
                  auth: { ...probedSnapshot.auth, label: usageAuthLabel ?? undefined },
                };
          const probedWithUsage = withUsageLimits(
            workspaceId && !probedSnapshot.auth.workspaceId
              ? { ...labeledProbe, auth: { ...labeledProbe.auth, workspaceId } }
              : labeledProbe,
            usageLimits,
          );
          // Base probes return an un-enriched versionAdvisory placeholder; carry the current
          // advisory until enrichment refreshes it so periodic and usage probes never flicker updates.
          const next = input.enrichSnapshot
            ? preserveVersionAdvisoryAcrossProbe(state.snapshot, probedWithUsage)
            : probedWithUsage;
          return [
            { snapshot: next, generation: nextGeneration },
            {
              snapshot: next,
              enrichmentGeneration: nextGeneration,
              usageAuthLabel,
              checked: true,
              published: !deferPublish,
            },
          ] as const;
        });
        yield* Ref.set(settingsRef, nextSettings);
        if (!deferPublish) {
          yield* PubSub.publish(changesPubSub, snapshot);
        }
        yield* restore(restartSnapshotEnrichment(nextSettings, snapshot, generation)).pipe(
          Effect.onInterrupt(() => publishPendingSnapshot(generation)),
        );
        return snapshot;
      }),
    );
    return nextSnapshot;
  });
  const applySnapshot = (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean; readonly deferPublish?: boolean },
  ) => refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  // Providers call this on every token-usage tick, usually without changing the snapshot.
  const applyUsageLimits: ManagedServerProvider["applyUsageLimits"] = Effect.fnUntraced(
    function* (update) {
      const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
        const complete = update.complete && update.windows.length > 0;
        const usageLimits = complete
          ? makeUsageLimits(update)
          : applyUsageLimitsUpdate({
              previous: state.snapshot.usageLimits,
              update,
              checkedAt: update.checkedAt,
            });
        const { auth } = state.snapshot;
        const label = update.windows.length > 0 ? update.authLabel : undefined;
        const relabel =
          (label !== undefined || (complete && state.usageAuthLabel !== undefined)) &&
          label !== auth.label;
        if (usageLimits === state.snapshot.usageLimits && !relabel) {
          return [null, state] as const;
        }
        const snapshot = withUsageLimits(
          relabel ? { ...state.snapshot, auth: { ...auth, label } } : state.snapshot,
          usageLimits,
        );
        return [
          state.published ? snapshot : null,
          {
            ...state,
            snapshot,
            usageAuthLabel: label ?? (complete ? null : state.usageAuthLabel),
          },
        ] as const;
      });
      if (snapshotToPublish !== null) {
        yield* PubSub.publish(changesPubSub, snapshotToPublish);
      }
    },
  );

  const awaitEnrichment = Effect.fn("ManagedServerProvider.awaitEnrichment")(function* () {
    const completed = yield* Effect.gen(function* () {
      while (true) {
        const done = yield* Ref.get(enrichmentDoneRef);
        if (done === null) return;
        yield* Deferred.await(done);
        if ((yield* Ref.get(enrichmentDoneRef)) === done) return;
      }
    }).pipe(Effect.timeoutOption(ENRICHMENT_REFRESH_TIMEOUT));
    if (Option.isNone(completed)) {
      const { enrichmentGeneration } = yield* Ref.get(snapshotStateRef);
      yield* publishPendingSnapshot(enrichmentGeneration);
    }
  });

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    const probed = yield* applySnapshot(nextSettings, {
      forceRefresh: true,
      deferPublish: awaitEnrichmentOnRefresh,
    });
    if (!awaitEnrichmentOnRefresh) {
      return probed;
    }
    yield* awaitEnrichment();
    return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
  });

  const refreshUsage = Effect.fn("ManagedServerProvider.refreshUsage")(function* () {
    const { snapshot } = yield* Ref.get(snapshotStateRef);
    if (
      !snapshot.enabled ||
      !snapshot.usageLimits ||
      snapshot.usageLimits.unavailable?.reason === "unsupported"
    )
      return;
    // An in-flight refresh may have read cached usage, so one refresh waits behind it.
    const claim = Symbol();
    const release = Ref.update(usageRefreshQueued, (queued) => (queued === claim ? null : queued));
    yield* Effect.uninterruptibleMask((restore) =>
      Ref.modify(usageRefreshQueued, (queued) => [queued !== null, queued ?? claim]).pipe(
        Effect.flatMap((held) =>
          held
            ? Effect.void
            : restore(
                refreshSemaphore.withPermits(1)(
                  release.pipe(
                    Effect.andThen(input.invalidateUsageCache ?? Effect.void),
                    Effect.andThen(input.getSettings),
                    Effect.flatMap((settings) =>
                      applySnapshotBase(settings, { forceRefresh: true }),
                    ),
                  ),
                ),
              ).pipe(Effect.onInterrupt(() => release)),
        ),
      ),
    );
  });

  const needsUsageRecovery = (snapshot: ServerProvider) =>
    input.checkUsageLimits !== undefined &&
    snapshot.installed &&
    snapshot.status === "ready" &&
    snapshot.auth.status === "authenticated" &&
    snapshot.usageLimits?.unavailable?.reason === "probeFailed";

  const needsProviderRefresh = (snapshot: ServerProvider) =>
    input.refreshOnInterval !== false &&
    (typeof input.refreshOnInterval !== "function" || input.refreshOnInterval(snapshot));

  const refreshOnInterval = Effect.fn("ManagedServerProvider.refreshOnInterval")(function* (
    deferFailure: boolean,
  ) {
    const { snapshot } = yield* Ref.get(snapshotStateRef);
    if (!snapshot.enabled) return;
    if (!needsUsageRecovery(snapshot) || !input.checkUsageLimits) {
      if (needsProviderRefresh(snapshot)) {
        yield* applySnapshotBase(yield* input.getSettings, { forceRefresh: true, deferFailure });
      }
      return;
    }
    const probed = yield* input.checkUsageLimits;
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      const usageLimits = resolveUsageLimitsAfterProbe({
        published: state.snapshot.usageLimits,
        probed,
      });
      const snapshot = withUsageLimits(state.snapshot, usageLimits);
      return [state.published ? snapshot : null, { ...state, snapshot }] as const;
    });
    if (snapshotToPublish !== null) {
      yield* PubSub.publish(changesPubSub, snapshotToPublish);
    }
  });

  const shouldRefreshOnInterval = Effect.gen(function* () {
    const state = yield* Ref.get(snapshotStateRef);
    // A disabled instance has nothing to probe; a periodic check would only
    // republish a snapshot that differs in checkedAt.
    if (
      !state.snapshot.enabled ||
      (!needsUsageRecovery(state.snapshot) && !needsProviderRefresh(state.snapshot))
    ) {
      return false;
    }
    const instanceId = state.snapshot.instanceId;
    const [genericDemand, instanceDemand] = yield* Effect.all([
      host.shouldRunBackgroundWork({ type: "provider-status" }),
      host.shouldRunBackgroundWork({ type: "provider-status", instanceId }),
    ]);
    return genericDemand || instanceDemand;
  });

  const getRefreshInterval =
    input.refreshInterval !== undefined
      ? Effect.succeed(input.refreshInterval)
      : host.settings.get.pipe(
          Effect.map(
            (settings) =>
              resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
          ),
          Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
        );

  const refreshIntervalChanges = yield* Queue.sliding<void>(1);
  if (input.refreshInterval === undefined) {
    const serverSettingsChanges = yield* host.settings.subscribe;
    yield* serverSettingsChanges.pipe(
      Stream.map((settings) =>
        Duration.toMillis(
          resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
        ),
      ),
      Stream.changes,
      Stream.runForEach(() => Queue.offer(refreshIntervalChanges, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
  }

  // A failed check must not end this subscription: the next settings change
  // retries, like the periodic and initial checks below.
  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)).pipe(Effect.ignoreCause({ log: true })),
  ).pipe(Effect.forkScoped);

  yield* Effect.forever(
    Effect.all([getRefreshInterval, Ref.getAndSet(recheckPendingRef, false)]).pipe(
      Effect.flatMap(([configuredInterval, recheckPending]) => {
        const refreshInterval = recheckPending ? FAILED_CHECK_RECHECK_DELAY : configuredInterval;
        // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - races the interval against a settings-change signal, not a timeout
        return Effect.raceFirst(
          Effect.sleep(
            Duration.toMillis(Duration.fromInputUnsafe(refreshInterval)) <= 0
              ? "60 seconds"
              : refreshInterval,
          ).pipe(Effect.as(true)),
          Queue.take(refreshIntervalChanges).pipe(Effect.as(false)),
        ).pipe(
          Effect.flatMap((intervalElapsed) =>
            intervalElapsed && Duration.toMillis(Duration.fromInputUnsafe(refreshInterval)) > 0
              ? shouldRefreshOnInterval.pipe(
                  Effect.flatMap((shouldRefresh) =>
                    shouldRefresh
                      ? refreshSemaphore.withPermits(1)(refreshOnInterval(!recheckPending))
                      : Effect.void,
                  ),
                )
              : Effect.void,
          ),
        );
      }),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  // Probes spawn provider CLIs; starting them during server startup slows the first client load.
  yield* (host.awaitServerReady ?? Effect.void).pipe(
    Effect.andThen(
      // Read under the lock, so a settings check in flight cannot be overwritten with older settings.
      refreshSemaphore.withPermits(1)(
        Ref.get(settingsRef).pipe(
          Effect.flatMap((settings) => applySnapshotBase(settings, { forceRefresh: true })),
        ),
      ),
    ),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  return {
    resolveMaintenance: input.resolveMaintenance,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    isAwaitingFirstCheck: Ref.get(snapshotStateRef).pipe(Effect.map((state) => !state.checked)),
    refresh: input
      .resolveMaintenance({ fresh: true })
      .pipe(Effect.andThen(refreshSnapshot), Effect.tapError(Effect.logError), Effect.orDie),
    applyUsageLimits,
    refreshUsage: refreshUsage(),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ManagedServerProvider;
});
