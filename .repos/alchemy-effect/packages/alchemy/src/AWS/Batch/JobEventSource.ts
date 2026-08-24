import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS Batch delivers to EventBridge when a job changes
 * state (`Batch Job State Change`) or a job queue becomes blocked
 * (`Batch Job Queue Blocked`). Fields not shared by every event kind are
 * optional (the schema grows over time).
 */
export interface BatchJobEventDetail {
  /** The job's ARN (`arn:…:job/{jobId}`). */
  jobArn?: string;
  /** The job id. */
  jobId?: string;
  /** The job name given at submission. */
  jobName?: string;
  /** ARN of the job queue the job was submitted to. */
  jobQueue?: string;
  /** The new job status, e.g. `RUNNABLE`, `STARTING`, `SUCCEEDED`, `FAILED`. */
  status?: string;
  /** Human-readable reason for the status, when present. */
  statusReason?: string;
  /** Revision-qualified job definition ARN the job runs. */
  jobDefinition?: string;
  /** Container detail (image, exit code, log stream, …) on state changes. */
  container?: Record<string, unknown>;
  /** `Ref::` parameter substitutions supplied at submission. */
  parameters?: Record<string, string>;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An AWS Batch EventBridge event delivered to the handler. */
export type BatchJobEvent = EventRecord<BatchJobEventDetail>;

/** Which AWS Batch state-change events to subscribe to. */
export type BatchJobEventKind = "job-state" | "job-queue-blocked";

const DETAIL_TYPES: Record<BatchJobEventKind, string> = {
  "job-state": "Batch Job State Change",
  "job-queue-blocked": "Batch Job Queue Blocked",
};

export interface JobEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "BatchJobEvents"
   */
  id?: string;
  /**
   * Which state-change events to subscribe to.
   * @default all kinds
   */
  kinds?: readonly BatchJobEventKind[];
}

/**
 * Event source connecting AWS Batch job state changes to the hosting compute.
 * AWS Batch publishes every job state transition (and job-queue-blocked
 * notifications) to the account's default EventBridge bus (source
 * `aws.batch`); this subscribes the host Function to those events so it can
 * alert on `FAILED` jobs or chain post-completion automation.
 *
 * AWS Batch publishes to EventBridge automatically — no additional resource
 * is created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Job Events
 * @example Alert On Failed Jobs
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Batch.consumeJobEvents(
 *       { kinds: ["job-state"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.status === "FAILED"
 *             ? Effect.log(`batch job ${event.detail.jobId} failed`)
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeJobEvents = <StreamReq = never, Req = never>(
  props: JobEventSourceProps,
  process: (
    events: Stream.Stream<BatchJobEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "BatchJobEvents",
    {
      source: ["aws.batch"],
      "detail-type": (
        props.kinds ?? (Object.keys(DETAIL_TYPES) as BatchJobEventKind[])
      ).map((kind) => DETAIL_TYPES[kind]),
    },
    { description: props.description, state: props.state },
    process,
  );
