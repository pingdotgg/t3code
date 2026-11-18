/**
 * Quota from places this environment cannot run turns on, polled per configured source and
 * published over `subscribeServerConfig`; a watched modelproxy follows its status stream instead.
 * Nothing is persisted except a modelproxy sign-in session, which survives a restart.
 */
import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  UsageLimitSourceError,
  type UsageLimitSourceAccountLoginInput,
  type UsageLimitSourceAccountLoginResult,
  type UsageLimitSourceAuthInput,
  type UsageLimitSourceAuthState,
  type UsageLimitSourceConsumeResetCreditInput,
  CliproxyUsageLimitSourceConfig,
  type ModelproxyUsageLimitSourceConfig,
  type ProviderConsumeResetCreditOutcome,
  type ProviderConsumeResetCreditResult,
  type ServerSettings,
  type UsageLimitSourceConfig,
  settingsSecretLiteral,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@lathe/contracts";
import { resolveServerBackgroundActivitySettings } from "@lathe/shared/backgroundActivitySettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as SecretResolver from "@lathe/secret-provider-core/server/SecretResolver";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";
import { makeModelproxyAccountLogin } from "./modelproxyAccountLogin.ts";
import { makeModelproxyApi, mapModelproxyStatus, type ModelproxyStatus } from "./modelproxyApi.ts";
import { makeModelproxyAuth } from "./modelproxyAuth.ts";

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    /**
     * Fork: holds the gateways' status streams open for as long as the scope
     * lives, so their snapshots follow every change instead of the interval.
     */
    readonly watch: Effect.Effect<void, never, Scope.Scope>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
    /** Sign a modelproxy source in or out; the snapshot follows through the stream. */
    readonly auth: (
      input: UsageLimitSourceAuthInput,
    ) => Effect.Effect<UsageLimitSourceAuthState, UsageLimitSourceError>;
    /** Fork: log a gateway's pooled account in again (modelproxyAccountLogin.ts). */
    readonly accountLogin: (
      input: UsageLimitSourceAccountLoginInput,
    ) => Effect.Effect<UsageLimitSourceAccountLoginResult, UsageLimitSourceError>;
  }
>()("lathe/usage/UsageLimitSources") {}

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
 * A gateway Lathe cannot read right now still serves its routed models, and a
 * routed model that left the picker would reset every thread that selected
 * it. A failed read therefore keeps the last routes the gateway published;
 * only removing or disabling the source takes them away.
 */
function keepGatewayRoutes(
  snapshot: UsageLimitSourceSnapshot,
  previous: ReadonlyArray<UsageLimitSourceSnapshot>,
): UsageLimitSourceSnapshot {
  if (snapshot.kind !== "modelproxy" || snapshot.error === undefined || !snapshot.proxy) {
    return snapshot;
  }
  const routes = previous.find((source) => source.id === snapshot.id)?.proxy?.routes;
  return routes ? { ...snapshot, proxy: { ...snapshot.proxy, routes } } : snapshot;
}

/** One source's read, flagged when its failure may clear on its own. */
interface SourceRead {
  readonly snapshot: UsageLimitSourceSnapshot;
  readonly transient?: true;
}

/** How long a transient failure waits before its one retry. */
const RETRY_AFTER = Duration.seconds(3);

/** How soon a watched gateway's stream is reopened after the gateway closes it. */
const FOLLOW_RECONNECT = Duration.seconds(1);
/** The longest pause between attempts to reopen a failing stream. */
const FOLLOW_BACKOFF_CAP = Duration.seconds(30);
/** The most often one watched gateway's status is published to clients. */
const LIVE_PUBLISH_INTERVAL = Duration.seconds(2);
/** How often a watched gateway without the status stream is read instead. */
const UNSUPPORTED_READ_INTERVAL = Duration.seconds(5);

/**
 * A transient failure within two polling intervals of a good read keeps that read, so one
 * missed poll (a laptop waking before its network) is not an outage. The kept snapshot keeps
 * its own `checkedAt`, so it never claims to be newer than it is.
 */
function settleRead(
  read: SourceRead,
  previous: ReadonlyArray<UsageLimitSourceSnapshot>,
  input: { readonly nowMs: number; readonly intervalMs: number },
): UsageLimitSourceSnapshot {
  const last = previous.find((source) => source.id === read.snapshot.id);
  if (
    read.transient &&
    last !== undefined &&
    last.kind === read.snapshot.kind &&
    last.error === undefined &&
    input.nowMs - Date.parse(last.checkedAt) < 2 * input.intervalMs
  ) {
    return last;
  }
  return keepGatewayRoutes(read.snapshot, previous);
}

function missingManagementKey(config: CliproxyUsageLimitSourceConfig): string {
  return typeof config.managementKey === "string"
    ? "No management key configured."
    : "Could not read the management key from its secret provider.";
}

const GATEWAY_REDEEM_OUTCOMES: Record<string, ProviderConsumeResetCreditOutcome> = {
  reset: "reset",
  nothingToReset: "nothingToReset",
  noCredit: "noCredit",
  alreadyRedeemed: "alreadyRedeemed",
};
const GATEWAY_REDEEM_REFUSALS: Record<string, string> = {
  coolingDown: "Resets on this account are cooling down. Try again later.",
  rateLimited: "The provider is rate limiting resets. Try again soon.",
  signedOut: "The account must log in again on the gateway before it can redeem resets.",
  unconfirmed:
    "The provider could not confirm the reset. If the account is still limited in a moment, try again.",
};

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const modelproxy = yield* makeModelproxyApi;
  const modelproxyAuth = yield* makeModelproxyAuth;
  // Fork: one request id per account and kind until the gateway gives a
  // settled answer, so a retry after "unconfirmed" or a dropped connection
  // cannot spend a second credit.
  const pendingRedeems = yield* Ref.make(new Map<string, string>());
  const random = yield* SecureRandom.SecureRandom;
  const accountLogins = yield* makeModelproxyAccountLogin;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const readManagementKey = Effect.fn("UsageLimitSources.readManagementKey")(function* (
    config: CliproxyUsageLimitSourceConfig,
  ) {
    const resolved = yield* resolveSettingsSecrets(secrets, CliproxyUsageLimitSourceConfig, config);
    return settingsSecretLiteral(resolved.managementKey);
  });
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const modelproxySnapshot = Effect.fn("UsageLimitSources.modelproxySnapshot")(function* (
    id: UsageLimitSourceId,
    base: Pick<UsageLimitSourceSnapshot, "id" | "kind" | "label" | "checkedAt">,
    auth: UsageLimitSourceAuthState,
    status: ModelproxyStatus,
  ) {
    const mapped = mapModelproxyStatus(status, {
      checkedAt: base.checkedAt,
      nowMs: DateTime.toEpochMillis(yield* DateTime.now),
    });
    const logins = yield* accountLogins.sessions(id);
    return {
      ...base,
      accounts: mapped.accounts,
      proxy: { auth, ...mapped.proxy, ...(logins.length > 0 ? { accountLogins: logins } : {}) },
    } satisfies UsageLimitSourceSnapshot;
  });

  const readModelproxy = Effect.fn("UsageLimitSources.readModelproxy")(function* (
    id: UsageLimitSourceId,
    config: ModelproxyUsageLimitSourceConfig,
    base: Pick<UsageLimitSourceSnapshot, "id" | "kind" | "label" | "checkedAt">,
  ): Effect.fn.Return<SourceRead> {
    const auth = yield* modelproxyAuth.authState(id);
    if (auth.state !== "signedIn") {
      return {
        snapshot: {
          ...base,
          accounts: [],
          error: auth.state === "pending" ? "Sign-in pending." : "Not signed in.",
          proxy: { auth },
        },
      };
    }
    const readWith = (forceRefresh: boolean) =>
      modelproxyAuth
        .accessToken(id, config, { forceRefresh })
        .pipe(Effect.flatMap((token) => modelproxy.readStatus(config.url, token)));
    let status = yield* readWith(false).pipe(Effect.result);
    // The gateway can reject a token its expiry still vouches for (a revoked
    // session, a rotated signing key); a freshly issued one settles it.
    if (
      status._tag === "Failure" &&
      status.failure._tag === "ModelproxyReadError" &&
      status.failure.unauthorized
    ) {
      status = yield* readWith(true).pipe(Effect.result);
    }
    if (status._tag === "Failure") {
      const failure = status.failure;
      if (failure._tag === "ModelproxySessionError") {
        return {
          snapshot: {
            ...base,
            accounts: [],
            error: failure.detail,
            proxy: { auth: yield* modelproxyAuth.authState(id) },
          },
          ...(failure.reason === "refreshFailed" ? { transient: true as const } : {}),
        };
      }
      yield* Effect.logDebug("usage limit source read failed", { id, cause: failure });
      return {
        snapshot: { ...base, accounts: [], error: failure.detail, proxy: { auth } },
        ...(failure.transient ? { transient: true as const } : {}),
      };
    }
    return { snapshot: yield* modelproxySnapshot(id, base, auth, status.success) };
  });

  const readSourceOnce = Effect.fn("UsageLimitSources.readSourceOnce")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ): Effect.fn.Return<SourceRead> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt } as const;
    if (config.kind === "modelproxy") return yield* readModelproxy(id, config, base);
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return { snapshot: { ...base, accounts: [], error: missingManagementKey(config) } };
    }
    const accounts = yield* api
      .readAccounts({ url: config.url, managementKey })
      .pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { snapshot: { ...base, accounts: [], error: accounts.failure.detail } };
    }
    return { snapshot: { ...base, accounts: accounts.success } };
  });

  /** A read whose failure may clear on its own gets one more try after a short pause. */
  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ): Effect.fn.Return<SourceRead> {
    const first = yield* readSourceOnce(id, config);
    if (!first.transient) return first;
    yield* Effect.sleep(RETRY_AFTER);
    return yield* readSourceOnce(id, config);
  });

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  const intervalMs = interval.pipe(
    Effect.map((wait) => Duration.toMillis(Duration.fromInputUnsafe(wait))),
    Effect.map((ms) => (ms <= 0 ? 60_000 : ms)),
  );

  // Fork: gateways whose status stream is open right now. Every publish stamps the mark from
  // this set, so an interval read during the stream keeps it. A plain set, not a Ref, because
  // it is read inside `Ref.modify`, where a change made just before the write is always seen.
  const following = new Set<UsageLimitSourceId>();
  const stampFollowing = (source: UsageLimitSourceSnapshot): UsageLimitSourceSnapshot => {
    if (!source.proxy) return source;
    const live = following.has(source.id) && source.error === undefined;
    if (live === (source.proxy.following === true)) return source;
    const { following: _, ...proxy } = source.proxy;
    return { ...source, proxy: live ? { ...proxy, following: true } : proxy };
  };

  const publishWith = Effect.fn("UsageLimitSources.publish")(function* (
    derive: (
      previous: ReadonlyArray<UsageLimitSourceSnapshot>,
    ) => ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const published = yield* Ref.modify(stateRef, (previous) => {
      const stamped = derive(previous).map(stampFollowing);
      return Equal.equals(previous, stamped) ? [null, previous] : [stamped, stamped];
    });
    if (published) yield* PubSub.publish(changes, published);
  });
  const publish = (next: ReadonlyArray<UsageLimitSourceSnapshot>) => publishWith(() => next);

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer refreshes.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    // A removed or disabled gateway takes its sign-in with it; a session
    // nobody lists must not outlive its client secret in the store.
    const listed = new Set(entries.map(([id]) => id));
    const previous = yield* Ref.get(stateRef);
    yield* Effect.forEach(
      previous.filter((source) => source.kind === "modelproxy" && !listed.has(source.id)),
      (source) => Effect.andThen(modelproxyAuth.forget(source.id), accountLogins.forget(source.id)),
    );
    const reads = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    const settle = {
      nowMs: DateTime.toEpochMillis(yield* DateTime.now),
      intervalMs: yield* intervalMs,
    };
    yield* publish(reads.map((read) => settleRead(read, previous, settle)));
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  const auth = Effect.fn("UsageLimitSources.auth")(function* (input: UsageLimitSourceAuthInput) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () => new UsageLimitSourceError({ detail: "Could not read source settings." }),
      ),
    );
    const config = settings.usageLimitSources[input.sourceId];
    if (!config?.enabled || config.kind !== "modelproxy") {
      return yield* new UsageLimitSourceError({
        detail: "The gateway source is missing or disabled.",
      });
    }
    switch (input.action) {
      case "start":
        return yield* modelproxyAuth.start(input.sourceId, config);
      case "cancel":
        return yield* modelproxyAuth.cancel(input.sourceId);
      case "signOut":
        return yield* modelproxyAuth.signOut(input.sourceId);
    }
  });

  // Every sign-in transition re-reads so the snapshot's auth state and,
  // once signed in, its accounts follow without waiting for the interval.
  yield* modelproxyAuth.changes.pipe(
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  // Fork: an account login's every step re-reads the same way, so the pill
  // shows the panel's next state and, once the login lands, the account back
  // to ready.
  yield* accountLogins.changes.pipe(
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );
  const accountLogin = Effect.fn("UsageLimitSources.accountLogin")(function* (
    input: UsageLimitSourceAccountLoginInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () => new UsageLimitSourceError({ detail: "Could not read source settings." }),
      ),
    );
    const config = settings.usageLimitSources[input.sourceId];
    if (!config?.enabled || config.kind !== "modelproxy") {
      return yield* new UsageLimitSourceError({
        detail: "The gateway source is missing or disabled.",
      });
    }
    return yield* accountLogins.run(input.sourceId, input, {
      baseUrl: config.url,
      token: modelproxyAuth
        .accessToken(input.sourceId, config, { forceRefresh: false })
        .pipe(Effect.mapError((error) => new UsageLimitSourceError({ detail: error.detail }))),
    });
  });

  /**
   * Publishes one source's read the way `refresh` does, so a failed read
   * after a redemption keeps the last good accounts and the gateway's routes.
   * The caller holds the refresh lock.
   */
  const publishRead = Effect.fn("UsageLimitSources.publishRead")(function* (
    id: UsageLimitSourceId,
    read: SourceRead,
  ) {
    const settle = {
      nowMs: DateTime.toEpochMillis(yield* DateTime.now),
      intervalMs: yield* intervalMs,
    };
    yield* publishWith((previous) =>
      previous.map((source) => (source.id === id ? settleRead(read, previous, settle) : source)),
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
    if (config?.enabled && config.kind === "modelproxy") {
      const kind =
        input.creditId === "weekly" || input.creditId === "fable" ? input.creditId : null;
      if (kind === null) {
        return yield* new UsageLimitSourceError({
          detail: "A gateway account redeems weekly or Fable resets only.",
        });
      }
      const key = `${input.sourceId}\u0000${input.accountId}\u0000${kind}`;
      const requestId = (yield* Ref.get(pendingRedeems)).get(key) ?? (yield* random.uuidV4());
      yield* Ref.update(pendingRedeems, (pending) => new Map(pending).set(key, requestId));
      const redeemWith = (forceRefresh: boolean) =>
        modelproxyAuth.accessToken(input.sourceId, config, { forceRefresh }).pipe(
          Effect.flatMap((token) =>
            modelproxy.redeemResetCredit(config.url, token, {
              account: input.accountId,
              kind,
              requestId,
            }),
          ),
        );
      // Only a settled answer releases the id. Everything else (unconfirmed,
      // a refusal, a 502, a dropped connection) keeps it, because an earlier
      // attempt under the same id may have spent the credit, and the gateway
      // binds the id to that credit so a retry can never spend a second one.
      let redeemed = yield* redeemWith(false).pipe(Effect.result);
      // A token its expiry still vouches for can be rejected (a revoked
      // session, a rotated signing key). The gateway refused the request
      // before spending anything, so the same id goes out again with a fresh one.
      if (
        redeemed._tag === "Failure" &&
        redeemed.failure._tag === "ModelproxyReadError" &&
        redeemed.failure.unauthorized
      ) {
        redeemed = yield* redeemWith(true).pipe(Effect.result);
      }
      if (redeemed._tag === "Failure") {
        const failure = redeemed.failure;
        if (failure._tag === "ModelproxyReadError" && failure.status === 400) {
          yield* Effect.logWarning("gateway refused a reset redemption as malformed", {
            source: input.sourceId,
            account: input.accountId,
            kind,
            detail: failure.detail,
          });
        }
        return yield* new UsageLimitSourceError({ detail: failure.detail });
      }
      const outcome = redeemed.success;
      // Own keys only, so an outcome such as "constructor" never reads as settled.
      const known = Object.hasOwn(GATEWAY_REDEEM_OUTCOMES, outcome)
        ? GATEWAY_REDEEM_OUTCOMES[outcome]
        : undefined;
      if (known) {
        yield* Ref.update(pendingRedeems, (pending) => {
          const next = new Map(pending);
          next.delete(key);
          return next;
        });
      }
      yield* publishRead(input.sourceId, yield* readSource(input.sourceId, config));
      if (known) return { outcome: known };
      return yield* new UsageLimitSourceError({
        detail: Object.hasOwn(GATEWAY_REDEEM_REFUSALS, outcome)
          ? (GATEWAY_REDEEM_REFUSALS[outcome] ?? "")
          : `The gateway answered "${outcome}".`,
      });
    }
    if (!config?.enabled || config.kind !== "cliproxy") {
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
    yield* publishRead(input.sourceId, yield* readSource(input.sourceId, config));
    return result;
  }, refreshLock.withPermits(1));

  // Fork: while a client watches a gateway, each signed-in modelproxy source
  // follows the gateway's status stream rather than waiting for the interval.
  // Nobody watching means no open stream, so an idle environment costs the
  // gateway nothing more than the interval read.
  const watchers = yield* SubscriptionRef.make(0);
  const watch = Effect.acquireRelease(
    SubscriptionRef.update(watchers, (n) => n + 1),
    () => SubscriptionRef.update(watchers, (n) => n - 1),
  );

  // Shares the refresh lock so an interval read already in flight cannot
  // publish an older status over a newer streamed one.
  const publishSource = Effect.fn("UsageLimitSources.publishSource")(function* (
    snapshot: UsageLimitSourceSnapshot,
  ) {
    const previous = yield* Ref.get(stateRef);
    // A source the list does not have yet arrives with the next refresh.
    if (!previous.some((source) => source.id === snapshot.id)) return;
    yield* publish(previous.map((source) => (source.id === snapshot.id ? snapshot : source)));
  }, refreshLock.withPermits(1));

  const followSource = Effect.fn("UsageLimitSources.followSource")(function* (
    id: UsageLimitSourceId,
    config: ModelproxyUsageLimitSourceConfig,
  ) {
    let forceRefresh = false;
    let failures = 0;
    while (true) {
      const auth = yield* modelproxyAuth.authState(id);
      // Signing in restarts every follower, so a signed-out one can stop.
      if (auth.state !== "signedIn") return;
      let received = 0;
      const followed = yield* modelproxyAuth.accessToken(id, config, { forceRefresh }).pipe(
        Effect.flatMap((token) =>
          modelproxy.streamStatus(config.url, token).pipe(
            // Every publish reaches every connected client, not only the one
            // watching, and a busy gateway changes its in-flight count every
            // second. Keep only the latest status and publish at most one per
            // interval; the first goes out at once.
            Stream.buffer({ capacity: 1, strategy: "sliding" }),
            Stream.throttle({ cost: () => 1, units: 1, duration: LIVE_PUBLISH_INTERVAL }),
            Stream.runForEach((status) =>
              Effect.gen(function* () {
                received += 1;
                failures = 0;
                forceRefresh = false;
                following.add(id);
                const checkedAt = DateTime.formatIso(yield* DateTime.now);
                const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt };
                yield* publishSource(yield* modelproxySnapshot(id, base, auth, status));
              }),
            ),
          ),
        ),
        // However the stream ends, including the last watcher leaving, the
        // snapshot stops claiming to be live.
        Effect.ensuring(
          Effect.suspend(() =>
            following.delete(id) ? publishWith((previous) => previous) : Effect.void,
          ),
        ),
        Effect.result,
      );
      if (followed._tag === "Success" && received > 0) {
        // The gateway closed the stream (a deploy, an idle edge); pick it
        // back up after a beat.
        yield* Effect.sleep(FOLLOW_RECONNECT);
        continue;
      }
      // A stream that ended without one status (a proxy that buffers the
      // body until the idle timeout) is a failure too, or it would reopen
      // every second and leave the snapshot stale without saying so.
      const failure = followed._tag === "Failure" ? followed.failure : null;
      // The gateway can reject a token its expiry still vouches for; one
      // fresh token settles that before anything is reported.
      if (failure?._tag === "ModelproxyReadError" && failure.unauthorized && !forceRefresh) {
        forceRefresh = true;
        continue;
      }
      forceRefresh = false;
      yield* Effect.logDebug("usage limit source stream failed", {
        id,
        cause: failure ?? "closed before any status",
      });
      // A plain read reports the failure the way the interval would, and on
      // a gateway without the stream it is the live status: read on a short
      // cadence for as long as someone watches.
      yield* refresh;
      if (failure?._tag === "ModelproxyReadError" && failure.unsupported) {
        yield* Effect.sleep(UNSUPPORTED_READ_INTERVAL);
        continue;
      }
      failures += 1;
      yield* Effect.sleep(
        Duration.millis(
          Math.min(2 ** (failures - 1) * 1_000, Duration.toMillis(FOLLOW_BACKOFF_CAP)),
        ),
      );
    }
  });

  const followAll = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const sources = Object.entries(settings?.usageLimitSources ?? {}).flatMap(([id, config]) =>
      config.enabled && config.kind === "modelproxy"
        ? [[id as UsageLimitSourceId, config] as const]
        : [],
    );
    yield* Effect.forEach(
      sources,
      ([id, config]) =>
        // A defect in one follower stops that source following until the
        // next restart trigger; it must not end the trigger stream itself.
        followSource(id, config).pipe(
          Effect.catchDefect((defect) =>
            Effect.logError("usage limit source follower failed", { id, defect }),
          ),
        ),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
  });

  // Any change to who watches, which sources exist, or a sign-in restarts
  // the followers against current settings and credentials.
  yield* Stream.mergeAll(
    [
      SubscriptionRef.changes(watchers).pipe(
        Stream.map((count) => count > 0),
        Stream.changes,
        Stream.map(() => undefined),
      ),
      settingsService.streamChanges.pipe(
        Stream.map((settings) => settings.usageLimitSources),
        Stream.changes,
        Stream.map(() => undefined),
      ),
      modelproxyAuth.changes.pipe(Stream.map(() => undefined)),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Stream.switchMap(() =>
      Stream.fromEffect(
        SubscriptionRef.get(watchers).pipe(
          Effect.flatMap((count) => (count > 0 ? followAll : Effect.void)),
        ),
      ),
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
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

  // The interval skips reads while no client is looking, so a client coming
  // back (a laptop waking, a window refocused) re-reads a source that failed
  // or went unread for a whole interval rather than waiting for the next one.
  const refreshIfStale = Effect.gen(function* () {
    const current = yield* Ref.get(stateRef);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const ms = yield* intervalMs;
    const stale = current.some(
      (source) => source.error !== undefined || nowMs - Date.parse(source.checkedAt) >= ms,
    );
    if (stale) yield* refresh;
  });
  yield* backgroundPolicy.activityChanges.pipe(
    Stream.mapEffect(() => backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })),
    Stream.changes,
    Stream.filter((shouldRun) => shouldRun),
    Stream.runForEach(() => refreshIfStale),
    Effect.forkScoped,
  );

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    consumeResetCredit,
    auth,
    accountLogin,
    refresh,
    watch,
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
