import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type UsageLimitSourceConfig,
  type UsageLimitSourceAccount,
  type ServerProviderUsageLimits,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as Settings from "../serverSettings.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
  }
>()("t3/usage/UsageLimitSources") {}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

function failedLimits(
  limits: ServerProviderUsageLimits,
  message: string,
): ServerProviderUsageLimits {
  return { ...limits, resetCredits: undefined, unavailable: { reason: "probeFailed", message } };
}

function sameSourceConfig(left: UsageLimitSourceConfig, right: UsageLimitSourceConfig): boolean {
  return (
    left.kind === right.kind &&
    left.url === right.url &&
    left.label === right.label &&
    left.enabled === right.enabled &&
    left.managementKey === right.managementKey
  );
}

function sameAccount(left: UsageLimitSourceAccount, right: UsageLimitSourceAccount): boolean {
  return (
    left.id === right.id &&
    left.driver === right.driver &&
    left.email === right.email &&
    left.workspaceId === right.workspaceId &&
    left.usageLimits.credentialFingerprint === right.usageLimits.credentialFingerprint
  );
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const settingsService = yield* Settings.ServerSettingsService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  // Only current source configurations and their latest account list are retained.
  // Credentials participate in equality but never leave this service's memory.
  const cache = new Map<
    UsageLimitSourceId,
    {
      config: UsageLimitSourceConfig;
      snapshot: UsageLimitSourceSnapshot;
    }
  >();

  let configRevision = 0;
  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const revision = configRevision;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt } as const;
    const cached = cache.get(id);
    const previous =
      cached && sameSourceConfig(cached.config, config) ? cached.snapshot : undefined;
    const read =
      config.managementKey.length === 0
        ? Effect.fail(new UsageLimitSourceError({ detail: "No management key configured." }))
        : api.readAccounts(config);
    const accounts = yield* read.pipe(Effect.result);
    let snapshot: UsageLimitSourceSnapshot;
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      snapshot = {
        ...base,
        accounts: (previous?.accounts ?? []).map((account) => ({
          ...account,
          usageLimits: failedLimits(
            account.usageLimits,
            "The hub could not refresh this account's usage.",
          ),
        })),
        error: accounts.failure.detail,
      };
    } else {
      snapshot = {
        ...base,
        accounts: accounts.success.map((account) => {
          if (account.usageLimits.unavailable?.reason !== "probeFailed") return account;
          const good = previous?.accounts.find(
            (old) =>
              sameAccount(old, account) &&
              old.usageLimits.windows.length > 0 &&
              old.usageLimits.unavailable?.reason !== "unsupported",
          );
          return {
            ...account,
            ...(good?.plan ? { plan: good.plan } : {}),
            usageLimits: failedLimits(
              good?.usageLimits ?? account.usageLimits,
              account.usageLimits.unavailable.message ??
                "The hub could not read this account's usage.",
            ),
          };
        }),
      };
    }
    if (revision === configRevision) cache.set(id, { config: { ...config }, snapshot });
    return snapshot;
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    next: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer refreshes.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const entries = Object.entries(settings.usageLimitSources).filter(
      ([, config]) => config.enabled,
    );
    for (const id of cache.keys()) {
      if (!entries.some(([currentId]) => currentId === id)) cache.delete(id);
    }
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    yield* publish(snapshots);
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = Effect.fn("UsageLimitSources.consumeResetCredit")(function* (
    input: UsageLimitSourceConsumeResetCreditInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const config = settings.usageLimitSources[input.sourceId];
    if (!config?.enabled || !config.managementKey) {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    const result = yield* api.consume(config, input.accountId, input.creditId);
    const snapshot = yield* readSource(input.sourceId, config);
    const previous = yield* Ref.get(stateRef);
    yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
    return result;
  }, refreshLock.withPermits(1));

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach((configs) =>
      Effect.gen(function* () {
        configRevision++;
        for (const [id, cached] of cache) {
          const config = configs[id];
          if (!config?.enabled || !sameSourceConfig(cached.config, config)) cache.delete(id);
        }
        yield* refresh.pipe(Effect.forkScoped);
      }),
    ),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(interval),
      Effect.flatMap((current) =>
        Duration.isPositive(current)
          ? backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })
          : Effect.succeed(false),
      ),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    consumeResetCredit,
    refresh,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make);
