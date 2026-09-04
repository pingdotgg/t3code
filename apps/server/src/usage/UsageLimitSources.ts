/**
 * UsageLimitSources — quota from places this environment cannot run turns
 * on, today a CLIProxyAPI hub pooling several subscription accounts.
 *
 * Each configured `settings.usageLimitSources` entry is polled on the
 * provider health-check interval and on every settings change, then
 * published as one snapshot per source over `subscribeServerConfig`. A source
 * that fails keeps its row with `error` set so the user can see it is
 * configured but unreachable. Nothing is persisted: like provider status,
 * this is live state that re-derives on boot.
 *
 * @module usage/UsageLimitSources
 */
import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerSettings,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { cliproxyStatusToAccounts, decodeCliproxyQuotaStatus } from "./cliproxyUsageLimits.ts";

const FETCH_TIMEOUT = "10 seconds";
const QUOTA_STATUS_PATH = "/v0/management/quota-scheduler/status";

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    /** The current set followed by every change, with repeats dropped. */
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    /** Re-read every source now. Never fails; failures land on the snapshot. */
    readonly refresh: Effect.Effect<void>;
  }
>()("t3/usage/UsageLimitSources") {}

/**
 * A bounded, client-safe reason for a failed hub read. The exact failure
 * (which can carry the request URL and response body) goes to the log.
 */
function readFailureMessage(
  error: HttpClientError.HttpClientError | Schema.SchemaError | Cause.TimeoutError | InvalidUrl,
): string {
  switch (error._tag) {
    case "InvalidUrl":
      return "The hub URL is not valid.";
    case "TimeoutError":
      return "The hub did not answer in time.";
    case "SchemaError":
      return "The hub answered with an unexpected shape.";
    case "HttpClientError":
      return error.reason._tag === "StatusCodeError"
        ? `The hub refused the request (HTTP ${error.reason.response.status}).`
        : "The hub could not be reached.";
  }
}

class InvalidUrl extends Data.TaggedError("InvalidUrl")<{
  readonly url: string;
  readonly cause: unknown;
}> {}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  try {
    return new URL(config.url).host;
  } catch {
    return id;
  }
}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const settingsService = yield* ServerSettingsService;
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
    const accounts = yield* Effect.try({
      try: () => new URL(QUOTA_STATUS_PATH, config.url).toString(),
      catch: (cause) => new InvalidUrl({ url: config.url, cause }),
    }).pipe(
      Effect.flatMap((url) =>
        httpClient.get(url, { headers: { Authorization: `Bearer ${config.managementKey}` } }),
      ),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeCliproxyQuotaStatus),
      Effect.map((status) => cliproxyStatusToAccounts(status, checkedAt)),
      Effect.timeout(FETCH_TIMEOUT),
      Effect.result,
    );
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: readFailureMessage(accounts.failure) };
    }
    return { ...base, accounts: accounts.success };
  });

  const publish = (next: ReadonlyArray<UsageLimitSourceSnapshot>) =>
    Effect.gen(function* () {
      const changed = yield* Ref.modify(stateRef, (previous) =>
        Equal.equals(previous, next) ? [false, previous] : [true, next],
      );
      if (changed) yield* PubSub.publish(changes, next);
    });

  // One refresh at a time: a slow hub read started before a settings change
  // must not publish after the change's own refresh and resurrect a removed
  // source. Callers queue behind the in-flight run and see current settings.
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

  // Settings edits re-read straight away so a new hub shows up without
  // waiting for the interval, and a removed one leaves the list.
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
      Effect.flatMap((wait) =>
        Effect.sleep(Duration.toMillis(Duration.fromInputUnsafe(wait)) <= 0 ? "60 seconds" : wait),
      ),
      Effect.andThen(backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
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
