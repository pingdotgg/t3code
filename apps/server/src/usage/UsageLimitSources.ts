import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
  type UsageLimitSourceConfig,
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
import { isClaudeModelScopedWindow } from "../provider/claudeUsageLimits.ts";
import * as Settings from "../serverSettings.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly read: (
      sourceIds: ReadonlySet<string>,
    ) => Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
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

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt } as const;
    if (config.managementKey.length === 0) {
      return { ...base, accounts: [], error: "No management key configured." };
    }
    const accounts = yield* api.readAccounts(config).pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    return { ...base, accounts: accounts.success };
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
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    yield* publish(snapshots);
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  // Targeted reads do not publish, so unrelated refreshes and redemptions keep cache ownership.
  const read = Effect.fn("UsageLimitSources.read")(function* (sourceIds: ReadonlySet<string>) {
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    const entries = Object.entries(
      settings._tag === "Some" ? settings.value.usageLimitSources : {},
    ).filter(([id, config]) => sourceIds.has(id) && config.enabled);
    return yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
  });

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
    Stream.runForEach(() => refresh),
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
    read,
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

/**
 * A hub answers for a 429 only when every account it pools for the driver is spent;
 * the pool recovers when its first account does.
 */
export function hubPoolResetAt(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  driver: ProviderDriverKind,
  nowMs: number,
): string | null {
  let earliest: number | null = null;
  for (const account of sources.flatMap((source) => source.accounts)) {
    if (account.driver !== driver) continue;
    const windows = account.usageLimits.windows.filter(
      (window) => !isClaudeModelScopedWindow(window),
    );
    const exhausted = windows.filter((window) => window.usedPercent >= 100);
    if (exhausted.length === 0) {
      if (windows.length > 0) return null;
      continue;
    }
    const resets = exhausted.map((window) => Date.parse(window.resetsAt ?? ""));
    if (resets.some((reset) => !Number.isFinite(reset))) continue;
    const recoversAt = Math.max(...resets);
    if (recoversAt <= nowMs) return null;
    earliest = earliest === null ? recoversAt : Math.min(earliest, recoversAt);
  }
  return earliest === null ? null : DateTime.formatIso(DateTime.makeUnsafe(earliest));
}

/** CLIProxyAPI serves agents and management on one address, so an instance uses the hubs it names. */
export function instanceHubIds(
  settings: Pick<ServerSettings, "providerInstances" | "usageLimitSources">,
  instanceId: ProviderInstanceId,
): ReadonlySet<string> {
  const instance = settings.providerInstances[instanceId];
  if (!instance) return new Set();
  const origins = new Set(
    (
      JSON.stringify([instance.environment ?? [], instance.config ?? null]).match(
        /https?:\/\/[^\s"'\\]+/gi,
      ) ?? []
    ).flatMap((url) => (URL.canParse(url) ? [new URL(url).origin] : [])),
  );
  return new Set(
    Object.entries(settings.usageLimitSources).flatMap(([id, config]) =>
      config.enabled && URL.canParse(config.url) && origins.has(new URL(config.url).origin)
        ? [id]
        : [],
    ),
  );
}

/** Supplies a reset time for usage limits a provider reports without one. */
export class UsageLimitResetFallback extends Context.Reference<{
  readonly resetAt: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
  }) => Effect.Effect<string | null>;
}>("t3/usage/UsageLimitResetFallback", {
  defaultValue: () => ({ resetAt: () => Effect.succeed(null) }),
}) {}

export const layerResetFallback = Layer.effect(
  UsageLimitResetFallback,
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources;
    const settingsService = yield* Settings.ServerSettingsService;
    return {
      resetAt: Effect.fn("UsageLimitResetFallback.resetAt")(function* (input: {
        readonly instanceId: ProviderInstanceId;
        readonly driver: ProviderDriverKind;
      }) {
        const settings = yield* settingsService.getSettings.pipe(Effect.option);
        if (settings._tag === "None") return null;
        const hubIds = instanceHubIds(settings.value, input.instanceId);
        if (hubIds.size === 0) return null;
        // The terminal waits on this read, so a slow hub falls back to its last snapshot.
        const refreshed = yield* sources.read(hubIds).pipe(Effect.timeoutOption("5 seconds"));
        const snapshots = refreshed._tag === "Some" ? refreshed.value : yield* sources.current;
        const now = yield* DateTime.now;
        return hubPoolResetAt(
          snapshots.filter((source) => hubIds.has(source.id)),
          input.driver,
          DateTime.toEpochMillis(now),
        );
      }),
    };
  }),
);
