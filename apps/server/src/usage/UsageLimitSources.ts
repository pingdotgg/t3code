import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ProviderDriverKind,
  type ServerSettings,
  UsageLimitSourceConfig,
  settingsSecretLiteral,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceAccount,
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
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";
import { windowLimitsModel } from "../provider/claudeUsageLimits.ts";
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

const ROUTE_READ_INTERVAL = Duration.seconds(30);
const MAX_ROUTES_PER_SOURCE = 200;

interface SessionRoute {
  readonly accountId: string;
  readonly endpoint: string | undefined;
  readonly identity: string;
}

function routeIdentity(account: UsageLimitSourceAccount): string {
  const fingerprint = account.usageLimits.credentialFingerprint;
  // Without a listed login or fingerprint, a route cannot survive another account reading.
  return JSON.stringify([
    account.driver,
    account.email,
    account.workspaceId,
    fingerprint,
    account.email || account.workspaceId || fingerprint ? null : account.usageLimits.checkedAt,
  ]);
}

function withSessionIds(
  snapshots: ReadonlyArray<UsageLimitSourceSnapshot>,
  routes: ReadonlyMap<UsageLimitSourceId, ReadonlyMap<string, SessionRoute>>,
): ReadonlyArray<UsageLimitSourceSnapshot> {
  return snapshots.map((source) => {
    const sessionIdsByAccount = new Map<string, string[]>();
    for (const [sessionId, route] of routes.get(source.id) ?? []) {
      const account = source.accounts.find((account) => account.id === route.accountId);
      if (
        !account ||
        source.endpoint !== route.endpoint ||
        routeIdentity(account) !== route.identity
      )
        continue;
      const accountId = route.accountId;
      const sessionIds = sessionIdsByAccount.get(accountId);
      if (sessionIds) sessionIds.push(sessionId);
      else sessionIdsByAccount.set(accountId, [sessionId]);
    }
    if (sessionIdsByAccount.size === 0) return source;
    return {
      ...source,
      accounts: source.accounts.map((account) => {
        const sessionIds = sessionIdsByAccount.get(account.id);
        return sessionIds ? { ...account, sessionIds } : account;
      }),
    };
  });
}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

/**
 * A refused read of one account keeps its last good reading, as provider probes keep their bars
 * (see ServerProviderUsageLimits); a reading with none to keep stays listed as unreadable.
 */
function keepLastGoodReadings(
  previous: ReadonlyArray<UsageLimitSourceSnapshot>,
  next: ReadonlyArray<UsageLimitSourceSnapshot>,
): ReadonlyArray<UsageLimitSourceSnapshot> {
  return next.map((source) => {
    // Auth file names can be reused, so only the same hub and login may lend a reading.
    const before = previous.find(
      (candidate) => candidate.id === source.id && candidate.endpoint === source.endpoint,
    );
    if (!before) return source;
    return {
      ...source,
      accounts: source.accounts.map((account) => {
        if (account.usageLimits.unavailable?.reason !== "probeFailed") return account;
        // Without a listed login, a reused auth file name cannot be told apart from the old one.
        if (account.email === undefined && account.workspaceId === undefined) return account;
        const last = before.accounts.find(
          (candidate) =>
            candidate.id === account.id &&
            candidate.driver === account.driver &&
            // Fingerprinted Antigravity readings omit the listed identity, so they are never lent.
            candidate.usageLimits.credentialFingerprint === undefined &&
            candidate.email === account.email &&
            candidate.workspaceId === account.workspaceId,
        );
        return last && !last.usageLimits.unavailable ? last : account;
      }),
    };
  });
}

function missingManagementKey(config: UsageLimitSourceConfig): string {
  return typeof config.managementKey === "string"
    ? "No management key configured."
    : "Could not read the management key from its secret provider.";
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const readsRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  // Per source, provider session id to hub account id, oldest route first.
  const routesRef = yield* Ref.make<
    ReadonlyMap<UsageLimitSourceId, ReadonlyMap<string, SessionRoute>>
  >(new Map());
  const readManagementKey = Effect.fn("UsageLimitSources.readManagementKey")(function* (
    config: UsageLimitSourceConfig,
  ) {
    const resolved = yield* resolveSettingsSecrets(secrets, UsageLimitSourceConfig, config);
    return settingsSecretLiteral(resolved.managementKey);
  });
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
    const url = URL.parse(config.url);
    const base = {
      id,
      kind: config.kind,
      label: sourceLabel(id, config),
      ...(url && /^https?:$/.test(url.protocol)
        ? {
            origin: url.origin,
            endpoint: `${url.origin}${url.pathname.replace(/(\/management\.html)?\/*$/i, "")}`,
          }
        : {}),
      checkedAt,
    } as const;
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return { ...base, accounts: [], error: missingManagementKey(config) };
    }
    const accounts = yield* api
      .readAccounts({ url: config.url, managementKey })
      .pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    return { ...base, accounts: accounts.success };
  });

  // Its own lock, so a route read never waits on a slow quota refresh yet never publishes stale reads.
  const publishLock = yield* Semaphore.make(1);
  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    reads: ReadonlyArray<UsageLimitSourceSnapshot> | undefined,
  ) {
    if (reads) yield* Ref.set(readsRef, reads);
    // Current settings, so no publish names routes for a hub switched out of Thread accounts,
    // even when a queue read started before the switch lands after it.
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const routes = new Map(
      [...(yield* Ref.get(routesRef))].filter(
        ([id]) => settings?.usageLimitSources[id]?.threadAccounts,
      ),
    );
    const next = withSessionIds(yield* Ref.get(readsRef), routes);
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  }, publishLock.withPermits(1));

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
    yield* publish(keepLastGoodReadings(yield* Ref.get(readsRef), snapshots));
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = Effect.fn("UsageLimitSources.consumeResetCredit")(function* (
    input: UsageLimitSourceConsumeResetCreditInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const config = settings.usageLimitSources[input.sourceId];
    if (!config?.enabled) {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return yield* new UsageLimitSourceError({ detail: missingManagementKey(config) });
    }
    const result = yield* api.consume(
      { url: config.url, managementKey },
      input.accountId,
      input.creditId,
    );
    // A redemption changes the reading, so a refused re-read must not bring back the one before it.
    const snapshot = yield* readSource(input.sourceId, config);
    const previous = yield* Ref.get(readsRef);
    yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
    return result;
  }, refreshLock.withPermits(1));

  // Opted-in hubs only; a failed read keeps the routes already known for that hub.
  const readRoutes = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled && config.threadAccounts,
    );
    const snapshots = yield* Ref.get(readsRef);
    const reads = yield* Effect.forEach(
      entries,
      ([id, config]) =>
        readManagementKey(config).pipe(
          Effect.flatMap((managementKey) =>
            managementKey.length > 0
              ? api.readSessionAccounts({ url: config.url, managementKey })
              : Effect.succeed([]),
          ),
          Effect.orElseSucceed(() => []),
          Effect.map((routes) => [id as UsageLimitSourceId, routes] as const),
        ),
      { concurrency: 4 },
    );
    yield* Ref.update(routesRef, (previous) => {
      const next = new Map<UsageLimitSourceId, ReadonlyMap<string, SessionRoute>>();
      for (const [id, routes] of reads) {
        const routed = new Map(previous.get(id));
        const source = snapshots.find((source) => source.id === id);
        for (const { sessionId, accountId, driver, email, workspaceId } of routes) {
          routed.delete(sessionId);
          const account = source?.accounts.find((account) => account.id === accountId);
          if (
            !source ||
            !account ||
            account.driver !== driver ||
            account.email !== email ||
            account.workspaceId !== workspaceId
          )
            continue;
          routed.set(sessionId, {
            accountId: account.id,
            endpoint: source.endpoint,
            identity: routeIdentity(account),
          });
        }
        next.set(id, new Map([...routed].slice(-MAX_ROUTES_PER_SOURCE)));
      }
      return next;
    });
    yield* publish(undefined);
  }).pipe(Effect.ignoreCause({ log: true }));

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

  // CLIProxyAPI keeps queued usage for 60 seconds by default. Not gated on client activity:
  // a turn that ends while no client is open would otherwise lose its route for good.
  yield* Effect.forever(Effect.sleep(ROUTE_READ_INTERVAL).pipe(Effect.andThen(readRoutes))).pipe(
    Effect.forkScoped,
  );

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

export const layer = Layer.effect(UsageLimitSources, make).pipe(
  Layer.provide(SecretResolverLayer.layer),
);

/** A hub answers with a usage limit only when every account it routes the driver to is spent. */
export function hubPoolResetAt(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  driver: ProviderDriverKind,
  model: string | null,
  now: number,
): string | null {
  let earliest: number | null = null;
  for (const source of sources) {
    for (const account of source.accounts) {
      if (account.driver !== driver) continue;
      // An unread account may be the one still blocked, so its refill is unknown.
      if (account.usageLimits.unavailable) return null;
      const spent = account.usageLimits.windows.filter(
        (window) => window.usedPercent >= 100 && windowLimitsModel(window, model),
      );
      if (spent.length === 0) return null;
      const resets = spent.map((window) => Date.parse(window.resetsAt ?? ""));
      if (resets.some((reset) => !Number.isFinite(reset))) return null;
      const recoversAt = Math.max(...resets);
      if (recoversAt <= now) return null;
      earliest = earliest === null ? recoversAt : Math.min(earliest, recoversAt);
    }
  }
  return earliest === null ? null : DateTime.formatIso(DateTime.makeUnsafe(earliest));
}

export class UsageLimitResetFallback extends Context.Reference<{
  readonly resetAt: (
    driver: ProviderDriverKind,
    endpoint: string,
    model: string | null,
  ) => Effect.Effect<string | null>;
}>("t3/usage/UsageLimitResetFallback", {
  defaultValue: () => ({ resetAt: () => Effect.succeed(null) }),
}) {}

export const layerResetFallback = Layer.effect(
  UsageLimitResetFallback,
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources;
    return {
      resetAt: Effect.fn("UsageLimitResetFallback.resetAt")(function* (driver, endpoint, model) {
        // Only the hub at the instance's endpoint serves its turns.
        const atEndpoint = Effect.map(sources.current, (current) =>
          current.filter((source) => source.origin === endpoint),
        );
        if ((yield* atEndpoint).length === 0) return null;
        // The pool usually ran out after the last poll, so the cached accounts still show room.
        yield* sources.refresh.pipe(Effect.timeout("5 seconds"), Effect.ignore);
        return hubPoolResetAt(
          yield* atEndpoint,
          driver,
          model,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
      }),
    };
  }),
);
