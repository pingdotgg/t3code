import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_TIME_ZONE = "UTC";
const DEFAULT_HTTP_METHOD = "POST";
const MAX_NAME_LENGTH = 63;

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(300), 1.5),
  Schedule.spaced(Duration.seconds(2)),
]);

export type HttpMethod =
  | "POST"
  | "GET"
  | "HEAD"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "OPTIONS";

export type OidcToken = {
  /**
   * Service account email used to mint the OIDC token. Must be in the same
   * project as the job. The caller needs `iam.serviceAccounts.actAs`.
   */
  serviceAccountEmail?: string;
  /**
   * Audience claimed in the token. Defaults to the HTTP target URI.
   */
  audience?: string;
};

export type OAuthToken = {
  /**
   * Service account email used to mint the OAuth token. Must be in the same
   * project as the job. The caller needs `iam.serviceAccounts.actAs`.
   */
  serviceAccountEmail?: string;
  /**
   * OAuth scope. Defaults to `https://www.googleapis.com/auth/cloud-platform`.
   */
  scope?: string;
};

export type HttpTarget = {
  /**
   * Full URI the job POSTs (or GETs, …) to. Must start with `http://` or
   * `https://`.
   */
  uri: string;
  /**
   * HTTP method.
   * @default "POST"
   */
  httpMethod?: HttpMethod;
  /**
   * Request headers. Cloud Scheduler overwrites Host, Content-Length,
   * User-Agent, and `X-Google-*` / `X-CloudScheduler*` headers.
   */
  headers?: Record<string, string>;
  /**
   * UTF-8 request body. Allowed for POST, PUT, and PATCH. Alchemy
   * base64-encodes this for the API.
   */
  body?: string;
  /**
   * Attach an OIDC token as `Authorization`.
   */
  oidcToken?: OidcToken;
  /**
   * Attach an OAuth token as `Authorization` (typically for
   * `*.googleapis.com` targets).
   */
  oauthToken?: OAuthToken;
};

export type PubsubTarget = {
  /**
   * Pub/Sub topic to publish to, as
   * `projects/{project}/topics/{topic}`. Must be in the same project.
   */
  topicName: string;
  /**
   * UTF-8 message payload. Alchemy base64-encodes this for the API.
   * Either `data` or `attributes` is required.
   */
  data?: string;
  /**
   * Message attributes. Either `data` or `attributes` is required.
   */
  attributes?: Record<string, string>;
};

export type AppEngineRouting = {
  /** App Engine service. Empty uses the default service. */
  service?: string;
  /** App Engine version. Empty uses the default version. */
  version?: string;
  /** App Engine instance. Empty uses any available instance. */
  instance?: string;
};

export type AppEngineHttpTarget = {
  /**
   * Relative URI beginning with `/`. Empty uses `/`.
   */
  relativeUri?: string;
  /**
   * HTTP method. PATCH and OPTIONS are not permitted.
   * @default "POST"
   */
  httpMethod?: HttpMethod;
  /**
   * Request headers.
   */
  headers?: Record<string, string>;
  /**
   * UTF-8 request body. Allowed for POST and PUT. Alchemy base64-encodes
   * this for the API.
   */
  body?: string;
  /**
   * App Engine service / version / instance routing.
   */
  appEngineRouting?: AppEngineRouting;
};

export type RetryConfig = {
  /**
   * Retry attempts after a failed execution (0–5).
   * @default 0
   */
  retryCount?: number;
  /**
   * Time limit for retrying a failed job (e.g. `"3600s"`). Zero means
   * unlimited, unless `retryCount` is also 0.
   */
  maxRetryDuration?: string;
  /**
   * Times the backoff doubles before increasing linearly.
   * @default 5
   */
  maxDoublings?: number;
  /**
   * Maximum backoff between retries.
   * @default "3600s"
   */
  maxBackoffDuration?: string;
  /**
   * Minimum backoff between retries.
   * @default "5s"
   */
  minBackoffDuration?: string;
};

export type JobProps = {
  /**
   * Job id (the `{job}` segment of
   * `projects/{project}/locations/{location}/jobs/{job}`). If omitted, a
   * unique name is generated from the stack, stage, and logical id. Must
   * match `[A-Za-z0-9_-]{1,500}`. Immutable — changing it replaces the job.
   */
  jobId?: string;
  /**
   * Cloud Scheduler location (`us-central1`, `us-east1`, …). Immutable —
   * changing it replaces the job. `US-CENTRAL1` is accepted and normalized
   * to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Cron or english-like schedule (e.g. `"0 0 * * *"` or
   * `"every 24 hours"`). Required on create.
   */
  schedule: string;
  /**
   * tz-database time zone used to interpret `schedule`.
   * @default "UTC"
   */
  timeZone?: string;
  /**
   * Human-readable description (single line, max 499 characters).
   */
  description?: string;
  /**
   * Deadline for a single attempt (e.g. `"180s"`). HTTP targets default to
   * 3 minutes and must be in `[15s, 30m]`.
   */
  attemptDeadline?: string;
  /**
   * Retry behavior after a failed attempt.
   */
  retryConfig?: RetryConfig;
  /**
   * HTTP/HTTPS target. Exactly one of `httpTarget`, `pubsubTarget`, or
   * `appEngineHttpTarget` must be set.
   */
  httpTarget?: HttpTarget;
  /**
   * Pub/Sub target. Exactly one of `httpTarget`, `pubsubTarget`, or
   * `appEngineHttpTarget` must be set.
   */
  pubsubTarget?: PubsubTarget;
  /**
   * App Engine HTTP target. Exactly one of `httpTarget`, `pubsubTarget`,
   * or `appEngineHttpTarget` must be set.
   */
  appEngineHttpTarget?: AppEngineHttpTarget;
  /**
   * When true, the job exists but is not scheduled (`Job.State.PAUSED`).
   * Synced via `jobs.pause` / `jobs.resume`.
   * @default false
   */
  paused?: boolean;
};

export type Job = Resource<
  "GCP.CloudScheduler.Job",
  JobProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/jobs/{job}`. */
    name: string;
    /** Job id (last path segment). */
    jobId: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Project id. */
    project: string;
    /** Job description. */
    description: string | undefined;
    /** Cron or english-like schedule. */
    schedule: string | undefined;
    /** Time zone used to interpret the schedule. */
    timeZone: string | undefined;
    /** Server-reported job state. */
    state: string | undefined;
    /** Whether the job is paused. */
    paused: boolean;
    /** Attempt deadline. */
    attemptDeadline: string | undefined;
    /** Retry configuration. */
    retryConfig: RetryConfig | undefined;
    /** HTTP target, if set. Body is the API's base64 payload. */
    httpTarget: scheduler.HttpTarget | undefined;
    /** Pub/Sub target, if set. */
    pubsubTarget: scheduler.PubsubTarget | undefined;
    /** App Engine HTTP target, if set. */
    appEngineHttpTarget: scheduler.AppEngineHttpTarget | undefined;
    /** Next scheduled attempt (RFC3339). */
    scheduleTime: string | undefined;
    /** Last attempt start (RFC3339). */
    lastAttemptTime: string | undefined;
    /** Last user update (RFC3339). */
    userUpdateTime: string | undefined;
    /** Last attempt status. */
    status: scheduler.Status | undefined;
    /** Whether the job satisfies physical zone separation. */
    satisfiesPzs: boolean | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Scheduler job that invokes an HTTP, Pub/Sub, or App Engine
 * target on a cron schedule.
 *
 * Jobs have no labels field, so ownership rests on the deterministic job
 * name: `read` reports a job it finds without prior state as unowned
 * (adopt it with `--adopt`). Name and location are immutable; changing
 * either replaces the job.
 *
 * ### Creating a Job
 * **Example:** Generated name, yearly HTTP GET
 * ```typescript
 * const ping = yield* GCP.CloudScheduler.Job("Ping", {
 *   schedule: "0 0 1 1 *",
 *   paused: true,
 *   httpTarget: {
 *     uri: "https://example.com/",
 *     httpMethod: "GET",
 *   },
 * });
 * ```
 *
 * **Example:** Named job with retries and a POST body
 * ```typescript
 * const notify = yield* GCP.CloudScheduler.Job("Notify", {
 *   jobId: "order-notify",
 *   location: "us-central1",
 *   schedule: "every 15 minutes",
 *   timeZone: "America/Chicago",
 *   description: "fan out order events",
 *   retryConfig: { retryCount: 3, minBackoffDuration: "10s" },
 *   httpTarget: {
 *     uri: "https://example.com/hooks/orders",
 *     httpMethod: "POST",
 *     headers: { "Content-Type": "application/json" },
 *     body: JSON.stringify({ source: "scheduler" }),
 *   },
 * });
 * ```
 *
 * **Example:** Pub/Sub target
 * ```typescript
 * const tick = yield* GCP.CloudScheduler.Job("Tick", {
 *   schedule: "0 * * * *",
 *   pubsubTarget: {
 *     topicName: topic.name,
 *     data: "tick",
 *   },
 * });
 * ```
 *
 * @resource
 * @category CloudScheduler
 */
export const Job = Resource<Job>("GCP.CloudScheduler.Job");

export class JobNotResolved extends Data.TaggedError(
  "GCP.CloudScheduler.JobNotResolved",
)<{
  name: string;
}> {}

export class SchedulerJobNotReady extends Data.TaggedError(
  "GCP.CloudScheduler.JobNotReady",
)<{
  name: string;
  state: string | undefined;
}> {}

export class JobStateFailed extends Data.TaggedError(
  "GCP.CloudScheduler.JobStateFailed",
)<{
  name: string;
  state: string;
  message: string;
}> {}

export class JobTargetMissing extends Data.TaggedError(
  "GCP.CloudScheduler.JobTargetMissing",
)<{
  name: string;
  message: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined, fallback: string) =>
  lastSegment(location ?? fallback).toLowerCase();

const resourceName = (project: string, location: string, jobId: string) =>
  `projects/${project}/locations/${location}/jobs/${jobId}`;

const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const parseName = (name: string, fallbackLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const jobsAt = parts.lastIndexOf("jobs");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : fallbackLocation,
    jobId:
      jobsAt >= 0 && parts[jobsAt + 1] ? parts[jobsAt + 1]! : lastSegment(name),
  };
};

const toId = (id: string, jobId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      jobId ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const encodeUtf8 = (value: string | undefined) =>
  value === undefined
    ? Effect.succeed(undefined as string | undefined)
    : Effect.sync(() => Buffer.from(value, "utf8").toString("base64"));

const methodOf = (value: string | undefined) =>
  value && value !== "HTTP_METHOD_UNSPECIFIED" ? value : DEFAULT_HTTP_METHOD;

const timeZoneOf = (value: string | undefined) =>
  value && value.length > 0 ? value : DEFAULT_TIME_ZONE;

const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;

const toAttrs = (job: scheduler.Job, project: string, region: string) => {
  const name = job.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    jobId: parsed.jobId,
    location: parsed.location,
    project: parsed.project || project,
    description: job.description,
    schedule: job.schedule,
    timeZone: job.timeZone,
    state: job.state,
    paused: job.state === "PAUSED",
    attemptDeadline: job.attemptDeadline,
    retryConfig: job.retryConfig,
    httpTarget: job.httpTarget,
    pubsubTarget: job.pubsubTarget,
    appEngineHttpTarget: job.appEngineHttpTarget,
    scheduleTime: job.scheduleTime,
    lastAttemptTime: job.lastAttemptTime,
    userUpdateTime: job.userUpdateTime,
    status: job.status,
    satisfiesPzs: job.satisfiesPzs,
  };
};

const getByName = (name: string) =>
  scheduler
    .getProjectsLocationsJobs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/** Poll until Cloud Scheduler reports the job in the desired ENABLED/PAUSED state. */
const waitForJobState = (name: string, paused: boolean) =>
  getByName(name).pipe(
    Effect.flatMap(
      (
        job,
      ): Effect.Effect<
        scheduler.Job,
        JobStateFailed | SchedulerJobNotReady
      > => {
        const desired = paused ? "PAUSED" : "ENABLED";
        if (job?.state === desired) return Effect.succeed(job);
        if (job?.state === "UPDATE_FAILED" || job?.state === "DISABLED") {
          return Effect.fail(
            new JobStateFailed({
              name,
              state: job.state,
              message: job.status?.message ?? `job is ${job.state}`,
            }),
          );
        }
        return Effect.fail(
          new SchedulerJobNotReady({ name, state: job?.state }),
        );
      },
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.CloudScheduler.JobNotReady",
      times: 30,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const headersMatch = (
  observed: scheduler.StringMap | undefined,
  desired: Record<string, string> | undefined,
) => {
  if (desired === undefined) return true;
  const current = observed ?? {};
  for (const [key, value] of Object.entries(desired)) {
    const found = Object.entries(current).find(
      ([header]) => header.toLowerCase() === key.toLowerCase(),
    );
    if ((found?.[1] ?? "") !== value) return false;
  }
  return true;
};

const tokenEqual = (
  observed:
    | { serviceAccountEmail?: string; audience?: string; scope?: string }
    | undefined,
  desired:
    | { serviceAccountEmail?: string; audience?: string; scope?: string }
    | undefined,
) => {
  if (desired === undefined) return true;
  return (
    (observed?.serviceAccountEmail ?? "") ===
      (desired.serviceAccountEmail ?? "") &&
    (observed?.audience ?? "") === (desired.audience ?? "") &&
    (observed?.scope ?? "") === (desired.scope ?? "")
  );
};

const subsetEqual = (
  observed: Record<string, unknown> | undefined,
  desired: Record<string, unknown> | undefined,
) => {
  if (desired === undefined) return true;
  const current = observed ?? {};
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    if (current[key] !== value) return false;
  }
  return true;
};

const toApiHttpTarget = Effect.fn(function* (target: HttpTarget) {
  return compact({
    uri: target.uri,
    httpMethod: target.httpMethod,
    headers: target.headers,
    body: yield* encodeUtf8(target.body),
    oidcToken: target.oidcToken,
    oauthToken: target.oauthToken,
  }) as scheduler.HttpTarget;
});

const toApiPubsubTarget = Effect.fn(function* (target: PubsubTarget) {
  return compact({
    topicName: target.topicName,
    data: yield* encodeUtf8(target.data),
    attributes: target.attributes,
  }) as scheduler.PubsubTarget;
});

const toApiAppEngineHttpTarget = Effect.fn(function* (
  target: AppEngineHttpTarget,
) {
  return compact({
    relativeUri: target.relativeUri,
    httpMethod: target.httpMethod,
    headers: target.headers,
    body: yield* encodeUtf8(target.body),
    appEngineRouting: target.appEngineRouting,
  }) as scheduler.AppEngineHttpTarget;
});

const httpTargetDrift = (
  observed: scheduler.HttpTarget | undefined,
  desired: scheduler.HttpTarget | undefined,
  news: HttpTarget | undefined,
) => {
  if (news === undefined || desired === undefined) return false;
  if ((observed?.uri ?? "") !== (desired.uri ?? "")) return true;
  if (methodOf(observed?.httpMethod) !== methodOf(desired.httpMethod)) {
    return true;
  }
  if ((observed?.body ?? "") !== (desired.body ?? "")) return true;
  if (!headersMatch(observed?.headers, news.headers)) return true;
  if (!tokenEqual(observed?.oidcToken, news.oidcToken)) return true;
  if (!tokenEqual(observed?.oauthToken, news.oauthToken)) return true;
  return false;
};

const pubsubTargetDrift = (
  observed: scheduler.PubsubTarget | undefined,
  desired: scheduler.PubsubTarget | undefined,
) => {
  if (desired === undefined) return false;
  if ((observed?.topicName ?? "") !== (desired.topicName ?? "")) return true;
  if ((observed?.data ?? "") !== (desired.data ?? "")) return true;
  return !subsetEqual(observed?.attributes, desired.attributes);
};

const appEngineTargetDrift = (
  observed: scheduler.AppEngineHttpTarget | undefined,
  desired: scheduler.AppEngineHttpTarget | undefined,
  news: AppEngineHttpTarget | undefined,
) => {
  if (news === undefined || desired === undefined) return false;
  if ((observed?.relativeUri ?? "") !== (desired.relativeUri ?? "")) {
    return true;
  }
  if (methodOf(observed?.httpMethod) !== methodOf(desired.httpMethod)) {
    return true;
  }
  if ((observed?.body ?? "") !== (desired.body ?? "")) return true;
  if (!headersMatch(observed?.headers, news.headers)) return true;
  return !subsetEqual(
    observed?.appEngineRouting as Record<string, unknown> | undefined,
    news.appEngineRouting as Record<string, unknown> | undefined,
  );
};

const hasTarget = (news: JobProps) =>
  news.httpTarget !== undefined ||
  news.pubsubTarget !== undefined ||
  news.appEngineHttpTarget !== undefined;

const retryTransient = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "NotFound" || error._tag === "Conflict",
      times: 8,
      schedule: backoff,
    }),
  );

const syncPaused = Effect.fn(function* (
  name: string,
  current: scheduler.Job,
  paused: boolean,
) {
  if (paused && current.state === "ENABLED") {
    const pausedJob = yield* retryTransient(
      scheduler.pauseProjectsLocationsJobs({ name, body: {} }),
    ).pipe(
      Effect.catchTag(["BadRequest", "Conflict", "NotFound"], () =>
        getByName(name).pipe(
          Effect.flatMap((job) =>
            job !== undefined && job.state === "PAUSED"
              ? Effect.succeed(job)
              : new JobNotResolved({ name }),
          ),
        ),
      ),
    );
    return pausedJob ?? current;
  }
  if (!paused && current.state === "PAUSED") {
    const resumed = yield* retryTransient(
      scheduler.resumeProjectsLocationsJobs({ name, body: {} }),
    ).pipe(
      Effect.catchTag(["BadRequest", "Conflict", "NotFound"], () =>
        getByName(name).pipe(
          Effect.flatMap((job) =>
            job !== undefined && job.state === "ENABLED"
              ? Effect.succeed(job)
              : new JobNotResolved({ name }),
          ),
        ),
      ),
    );
    return resumed ?? current;
  }
  return current;
});

export const JobProvider = () =>
  Provider.succeed(Job, {
    stables: ["name", "jobId", "location", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.jobId ?? output?.jobId;
      const nextId = news.jobId ?? previousId;
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
      const locationChanged = previousLocation !== nextLocation;

      if (idChanged || locationChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toId(id, olds?.jobId, output?.jobId);
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name = output?.name ?? resourceName(env.project, location, jobId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      // No labels field: without prior state the job may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toId(id, news.jobId, output?.jobId);
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, jobId);
      const parent = parentOf(env.project, location);
      if (!hasTarget(news)) {
        return yield* new JobTargetMissing({
          name,
          message:
            "Cloud Scheduler jobs require httpTarget, pubsubTarget, or appEngineHttpTarget",
        });
      }

      // Descriptions are a single RE2 line (`^.{1,499}$`).
      const desiredDescription =
        news.description
          ?.replace(/[\r\n]+/g, " ")
          .trim()
          .slice(0, 499) || undefined;
      const desiredTimeZone = timeZoneOf(news.timeZone);
      const desiredPaused = news.paused === true;
      const httpTarget =
        news.httpTarget !== undefined
          ? yield* toApiHttpTarget(news.httpTarget)
          : undefined;
      const pubsubTarget =
        news.pubsubTarget !== undefined
          ? yield* toApiPubsubTarget(news.pubsubTarget)
          : undefined;
      const appEngineHttpTarget =
        news.appEngineHttpTarget !== undefined
          ? yield* toApiAppEngineHttpTarget(news.appEngineHttpTarget)
          : undefined;

      const desiredBody: scheduler.Job = compact({
        name,
        description: desiredDescription,
        schedule: news.schedule,
        timeZone: desiredTimeZone,
        attemptDeadline: news.attemptDeadline,
        retryConfig: news.retryConfig,
        httpTarget,
        pubsubTarget,
        appEngineHttpTarget,
      });

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* scheduler
          .createProjectsLocationsJobs({
            parent,
            body: desiredBody,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new JobNotResolved({ name });
      }

      const mask: string[] = [];
      if ((current.description ?? "") !== (desiredDescription ?? "")) {
        mask.push("description");
      }
      if ((current.schedule ?? "") !== news.schedule) {
        mask.push("schedule");
      }
      if (timeZoneOf(current.timeZone) !== desiredTimeZone) {
        mask.push("timeZone");
      }
      if (
        news.attemptDeadline !== undefined &&
        (current.attemptDeadline ?? "") !== news.attemptDeadline
      ) {
        mask.push("attemptDeadline");
      }
      if (
        news.retryConfig !== undefined &&
        !subsetEqual(
          current.retryConfig as Record<string, unknown> | undefined,
          news.retryConfig as Record<string, unknown>,
        )
      ) {
        mask.push("retryConfig");
      }
      if (httpTargetDrift(current.httpTarget, httpTarget, news.httpTarget)) {
        mask.push("httpTarget");
      }
      if (pubsubTargetDrift(current.pubsubTarget, pubsubTarget)) {
        mask.push("pubsubTarget");
      }
      if (
        appEngineTargetDrift(
          current.appEngineHttpTarget,
          appEngineHttpTarget,
          news.appEngineHttpTarget,
        )
      ) {
        mask.push("appEngineHttpTarget");
      }

      if (mask.length > 0) {
        current = yield* retryTransient(
          scheduler.patchProjectsLocationsJobs({
            name,
            updateMask: mask.join(","),
            body: desiredBody,
          }),
        );
        current = (yield* getByName(name)) ?? current;
      }

      current = yield* syncPaused(name, current, desiredPaused);
      current = yield* waitForJobState(name, desiredPaused);
      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* scheduler.deleteProjectsLocationsJobs({ name: output.name }).pipe(
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 10,
          schedule: Schedule.spaced("3 seconds"),
        }),
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
