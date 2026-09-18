/**
 * ActivityWebhook - keeps a remote host awake while agent work runs.
 *
 * Hosting platforms suspend idle machines. While at least one thread has an
 * agent actively working, the server POSTs a heartbeat to a configured webhook
 * so the platform keeps the machine up even after every client disconnects.
 * T3 only knows a URL and a bearer token; nothing platform-specific lives here.
 *
 * "Active" is derived from the orchestration event stream, never from process
 * or connection state: a thread counts while its session is `starting` or
 * `running` and it has no open approval or user-input request. The request
 * accounting mirrors the decider's `openRequests` so a thread blocked on the
 * user never keeps a machine awake.
 *
 * @module ActivityWebhook
 */
import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { forkParked } from "../serverActivation.ts";

export const DEFAULT_INTERVAL_MS = 60_000;
export const MIN_INTERVAL_MS = 5_000;
export const MAX_INTERVAL_MS = 3_600_000;

/** Attempts per tick: the first send plus two retries (1s, 2s backoff). */
const RETRY_TIMES = 2;

/**
 * A hung connection must not hold the tick open past its own retries, so every
 * attempt is bounded well inside the smallest supported interval.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export interface ActivityWebhookSettings {
  readonly url: URL;
  readonly token: Redacted.Redacted<string>;
  readonly intervalMs: number;
}

export class ActivityWebhook extends Context.Service<
  ActivityWebhook,
  {
    /** Subscribe to domain events; parks the consumer until server activation. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Feed one event. Returns once the heartbeat loop reflects the new state. */
    readonly observe: (event: OrchestrationEvent) => Effect.Effect<void>;
    /** Threads currently keeping the heartbeat alive. */
    readonly activeThreadIds: Effect.Effect<ReadonlySet<ThreadId>>;
  }
>()("t3/activityWebhook/ActivityWebhook") {}

const EnvConfig = Config.all({
  url: Config.String("T3CODE_ACTIVITY_WEBHOOK_URL").pipe(Config.option),
  token: Config.Redacted("T3CODE_ACTIVITY_WEBHOOK_TOKEN").pipe(Config.option),
  intervalMs: Config.String("T3CODE_ACTIVITY_WEBHOOK_INTERVAL_MS").pipe(Config.option),
});

const ConfigFileConfig = Config.String("T3CODE_ACTIVITY_WEBHOOK_CONFIG_FILE").pipe(Config.option);

/**
 * Optional KEY=VALUE file consulted after the process environment, so the
 * token can live in a protected file instead of the launcher's environment.
 */
const configProviderWithFile = Effect.gen(function* () {
  const env = yield* ConfigProvider.ConfigProvider;
  const configFile = yield* ConfigFileConfig;
  if (Option.isNone(configFile)) return env;
  const file = yield* ConfigProvider.fromDotEnv({ path: configFile.value }).pipe(
    Effect.tapError(() =>
      Effect.logWarning("Activity webhook config file could not be read; using environment only", {
        path: configFile.value,
      }),
    ),
    Effect.option,
  );
  return Option.isSome(file) ? ConfigProvider.orElse(env, file.value) : env;
});

const parseInterval = (raw: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isNone(raw)) return DEFAULT_INTERVAL_MS;
    const value = Number(raw.value.trim());
    if (Number.isInteger(value) && value >= MIN_INTERVAL_MS && value <= MAX_INTERVAL_MS) {
      return value;
    }
    yield* Effect.logWarning("Invalid T3CODE_ACTIVITY_WEBHOOK_INTERVAL_MS; using default", {
      value: raw.value,
      defaultMs: DEFAULT_INTERVAL_MS,
      minMs: MIN_INTERVAL_MS,
      maxMs: MAX_INTERVAL_MS,
    });
    return DEFAULT_INTERVAL_MS;
  });

const parseUrl = (raw: string) => {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

/** Resolve settings from config. `None` disables the feature; never fails startup. */
export const resolveSettings: Effect.Effect<
  Option.Option<ActivityWebhookSettings>,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const provider = yield* configProviderWithFile;
  const env = yield* EnvConfig.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider));
  if (Option.isNone(env.url)) {
    yield* Effect.logDebug("Activity webhook disabled: T3CODE_ACTIVITY_WEBHOOK_URL is not set");
    return Option.none();
  }
  const url = parseUrl(env.url.value);
  if (url === null) {
    yield* Effect.logWarning(
      "Activity webhook disabled: T3CODE_ACTIVITY_WEBHOOK_URL is not an http(s) URL",
    );
    return Option.none();
  }
  if (Option.isNone(env.token) || Redacted.value(env.token.value).trim().length === 0) {
    yield* Effect.logWarning(
      "Activity webhook disabled: T3CODE_ACTIVITY_WEBHOOK_TOKEN is required when the URL is set",
    );
    return Option.none();
  }
  const intervalMs = yield* parseInterval(env.intervalMs);
  return Option.some<ActivityWebhookSettings>({ url, token: env.token.value, intervalMs });
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Activity webhook disabled: configuration could not be read", {
      cause: Cause.pretty(cause),
    }).pipe(Effect.as(Option.none<ActivityWebhookSettings>())),
  ),
);

const RETRY_SCHEDULE = Schedule.recurs(RETRY_TIMES).pipe(
  Schedule.addDelay(({ output: attempt }) => Effect.succeed(Duration.seconds(2 ** attempt))),
);

const requestPayload = (activity: unknown): Record<string, unknown> | null =>
  typeof activity === "object" && activity !== null ? (activity as Record<string, unknown>) : null;

/** Mirrors `isStaleRequestFailureDetail` in the decider. */
const isStaleRequestFailure = (payload: Record<string, unknown> | null): boolean => {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  return (
    detail !== null &&
    (detail.includes("stale pending approval request") ||
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("stale pending user-input request") ||
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request"))
  );
};

const disabled = ActivityWebhook.of({
  start: () => Effect.void,
  observe: () => Effect.void,
  activeThreadIds: Effect.succeed(new Set<ThreadId>()),
});

export const make = Effect.gen(function* () {
  const settings = yield* resolveSettings;
  if (Option.isNone(settings)) return disabled;
  const { url, token, intervalMs } = settings.value;

  const engine = yield* OrchestrationEngineService;
  const httpClient = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;

  const aliveSessions = new Set<ThreadId>();
  const openRequests = new Map<ThreadId, Set<string>>();
  const active = new Set<ThreadId>();
  let loop: Fiber.Fiber<unknown> | null = null;

  const sendHeartbeat = Effect.gen(function* () {
    const sentAt = DateTime.formatIso(yield* DateTime.now);
    const response = yield* httpClient.post(url, {
      headers: { authorization: `Bearer ${Redacted.value(token)}` },
      body: HttpBody.jsonUnsafe({ source: "t3code", activeThreads: active.size, sentAt }),
    });
    yield* HttpClientResponse.filterStatusOk(response);
  }).pipe(
    Effect.timeout(Duration.millis(REQUEST_TIMEOUT_MS)),
    Effect.retry({ schedule: RETRY_SCHEDULE }),
    // Log only the host and status: the request carries the bearer token.
    Effect.catch((error) =>
      Effect.logWarning("Activity webhook heartbeat failed", {
        host: url.host,
        status: error._tag === "TimeoutError" ? null : (error.response?.status ?? null),
        reason: error._tag === "TimeoutError" ? "Timeout" : error.reason._tag,
      }),
    ),
  );

  const syncLoop = Effect.gen(function* () {
    if (active.size > 0 && loop === null) {
      loop = yield* sendHeartbeat.pipe(
        Effect.repeat(Schedule.spaced(Duration.millis(intervalMs))),
        Effect.forkIn(scope),
      );
    } else if (active.size === 0 && loop !== null) {
      const fiber = loop;
      loop = null;
      yield* Fiber.interrupt(fiber);
    }
  });

  const recompute = (threadId: ThreadId) => {
    const blocked = (openRequests.get(threadId)?.size ?? 0) > 0;
    if (aliveSessions.has(threadId) && !blocked) {
      active.add(threadId);
    } else {
      active.delete(threadId);
    }
    return syncLoop;
  };

  const forget = (threadId: ThreadId) => {
    aliveSessions.delete(threadId);
    openRequests.delete(threadId);
    return recompute(threadId);
  };

  const observe: ActivityWebhook["Service"]["observe"] = (event) => {
    switch (event.type) {
      case "thread.session-set": {
        const { threadId, session } = event.payload;
        if (session.status === "starting" || session.status === "running") {
          aliveSessions.add(threadId);
        } else {
          aliveSessions.delete(threadId);
          openRequests.delete(threadId);
        }
        return recompute(threadId);
      }
      case "thread.deleted":
        return forget(event.payload.threadId);
      case "thread.activity-appended": {
        const { threadId, activity } = event.payload;
        const payload = requestPayload(activity.payload);
        const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
        if (requestId === null) return Effect.void;
        if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
          const requests = openRequests.get(threadId) ?? new Set<string>();
          requests.add(requestId);
          openRequests.set(threadId, requests);
        } else if (
          activity.kind === "approval.resolved" ||
          activity.kind === "user-input.resolved" ||
          ((activity.kind === "provider.approval.respond.failed" ||
            activity.kind === "provider.user-input.respond.failed") &&
            isStaleRequestFailure(payload))
        ) {
          openRequests.get(threadId)?.delete(requestId);
        } else {
          return Effect.void;
        }
        return recompute(threadId);
      }
      default:
        return Effect.void;
    }
  };

  const start: ActivityWebhook["Service"]["start"] = Effect.fn("ActivityWebhook.start")(
    function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* Effect.logInfo("Activity webhook enabled", { host: url.host, intervalMs });
      yield* forkParked(Stream.runForEach(events, observe));
    },
  );

  return ActivityWebhook.of({
    start,
    observe,
    activeThreadIds: Effect.sync(() => new Set(active)),
  });
});

export const layer = Layer.effectDiscard(Effect.flatMap(make, (service) => service.start()));
