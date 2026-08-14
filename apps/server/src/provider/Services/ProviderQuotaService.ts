import {
  ProviderQuotaConsumeResetError,
  type ProviderInstanceId,
  type ProviderQuotaConsumeResetInput,
  type ProviderQuotaConsumeResetOutcome,
  ProviderQuotaReadError,
  type ProviderQuotaSnapshot,
  type ProviderQuotaSummary,
  PROVIDER_QUOTA_SUMMARY_MAX_INSTANCES,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import type { ProviderInstance } from "../ProviderDriver.ts";
import {
  errorProviderQuotaSnapshot,
  ProviderQuotaAdapterError,
  unknownProviderQuotaSnapshot,
} from "../ProviderQuota.ts";
import { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

const CACHE_TTL_MS = 30_000;
const CACHE_TTL_NANOS = BigInt(CACHE_TTL_MS) * 1_000_000n;
const MAX_RECORDED_RESET_ATTEMPTS = 256;
const PROVIDER_READ_TIMEOUT = "10 seconds";
const SUMMARY_STABILIZATION_ATTEMPTS = 3;

interface CacheEntry {
  readonly instance: ProviderInstance;
  readonly revision: number | null;
  readonly snapshot?: ProviderQuotaSnapshot;
  readonly cachedAtNanos?: bigint;
  readonly lastSuccess?: ProviderQuotaSnapshot;
  readonly inFlight?: Deferred.Deferred<CacheReadOutcome>;
}

interface ResetAttempt {
  readonly instance: ProviderInstance;
  readonly creditId: ProviderQuotaConsumeResetInput["creditId"];
  readonly lock: Semaphore.Semaphore;
  attempted: boolean;
}

type CacheReadOutcome =
  | { readonly _tag: "snapshot"; readonly snapshot: ProviderQuotaSnapshot }
  | { readonly _tag: "obsolete" };

const obsoleteCacheRead: CacheReadOutcome = { _tag: "obsolete" };

type CacheSelection =
  | { readonly _tag: "cached"; readonly snapshot: ProviderQuotaSnapshot }
  | { readonly _tag: "waiting"; readonly deferred: Deferred.Deferred<CacheReadOutcome> }
  | {
      readonly _tag: "owner";
      readonly deferred: Deferred.Deferred<CacheReadOutcome>;
      readonly previous?: ProviderQuotaSnapshot;
      readonly retired?: Deferred.Deferred<CacheReadOutcome>;
    };

export class ProviderQuotaService extends Context.Service<
  ProviderQuotaService,
  {
    readonly readSummary: Effect.Effect<ProviderQuotaSummary, ProviderQuotaReadError>;
    readonly consumeBankedReset: (
      input: ProviderQuotaConsumeResetInput,
    ) => Effect.Effect<ProviderQuotaConsumeResetOutcome, ProviderQuotaConsumeResetError>;
    readonly invalidate: (instanceId?: ProviderInstanceId) => Effect.Effect<void>;
  }
>()("t3/provider/Services/ProviderQuotaService") {}

const mapConsumeError = (error: ProviderQuotaAdapterError): ProviderQuotaConsumeResetError => {
  switch (error.reason) {
    case "authRequired":
      return new ProviderQuotaConsumeResetError({
        reason: "authRequired",
        detail: "Sign in to the provider before consuming a reset.",
      });
    case "unsupported":
      return new ProviderQuotaConsumeResetError({
        reason: "unsupported",
        detail: "This provider does not support banked quota resets.",
      });
    case "timeout":
    case "providerFailed":
      return new ProviderQuotaConsumeResetError({
        reason: "providerFailed",
        detail: "The provider could not consume the banked reset.",
      });
  }
};

const withConsumeTimeout = <A>(
  effect: Effect.Effect<A, ProviderQuotaAdapterError>,
): Effect.Effect<A, ProviderQuotaAdapterError> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: PROVIDER_READ_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new ProviderQuotaAdapterError({
            reason: "timeout",
            detail: "The provider reset request timed out.",
          }),
        ),
    }),
  );

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const cache = new Map<ProviderInstanceId, CacheEntry>();
  const resetAttempts = new Map<string, ResetAttempt>();
  const cacheMutex = yield* Semaphore.make(1);
  const resetAttemptsMutex = yield* Semaphore.make(1);

  const invalidate = Effect.fn("ProviderQuotaService.invalidate")(function* (
    instanceId?: ProviderInstanceId,
  ) {
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const retired = yield* cacheMutex.withPermits(1)(
          Effect.sync(() => {
            const deferreds: Array<Deferred.Deferred<CacheReadOutcome>> = [];
            const ids = instanceId === undefined ? Array.from(cache.keys()) : [instanceId];
            for (const id of ids) {
              const entry = cache.get(id);
              if (entry === undefined) continue;
              if (entry.inFlight !== undefined) deferreds.push(entry.inFlight);
              cache.set(id, {
                instance: entry.instance,
                revision: entry.revision,
                ...(entry.lastSuccess ? { lastSuccess: entry.lastSuccess } : {}),
              });
            }
            return deferreds;
          }),
        );
        yield* Effect.forEach(
          retired,
          (deferred) => Deferred.succeed(deferred, obsoleteCacheRead),
          { concurrency: "unbounded", discard: true },
        );
      }),
    );
  });

  const readCached = Effect.fn("ProviderQuotaService.readCached")(function* (
    instance: ProviderInstance,
    revision: number | null,
    readAt: string,
  ) {
    const now = yield* Clock.monotonicTimeNanos;
    const selection = yield* Effect.uninterruptible(
      cacheMutex
        .withPermits(1)(
          Effect.gen(function* (): Effect.fn.Return<CacheSelection> {
            const existing = cache.get(instance.instanceId);
            const sameIdentity = existing?.instance === instance;
            const sameRevision = sameIdentity && existing.revision === revision;

            if (
              sameRevision &&
              existing.snapshot !== undefined &&
              existing.cachedAtNanos !== undefined &&
              now - existing.cachedAtNanos < CACHE_TTL_NANOS
            ) {
              return { _tag: "cached", snapshot: existing.snapshot };
            }
            if (sameRevision && existing.inFlight !== undefined) {
              return { _tag: "waiting", deferred: existing.inFlight };
            }

            const deferred = yield* Deferred.make<CacheReadOutcome>();
            const previous = sameIdentity ? existing?.lastSuccess : undefined;
            const retired = existing?.inFlight;
            cache.set(instance.instanceId, {
              instance,
              revision,
              ...(previous ? { lastSuccess: previous } : {}),
              inFlight: deferred,
            });
            return {
              _tag: "owner",
              deferred,
              ...(previous ? { previous } : {}),
              ...(retired ? { retired } : {}),
            };
          }),
        )
        .pipe(
          Effect.tap((selection) =>
            selection._tag === "owner" && selection.retired !== undefined
              ? Deferred.succeed(selection.retired, obsoleteCacheRead)
              : Effect.void,
          ),
        ),
    );

    if (selection._tag === "cached") {
      return { _tag: "snapshot", snapshot: selection.snapshot } satisfies CacheReadOutcome;
    }
    if (selection._tag === "waiting") return yield* Deferred.await(selection.deferred);
    const retireOwnedGeneration = Effect.uninterruptible(
      cacheMutex
        .withPermits(1)(
          Effect.sync(() => {
            const current = cache.get(instance.instanceId);
            if (
              current?.instance !== instance ||
              current.revision !== revision ||
              current.inFlight !== selection.deferred
            ) {
              return;
            }
            cache.set(instance.instanceId, {
              instance,
              revision,
              ...(current.lastSuccess ? { lastSuccess: current.lastSuccess } : {}),
            });
          }),
        )
        .pipe(
          Effect.andThen(Deferred.succeed(selection.deferred, obsoleteCacheRead)),
          Effect.asVoid,
        ),
    );

    return yield* Effect.gen(function* () {
      const quota = instance.quota;
      const refreshed =
        quota === undefined
          ? unknownProviderQuotaSnapshot(instance, readAt)
          : yield* quota.read.pipe(
              Effect.timeoutOrElse({
                duration: PROVIDER_READ_TIMEOUT,
                orElse: () =>
                  Effect.fail(
                    new ProviderQuotaAdapterError({
                      reason: "timeout",
                      detail: "The provider quota read timed out.",
                    }),
                  ),
              }),
              Effect.catch((error) =>
                Effect.succeed(
                  errorProviderQuotaSnapshot(instance, readAt, error, selection.previous),
                ),
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.succeed(null)
                  : Effect.succeed(
                      errorProviderQuotaSnapshot(
                        instance,
                        readAt,
                        new ProviderQuotaAdapterError({
                          reason: "providerFailed",
                          detail: "The provider quota read failed.",
                          cause: Cause.squash(cause),
                        }),
                        selection.previous,
                      ),
                    ),
              ),
            );
      if (refreshed === null) {
        yield* retireOwnedGeneration;
        return obsoleteCacheRead;
      }

      const currentInstance = yield* registry
        .getInstance(instance.instanceId)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      const currentRevision =
        currentInstance === instance &&
        currentInstance.enabled &&
        currentInstance.quota !== undefined
          ? yield* currentInstance.quota.revision.pipe(
              Effect.catchCause(() => Effect.succeed(Number.NaN)),
            )
          : currentInstance === instance && currentInstance.enabled
            ? null
            : undefined;
      if (currentRevision === undefined || !Object.is(currentRevision, revision)) {
        yield* retireOwnedGeneration;
        return obsoleteCacheRead;
      }

      const completedAtNanos = yield* Clock.monotonicTimeNanos;
      const published = yield* cacheMutex.withPermits(1)(
        Effect.sync(() => {
          const current = cache.get(instance.instanceId);
          if (
            current?.instance !== instance ||
            current.revision !== revision ||
            current.inFlight !== selection.deferred
          ) {
            return false;
          }
          const lastSuccess =
            refreshed.lastSuccessfulReadAt !== null ? refreshed : current.lastSuccess;
          cache.set(instance.instanceId, {
            instance,
            revision,
            snapshot: refreshed,
            cachedAtNanos: completedAtNanos,
            ...(lastSuccess ? { lastSuccess } : {}),
          });
          return true;
        }),
      );
      const outcome: CacheReadOutcome = published
        ? { _tag: "snapshot", snapshot: refreshed }
        : obsoleteCacheRead;
      yield* Deferred.succeed(selection.deferred, outcome);
      return outcome;
    }).pipe(Effect.onInterrupt(() => retireOwnedGeneration));
  });

  const readSummary = Effect.fn("ProviderQuotaService.readSummary")(function* () {
    for (let attempt = 0; attempt < SUMMARY_STABILIZATION_ATTEMPTS; attempt += 1) {
      const instances = yield* registry.listInstances.pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            new ProviderQuotaReadError({
              reason: "registryUnavailable",
              cause: Cause.squash(cause),
            }),
          ),
        ),
      );
      const enabled = instances
        .filter((instance) => instance.enabled)
        .slice(0, PROVIDER_QUOTA_SUMMARY_MAX_INSTANCES);
      const enabledIdentities = new Map(enabled.map((instance) => [instance.instanceId, instance]));
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const retired = yield* cacheMutex.withPermits(1)(
            Effect.sync(() => {
              const deferreds: Array<Deferred.Deferred<CacheReadOutcome>> = [];
              for (const [id, entry] of cache) {
                if (enabledIdentities.get(id) === entry.instance) continue;
                cache.delete(id);
                if (entry.inFlight !== undefined) deferreds.push(entry.inFlight);
              }
              return deferreds;
            }),
          );
          yield* Effect.forEach(
            retired,
            (deferred) => Deferred.succeed(deferred, obsoleteCacheRead),
            { concurrency: "unbounded", discard: true },
          );
        }),
      );

      const readAt = DateTime.formatIso(yield* DateTime.now);
      const outcomes = yield* Effect.forEach(
        enabled,
        (instance) =>
          Effect.gen(function* () {
            const revision =
              instance.quota === undefined
                ? null
                : yield* instance.quota.revision.pipe(
                    Effect.catchCause(() => Effect.succeed(Number.NaN)),
                  );
            return yield* readCached(instance, revision, readAt);
          }),
        { concurrency: 3 },
      );
      const snapshots: Array<ProviderQuotaSnapshot> = [];
      let obsolete = false;
      for (const outcome of outcomes) {
        if (outcome._tag === "obsolete") {
          obsolete = true;
          break;
        }
        snapshots.push(outcome.snapshot);
      }
      if (obsolete) {
        if (attempt + 1 < SUMMARY_STABILIZATION_ATTEMPTS) continue;
        return yield* new ProviderQuotaReadError({
          reason: "instancesUnstable",
        });
      }

      return {
        readAt,
        instances: snapshots,
      } satisfies ProviderQuotaSummary;
    }
    return yield* new ProviderQuotaReadError({
      reason: "instancesUnstable",
    });
  });

  const consumeBankedReset = Effect.fn("ProviderQuotaService.consumeBankedReset")(function* (
    input: ProviderQuotaConsumeResetInput,
  ) {
    const instance = yield* registry.getInstance(input.instanceId).pipe(
      Effect.catchCause(() =>
        Effect.fail(
          new ProviderQuotaConsumeResetError({
            reason: "providerFailed",
            detail: "The provider instance could not be read.",
          }),
        ),
      ),
    );
    if (instance === undefined) {
      return yield* new ProviderQuotaConsumeResetError({
        reason: "instanceMissing",
        detail: "The provider instance does not exist.",
      });
    }
    if (!instance.enabled) {
      return yield* new ProviderQuotaConsumeResetError({
        reason: "instanceDisabled",
        detail: "The provider instance is disabled.",
      });
    }
    const quota = instance.quota;
    const consume = quota?.consumeBankedReset;
    if (quota === undefined || consume === undefined) {
      return yield* new ProviderQuotaConsumeResetError({
        reason: "unsupported",
        detail: "This provider does not support banked quota resets.",
      });
    }

    const attemptKey = `${instance.instanceId}\u0000${input.idempotencyKey}`;
    const attempt = yield* resetAttemptsMutex.withPermits(1)(
      Effect.gen(function* () {
        const recorded = resetAttempts.get(attemptKey);
        if (recorded?.instance === instance) return recorded;
        if (recorded !== undefined) resetAttempts.delete(attemptKey);
        if (resetAttempts.size >= MAX_RECORDED_RESET_ATTEMPTS) {
          const oldestKey = resetAttempts.keys().next().value;
          if (oldestKey !== undefined) resetAttempts.delete(oldestKey);
        }
        const created: ResetAttempt = {
          instance,
          creditId: input.creditId,
          lock: yield* Semaphore.make(1),
          attempted: false,
        };
        resetAttempts.set(attemptKey, created);
        return created;
      }),
    );
    if (attempt.creditId !== input.creditId) {
      return yield* new ProviderQuotaConsumeResetError({
        reason: "providerFailed",
        detail: "The reset request does not match its original attempt.",
      });
    }

    return yield* attempt.lock.withPermits(1)(
      Effect.gen(function* () {
        if (!attempt.attempted) {
          const eligibility = yield* withConsumeTimeout(quota.read).pipe(
            Effect.catchCause((cause) => {
              const error = Cause.findErrorOption(cause);
              return Effect.fail(
                Option.isSome(error)
                  ? mapConsumeError(error.value)
                  : new ProviderQuotaConsumeResetError({
                      reason: "providerFailed",
                      detail: "The provider quota inventory could not be refreshed.",
                    }),
              );
            }),
          );
          if (eligibility.status === "authRequired") {
            return yield* new ProviderQuotaConsumeResetError({
              reason: "authRequired",
              detail: "Sign in to the provider before consuming a reset.",
            });
          }
          if (eligibility.status !== "current") {
            return yield* new ProviderQuotaConsumeResetError({
              reason: "providerFailed",
              detail: "The provider quota inventory is not current.",
            });
          }
          const inventory = eligibility.bankedResets;
          const resetAvailable =
            input.creditId === null
              ? (inventory?.availableCount ?? 0) > 0
              : inventory?.resets.some(
                  (reset) => reset.id === input.creditId && reset.status === "available",
                ) === true;
          if (!resetAvailable) {
            return yield* new ProviderQuotaConsumeResetError({
              reason: "providerFailed",
              detail: "The selected banked reset is no longer available.",
            });
          }
        }

        const currentInstance = yield* registry
          .getInstance(input.instanceId)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
        if (currentInstance !== instance || !currentInstance.enabled) {
          return yield* new ProviderQuotaConsumeResetError({
            reason: "providerFailed",
            detail: "The provider instance changed before the reset could be consumed.",
          });
        }
        attempt.attempted = true;

        return yield* withConsumeTimeout(
          consume({ creditId: input.creditId, idempotencyKey: input.idempotencyKey }),
        ).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.findErrorOption(cause);
            return Effect.fail(
              Option.isSome(error)
                ? mapConsumeError(error.value)
                : new ProviderQuotaConsumeResetError({
                    reason: "providerFailed",
                    detail: "The provider could not consume the banked reset.",
                  }),
            );
          }),
          Effect.ensuring(invalidate(instance.instanceId)),
        );
      }).pipe(
        Effect.onError(() =>
          attempt.attempted
            ? Effect.void
            : resetAttemptsMutex.withPermits(1)(
                Effect.sync(() => {
                  if (resetAttempts.get(attemptKey) === attempt) resetAttempts.delete(attemptKey);
                }),
              ),
        ),
      ),
    );
  });

  return ProviderQuotaService.of({ readSummary: readSummary(), consumeBankedReset, invalidate });
});

export const layer = Layer.effect(ProviderQuotaService, make);

export const layerTest = (overrides: Partial<ProviderQuotaService["Service"]> = {}) =>
  Layer.mock(ProviderQuotaService)({
    readSummary: Effect.succeed({ readAt: "1970-01-01T00:00:00.000Z", instances: [] }),
    consumeBankedReset: () =>
      Effect.fail(
        new ProviderQuotaConsumeResetError({
          reason: "unsupported",
          detail: "This provider does not support banked quota resets.",
        }),
      ),
    invalidate: () => Effect.void,
    ...overrides,
  });
