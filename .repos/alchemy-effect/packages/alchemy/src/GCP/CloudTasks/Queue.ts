import * as cloudtasks from "@distilled.cloud/gcp/cloudtasks_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_STATE = "RUNNING" as const;
const MAX_QUEUE_ID_LENGTH = 100;

export type QueueRetryConfig = {
  /** Attempts per task, including the first. `-1` means unlimited. */
  maxAttempts?: number;
  /** Time limit for retrying a failed task, e.g. `"3600s"`. `"0s"` is unlimited. */
  maxRetryDuration?: string;
  /** Minimum backoff after a failed attempt, e.g. `"0.1s"`. */
  minBackoff?: string;
  /** Maximum backoff after a failed attempt, e.g. `"3600s"`. */
  maxBackoff?: string;
  /** Times the retry interval doubles before increasing linearly. */
  maxDoublings?: number;
};

export type QueueRateLimits = {
  /** Maximum dispatch rate (tasks per second). Max `500`. */
  maxDispatchesPerSecond?: number;
  /** Maximum concurrent dispatches. Max `5000`. */
  maxConcurrentDispatches?: number;
};

export type QueueStackdriverLoggingConfig = {
  /** Fraction of operations to log, in `[0.0, 1.0]`. `0` logs nothing. */
  samplingRatio?: number;
};

export type QueueHttpTarget = cloudtasks.HttpTarget;
export type QueueAppEngineRouting = cloudtasks.AppEngineRouting;

export type QueueState = "RUNNING" | "PAUSED";

export type QueueProps = {
  /**
   * Queue id (the `{queue}` segment of
   * `projects/{project}/locations/{location}/queues/{queue}`). If omitted,
   * a unique name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the queue.
   */
  queueId?: string;
  /**
   * Location of the queue (e.g. `us-central1`). Immutable — changing it
   * replaces the queue. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Queue-level retry settings applied to Cloud Tasks–created tasks.
   * Omitted fields keep the values Cloud Tasks currently has (including
   * API defaults).
   */
  retryConfig?: QueueRetryConfig;
  /**
   * Dispatch rate limits. `maxBurstSize` is output-only and not settable.
   * Omitted fields keep the current Cloud Tasks values.
   */
  rateLimits?: QueueRateLimits;
  /**
   * Cloud Logging sampling. If omitted, existing logging config is left
   * unchanged.
   */
  stackdriverLoggingConfig?: QueueStackdriverLoggingConfig;
  /**
   * Queue-level HTTP target overrides for HTTP tasks. If omitted, the
   * queue's current overrides are left unchanged.
   */
  httpTarget?: QueueHttpTarget;
  /**
   * App Engine routing override for App Engine tasks in this queue.
   */
  appEngineRoutingOverride?: QueueAppEngineRouting;
  /**
   * Desired queue state. `UpdateQueue` cannot change state — Alchemy
   * calls PauseQueue / ResumeQueue. `DISABLED` is queue.yaml-only and
   * is not settable here.
   * @default "RUNNING"
   */
  state?: QueueState;
};

export type Queue = Resource<
  "GCP.CloudTasks.Queue",
  QueueProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/queues/{queue}`. */
    name: string;
    /** Queue id (last path segment). */
    queueId: string;
    /** Project id. */
    project: string;
    /** Location id (e.g. `us-central1`). */
    location: string;
    /** Server-reported state (`RUNNING`, `PAUSED`, `DISABLED`). */
    state: string | undefined;
    /** Retry settings currently on the queue. */
    retryConfig: QueueRetryConfig | undefined;
    /** Dispatch rate limits currently on the queue. */
    rateLimits: QueueRateLimits | undefined;
    /** Logging config currently on the queue. */
    stackdriverLoggingConfig: QueueStackdriverLoggingConfig | undefined;
    /** Queue-level HTTP target overrides. */
    httpTarget: QueueHttpTarget | undefined;
    /** App Engine routing override, if any. */
    appEngineRoutingOverride: QueueAppEngineRouting | undefined;
    /** Last purge time, if the queue has ever been purged. */
    purgeTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud Tasks queue.
 *
 * Cloud Tasks queues have no labels, so Alchemy identifies its queues by
 * the generated `queueId`: `read` reports a queue with an explicit
 * `queueId` as unowned (adopt it with `--adopt`), and nuke cannot
 * discover queues.
 *
 * Changing `queueId` or `location` replaces the queue. Deleted queue
 * names are tombstoned for up to 3 days — CreateQueue may appear to
 * succeed; GetQueue is the source of truth.
 *
 * ### Creating a Queue
 * **Example:** Generated name
 * ```typescript
 * const queue = yield* GCP.CloudTasks.Queue("jobs", {});
 * ```
 *
 * **Example:** Rate limits, retries, and logging
 * ```typescript
 * const queue = yield* GCP.CloudTasks.Queue("jobs", {
 *   location: "us-central1",
 *   rateLimits: {
 *     maxDispatchesPerSecond: 10,
 *     maxConcurrentDispatches: 5,
 *   },
 *   retryConfig: {
 *     maxAttempts: 5,
 *     minBackoff: "1s",
 *     maxBackoff: "60s",
 *   },
 *   stackdriverLoggingConfig: { samplingRatio: 1 },
 * });
 * ```
 *
 * **Example:** Paused queue
 * ```typescript
 * const queue = yield* GCP.CloudTasks.Queue("jobs", {
 *   state: "PAUSED",
 * });
 * ```
 *
 * @resource
 * @category CloudTasks
 */
export const Queue = Resource<Queue>("GCP.CloudTasks.Queue");

export class QueueNotResolved extends Data.TaggedError(
  "GCP.CloudTasks.QueueNotResolved",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined, fallback: string) =>
  lastSegment(location ?? fallback).toLowerCase();

const parseName = (name: string) => {
  const parts = name.split("/");
  return {
    project: parts[1] ?? "",
    location: parts[3] ?? "",
    queueId: parts[5] ?? lastSegment(name),
  };
};

const resourceName = (project: string, location: string, queueId: string) =>
  `projects/${project}/locations/${location}/queues/${queueId}`;

const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const toQueueId = (
  id: string,
  queueId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (queueId !== undefined) return queueId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_QUEUE_ID_LENGTH,
      lowercase: true,
    });
    const named = /^[a-z]/.test(generated) ? generated : `q${generated}`;
    return named.replace(/-+$/g, "").slice(0, MAX_QUEUE_ID_LENGTH);
  });

const sortHeaderOverrides = (
  headers: cloudtasks.HeaderOverrideList | undefined,
): cloudtasks.HeaderOverrideList =>
  [...(headers ?? [])]
    .map((item) => ({
      header: {
        key: item.header?.key?.toLowerCase(),
        value: item.header?.value,
      },
    }))
    .sort((left, right) =>
      (left.header?.key ?? "").localeCompare(right.header?.key ?? ""),
    );

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, current) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return current;
  });

const normalizeDuration = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const match = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(value.trim());
  if (!match) return value;
  return `${Number(match[1])}s`;
};

const normalizeRetry = (config: QueueRetryConfig) => ({
  maxAttempts: config.maxAttempts,
  maxRetryDuration: normalizeDuration(config.maxRetryDuration),
  minBackoff: normalizeDuration(config.minBackoff),
  maxBackoff: normalizeDuration(config.maxBackoff),
  maxDoublings: config.maxDoublings,
});

const overlayChanged = (
  desired: object | undefined,
  observed: object | undefined,
  normalize: (value: object) => unknown = (value) => value,
): boolean => {
  if (desired === undefined) return false;
  const picked: Record<string, unknown> = {};
  const source = (observed ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(desired)) {
    picked[key] = source[key];
  }
  return stable(normalize(desired)) !== stable(normalize(picked));
};

const toRateLimits = (
  config: QueueRateLimits,
  observed?: cloudtasks.RateLimits,
): cloudtasks.RateLimits => {
  const merged: cloudtasks.RateLimits = { ...observed, ...config };
  delete merged.maxBurstSize;
  return merged;
};

const toUserRateLimits = (
  config: cloudtasks.RateLimits | undefined,
): QueueRateLimits | undefined => {
  if (config === undefined) return undefined;
  const next: QueueRateLimits = {};
  if (config.maxDispatchesPerSecond !== undefined) {
    next.maxDispatchesPerSecond = config.maxDispatchesPerSecond;
  }
  if (config.maxConcurrentDispatches !== undefined) {
    next.maxConcurrentDispatches = config.maxConcurrentDispatches;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

const toAttrs = (
  queue: cloudtasks.Queue,
  project: string,
): Queue["Attributes"] => {
  const name = queue.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    queueId: parsed.queueId,
    project: parsed.project || project,
    location: parsed.location,
    state: queue.state,
    retryConfig: queue.retryConfig,
    rateLimits: toUserRateLimits(queue.rateLimits),
    stackdriverLoggingConfig: queue.stackdriverLoggingConfig,
    httpTarget: queue.httpTarget,
    appEngineRoutingOverride: queue.appEngineRoutingOverride,
    purgeTime: queue.purgeTime,
  };
};

const getByName = (name: string) =>
  cloudtasks
    .getProjectsLocationsQueues({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const sameHttpTarget = (
  left: cloudtasks.HttpTarget,
  right: cloudtasks.HttpTarget | undefined,
) => {
  const normalize = (target: cloudtasks.HttpTarget | undefined) => {
    if (target === undefined) return undefined;
    return {
      ...target,
      headerOverrides: sortHeaderOverrides(target.headerOverrides),
    };
  };
  return stable(normalize(left)) === stable(normalize(right));
};

export const QueueProvider = () =>
  Provider.succeed(Queue, {
    stables: ["name", "queueId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.queueId ?? output?.queueId;
      const nextId = news.queueId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      if (idChanged || previousLocation !== nextLocation) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const queueId = yield* toQueueId(id, olds?.queueId, output?.queueId);
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name = output?.name ?? resourceName(env.project, location, queueId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const generated = yield* toQueueId(id, undefined);
      return attrs.queueId === generated ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const queueId = yield* toQueueId(id, news.queueId, output?.queueId);
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, queueId);
      const parent = locationParent(env.project, location);
      const desiredHttpTarget = news.httpTarget;
      const desiredState = news.state ?? DEFAULT_STATE;

      let current = yield* getByName(name);

      if (current === undefined) {
        const body: cloudtasks.Queue = {
          name,
          httpTarget: desiredHttpTarget,
        };
        if (news.retryConfig !== undefined) {
          body.retryConfig = news.retryConfig;
        }
        if (news.rateLimits !== undefined) {
          body.rateLimits = toRateLimits(news.rateLimits);
        }
        if (news.stackdriverLoggingConfig !== undefined) {
          body.stackdriverLoggingConfig = news.stackdriverLoggingConfig;
        }
        if (news.appEngineRoutingOverride !== undefined) {
          body.appEngineRoutingOverride = news.appEngineRoutingOverride;
        }
        // CreateQueue can appear to succeed for a tombstoned name. GetQueue
        // is the source of truth (up to ~3 days after delete).
        yield* cloudtasks
          .createProjectsLocationsQueues({
            parent,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.void));
        current = yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new QueueNotResolved({ name });
      }

      const mask: string[] = [];
      const patchBody: cloudtasks.Queue = { name };

      if (
        overlayChanged(news.retryConfig, current.retryConfig, (value) =>
          normalizeRetry(value as QueueRetryConfig),
        )
      ) {
        patchBody.retryConfig = {
          ...current.retryConfig,
          ...news.retryConfig,
        };
        mask.push("retryConfig");
      }

      const desiredRateLimits = news.rateLimits;
      if (
        desiredRateLimits !== undefined &&
        overlayChanged(desiredRateLimits, toUserRateLimits(current.rateLimits))
      ) {
        patchBody.rateLimits = toRateLimits(
          desiredRateLimits,
          current.rateLimits,
        );
        mask.push("rateLimits");
      }

      if (
        overlayChanged(
          news.stackdriverLoggingConfig,
          current.stackdriverLoggingConfig,
        )
      ) {
        patchBody.stackdriverLoggingConfig = {
          ...current.stackdriverLoggingConfig,
          ...news.stackdriverLoggingConfig,
        };
        mask.push("stackdriverLoggingConfig");
      }

      if (
        desiredHttpTarget !== undefined &&
        !sameHttpTarget(desiredHttpTarget, current.httpTarget)
      ) {
        patchBody.httpTarget = desiredHttpTarget;
        mask.push("httpTarget");
      }

      if (
        overlayChanged(
          news.appEngineRoutingOverride,
          current.appEngineRoutingOverride,
        )
      ) {
        patchBody.appEngineRoutingOverride = {
          ...current.appEngineRoutingOverride,
          ...news.appEngineRoutingOverride,
        };
        mask.push("appEngineRoutingOverride");
      }

      if (mask.length > 0) {
        current = yield* cloudtasks.patchProjectsLocationsQueues({
          name,
          updateMask: mask.join(","),
          body: patchBody,
        });
      }

      if (desiredState === "PAUSED" && current.state === "RUNNING") {
        current = yield* cloudtasks.pauseProjectsLocationsQueues({
          name,
          body: {},
        });
      } else if (
        desiredState === "RUNNING" &&
        (current.state === "PAUSED" || current.state === "DISABLED")
      ) {
        current = yield* cloudtasks.resumeProjectsLocationsQueues({
          name,
          body: {},
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cloudtasks
        .deleteProjectsLocationsQueues({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
