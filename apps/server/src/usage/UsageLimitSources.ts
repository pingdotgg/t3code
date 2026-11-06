import {
  resolveUsageLimitsAfterProbe,
  UsageProviderFilter,
} from "@t3tools/provider-core/server/usageLimits";
import {
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ServerSettings,
  UsageLimitSourceConfig,
  settingsSecretLiteral,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";
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

  const sourceCacheKey = (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
    managementKey: string,
  ) => `${id}\0${config.url}\0${managementKey}`;
  const lastGoodSources = new Map<
    string,
    readonly UsageLimitSourceSnapshot["accounts"][number][]
  >();
  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt } as const;
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return { ...base, accounts: [], error: missingManagementKey(config) };
    }
    const accountKey = sourceCacheKey(id, config, managementKey);
    const providers = yield* UsageProviderFilter;
    const accounts = yield* api
      .readAccounts({ url: config.url, managementKey }, providers)
      .pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      const refreshAfter = DateTime.toEpochMillis(yield* DateTime.now) + 5 * 60_000;
      const retained = (lastGoodSources.get(accountKey) ?? []).map((account) => ({
        ...account,
        usageLimits: {
          ...account.usageLimits,
          stale: true,
          refreshAfter: Math.max(refreshAfter, account.usageLimits.refreshAfter ?? 0),
        },
      }));
      lastGoodSources.set(accountKey, retained);
      return { ...base, accounts: retained, error: accounts.failure.detail };
    }
    const retained =
      providers === undefined
        ? []
        : (lastGoodSources.get(accountKey) ?? []).filter(
            (account) => !providers.includes(account.driver),
          );
    const previous = lastGoodSources.get(accountKey) ?? [];
    const merged = [
      ...retained,
      ...accounts.success.map((account) => ({
        ...account,
        usageLimits:
          resolveUsageLimitsAfterProbe({
            published: previous.find(
              (prior) => prior.id === account.id && prior.driver === account.driver,
            )?.usageLimits,
            probed: account.usageLimits,
          }) ?? account.usageLimits,
      })),
    ];
    lastGoodSources.set(accountKey, merged);
    return { ...base, accounts: merged };
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    next: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    // Hub routing fingerprints identify local retention ownership, not a shared credential.
    const snapshots = next.map((source) => ({
      ...source,
      accounts: source.accounts.map((account) => {
        const { credentialFingerprint: _credentialFingerprint, ...usageLimits } =
          account.usageLimits;
        return { ...account, usageLimits };
      }),
    }));
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, snapshots) ? [false, previous] : [true, snapshots],
    );
    if (changed) yield* PubSub.publish(changes, snapshots);
  });

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer refreshes.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const providers = yield* UsageProviderFilter;
    if (
      providers !== undefined &&
      !providers.some((driver) => driver === "codex" || driver === "claudeAgent")
    )
      return;
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
    if (
      result.outcome === "reset" ||
      result.outcome === "alreadyRedeemed" ||
      result.outcome === "noCredit"
    ) {
      const cacheKey = sourceCacheKey(input.sourceId, config, managementKey);
      const retained = lastGoodSources.get(cacheKey);
      if (retained)
        lastGoodSources.set(
          cacheKey,
          retained.map((account) => {
            if (account.id !== input.accountId || account.driver !== "codex") return account;
            const { resetCredits: _resetCredits, ...usageLimits } = account.usageLimits;
            return { ...account, usageLimits };
          }),
        );
    }
    const snapshot = yield* readSource(input.sourceId, config);
    const previous = yield* Ref.get(stateRef);
    yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
    return result;
  }, refreshLock.withPermits(1));

  yield* refresh.pipe(Effect.forkScoped);
  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

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
