import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RetryConfig } from "./Job.ts";

/** One Cloud Scheduler invocation. */
export interface ScheduledEvent {
  /** RFC3339 time the run was scheduled for (`X-CloudScheduler-ScheduleTime`). */
  scheduleTime: string;
  /** Short id of the job that fired (`X-CloudScheduler-JobName`). */
  jobName: string;
  /** The job's configured request body, if any. */
  body: string | undefined;
}

export interface ScheduleEventSourceProps {
  /**
   * Cron (`"0 * * * *"`) or english-like (`"every 5 minutes"`) schedule.
   */
  schedule: string;
  /**
   * tz-database time zone used to interpret `schedule`.
   * @default "Etc/UTC"
   */
  timeZone?: string;
  /** UTF-8 body sent with every invocation. */
  body?: string;
  /**
   * Cloud Scheduler location of the backing job.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Retry policy for failed invocations. The default retries a refused or
   * failed delivery (e.g. while a new invoker grant propagates) instead
   * of dropping that run.
   * @default { retryCount: 5, minBackoffDuration: "10s", maxBackoffDuration: "120s" }
   */
  retryConfig?: RetryConfig;
  /**
   * Delivery path on the host. Defaults to a deterministic per-schedule
   * path under `/__alchemy/scheduler/`.
   */
  path?: string;
}

export type ScheduledEventHandler<Req> = (
  event: ScheduledEvent,
) => Effect.Effect<void, never, Req>;

export type ScheduleEventSourceService = <Req = never>(
  id: string,
  props: ScheduleEventSourceProps,
  process: ScheduledEventHandler<Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source that invokes the hosting compute on a Cloud Scheduler
 * schedule — the "cron handler" DX.
 *
 * The HTTP-host implementation is `GCP.Run.ScheduleEventSource`
 * (`GCP.Function` / `GCP.Run.Service`, `GCP.CloudFunctions.Function`): it
 * creates a Cloud Scheduler job that `POST`s to the host with an OIDC
 * token for the host's runtime service account, grants that account
 * `roles/run.invoker` on the host, and verifies the token on every
 * invocation. A failed handler answers 500 and the job's retry policy
 * applies.
 *
 * Consume it through {@link consumeSchedule}.
 *
 * ### Consuming a Schedule
 * **Example:** Nightly cleanup on a Cloud Run service
 * ```typescript
 * export class Api extends GCP.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* GCP.CloudScheduler.consumeSchedule(
 *       "NightlyCleanup",
 *       { schedule: "0 3 * * *", timeZone: "America/New_York" },
 *       (event) => Effect.log(`cleanup scheduled for ${event.scheduleTime}`),
 *     );
 *   }).pipe(Effect.provide(GCP.Run.ScheduleEventSource)),
 * ) {}
 * ```
 *
 * **Example:** Pass a fixed payload
 * ```typescript
 * yield* GCP.CloudScheduler.consumeSchedule(
 *   "Digest",
 *   { schedule: "every 1 hours", body: JSON.stringify({ kind: "digest" }) },
 *   (event) => sendDigest(JSON.parse(event.body ?? "{}")),
 * );
 * ```
 *
 * @binding
 * @category CloudScheduler
 */
export interface ScheduleEventSource extends Binding.Service<
  ScheduleEventSource,
  "GCP.CloudScheduler.ScheduleEventSource",
  ScheduleEventSourceService
> {}

export const ScheduleEventSource = Binding.Service<ScheduleEventSource>(
  "GCP.CloudScheduler.ScheduleEventSource",
);

/**
 * Run an Effect handler on a Cloud Scheduler schedule. `id` names the
 * backing job and its delivery route; keep it stable. See
 * {@link ScheduleEventSource} for the host implementations.
 */
export const consumeSchedule = <Req = never>(
  id: string,
  props: ScheduleEventSourceProps,
  process: ScheduledEventHandler<Req>,
): Effect.Effect<void, never, ScheduleEventSource> =>
  ScheduleEventSource.use((source) => source(id, props, process));
