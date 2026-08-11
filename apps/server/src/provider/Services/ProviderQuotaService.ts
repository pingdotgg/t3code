import {
  ProviderQuotaConsumeResetError,
  type ProviderInstanceId,
  type ProviderQuotaConsumeResetInput,
  type ProviderQuotaConsumeResetOutcome,
  ProviderQuotaReadError,
  type ProviderQuotaSnapshot,
  type ProviderQuotaSummary,
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
  type ProviderQuotaCapability,
  unknownProviderQuotaSnapshot,
} from "../ProviderQuota.ts";
import { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

const CACHE_TTL_MS = 30_000;
const PROVIDER_READ_TIMEOUT = "10 seconds";

interface CacheEntry {
  readonly instance: ProviderInstance;
  readonly revision: number | null;
  readonly snapshot?: ProviderQuotaSnapshot;
  readonly cachedAtMs?: number;
  readonly lastSuccess?: ProviderQuotaSnapshot;
  readonly inFlight?: Deferred.Deferred<ProviderQuotaSnapshot>;
}

type CacheSelection =
  | { readonly _tag: "cached"; readonly snapshot: ProviderQuotaSnapshot }
  | { readonly _tag: "waiting"; readonly deferred: Deferred.Deferred<ProviderQuotaSnapshot> }
  | {
      readonly _tag: "owner";
      readonly deferred: Deferred.Deferred<ProviderQuotaSnapshot>;
      readonly previous?: ProviderQuotaSnapshot;
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

const safeConsumeError = (reason: ProviderQuotaConsumeResetError["reason"], detail: string) =>
  new ProviderQuotaConsumeResetError({ reason, detail });

const mapConsumeError = (error: ProviderQuotaAdapterError): ProviderQuotaConsumeResetError => {
  switch (error.reason) {
    case "authRequired":
      return safeConsumeError("authRequired", "Sign in to the provider before consuming a reset.");
    case "unsupported":
      return safeConsumeError("unsupported", "This provider does not support banked quota resets.");
    case "timeout":
    case "providerFailed":
      return safeConsumeError("providerFailed", "The provider could not consume the banked reset.");
  }
};

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const cache = new Map<ProviderInstanceId, CacheEntry>();
  const cacheMutex = yield* Semaphore.make(1);

  const invalidate = Effect.fn("ProviderQuotaService.invalidate")(function* (
    instanceId?: ProviderInstanceId,
  ) {
    yield* cacheMutex.withPermits(1)(
      Effect.sync(() => {
        const ids = instanceId === undefined ? Array.from(cache.keys()) : [instanceId];
        for (const id of ids) {
          const entry = cache.get(id);
          if (entry === undefined) continue;
          cache.set(id, {
            instance: entry.instance,
            revision: entry.revision,
            ...(entry.lastSuccess ? { lastSuccess: entry.lastSuccess } : {}),
          });
        }
      }),
    );
  });

  const readCached = Effect.fn("ProviderQuotaService.readCached")(function* (
    instance: ProviderInstance,
    revision: number | null,
    readAt: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const selection = yield* cacheMutex.withPermits(1)(
      Effect.gen(function* (): Effect.fn.Return<CacheSelection> {
        const existing = cache.get(instance.instanceId);
        const sameIdentity = existing?.instance === instance;
        const sameRevision = sameIdentity && existing.revision === revision;

        if (
          sameRevision &&
          existing.snapshot !== undefined &&
          existing.cachedAtMs !== undefined &&
          now - existing.cachedAtMs < CACHE_TTL_MS
        ) {
          return { _tag: "cached", snapshot: existing.snapshot };
        }
        if (sameRevision && existing.inFlight !== undefined) {
          return { _tag: "waiting", deferred: existing.inFlight };
        }

        const deferred = yield* Deferred.make<ProviderQuotaSnapshot>();
        const previous = sameIdentity ? existing?.lastSuccess : undefined;
        cache.set(instance.instanceId, {
          instance,
          revision,
          ...(previous ? { lastSuccess: previous } : {}),
          inFlight: deferred,
        });
        return { _tag: "owner", deferred, ...(previous ? { previous } : {}) };
      }),
    );

    if (selection._tag === "cached") return selection.snapshot;
    if (selection._tag === "waiting") return yield* Deferred.await(selection.deferred);

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
            Effect.catchCause(() =>
              Effect.succeed(
                errorProviderQuotaSnapshot(
                  instance,
                  readAt,
                  new ProviderQuotaAdapterError({
                    reason: "providerFailed",
                    detail: "The provider quota read failed.",
                  }),
                  selection.previous,
                ),
              ),
            ),
          );

    const completedAtMs = yield* Clock.currentTimeMillis;
    yield* cacheMutex.withPermits(1)(
      Effect.sync(() => {
        const current = cache.get(instance.instanceId);
        if (
          current?.instance !== instance ||
          current.revision !== revision ||
          current.inFlight !== selection.deferred
        ) {
          return;
        }
        const lastSuccess =
          refreshed.lastSuccessfulReadAt !== null ? refreshed : current.lastSuccess;
        cache.set(instance.instanceId, {
          instance,
          revision,
          snapshot: refreshed,
          cachedAtMs: completedAtMs,
          ...(lastSuccess ? { lastSuccess } : {}),
        });
      }),
    );
    yield* Deferred.succeed(selection.deferred, refreshed);
    return refreshed;
  });

  const readSummary = Effect.fn("ProviderQuotaService.readSummary")(function* () {
    const instances = yield* registry.listInstances.pipe(
      Effect.catchCause(() =>
        Effect.fail(
          new ProviderQuotaReadError({
            reason: "registryUnavailable",
            detail: "Provider instances could not be listed.",
          }),
        ),
      ),
    );
    const enabled = instances.filter((instance) => instance.enabled);
    const enabledIdentities = new Map(enabled.map((instance) => [instance.instanceId, instance]));
    yield* cacheMutex.withPermits(1)(
      Effect.sync(() => {
        for (const [id, entry] of cache) {
          if (enabledIdentities.get(id) !== entry.instance) cache.delete(id);
        }
      }),
    );

    const readAt = DateTime.formatIso(yield* DateTime.now);
    const snapshots = yield* Effect.forEach(
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

    return { readAt, instances: snapshots } satisfies ProviderQuotaSummary;
  });

  const consumeBankedReset = Effect.fn("ProviderQuotaService.consumeBankedReset")(function* (
    input: ProviderQuotaConsumeResetInput,
  ) {
    const instance = yield* registry
      .getInstance(input.instanceId)
      .pipe(
        Effect.catchCause(() =>
          Effect.fail(
            safeConsumeError("providerFailed", "The provider instance could not be read."),
          ),
        ),
      );
    if (instance === undefined) {
      return yield* safeConsumeError("instanceMissing", "The provider instance does not exist.");
    }
    if (!instance.enabled) {
      return yield* safeConsumeError("instanceDisabled", "The provider instance is disabled.");
    }
    const consume = instance.quota?.consumeBankedReset;
    if (consume === undefined) {
      return yield* safeConsumeError(
        "unsupported",
        "This provider does not support banked quota resets.",
      );
    }

    return yield* consume({ creditId: input.creditId, idempotencyKey: input.idempotencyKey }).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.findErrorOption(cause);
        return Effect.fail(
          Option.isSome(error)
            ? mapConsumeError(error.value)
            : safeConsumeError(
                "providerFailed",
                "The provider could not consume the banked reset.",
              ),
        );
      }),
      Effect.ensuring(invalidate(instance.instanceId)),
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
        safeConsumeError("unsupported", "This provider does not support banked quota resets."),
      ),
    invalidate: () => Effect.void,
    ...overrides,
  });
