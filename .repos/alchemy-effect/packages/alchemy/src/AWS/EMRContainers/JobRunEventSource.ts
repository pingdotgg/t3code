import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon EMR on EKS delivers to EventBridge for job
 * run state changes. Fields not shared by every event are optional (the
 * schema grows over time).
 */
export interface JobRunEventDetail {
  /** The ID of the job run. */
  id?: string;
  /** The name of the job run. */
  name?: string;
  /** The ID of the virtual cluster the job run belongs to. */
  virtualClusterId?: string;
  /** The ARN of the job run. */
  arn?: string;
  /** The state the job run transitioned to (e.g. `COMPLETED`, `FAILED`). */
  state?: string;
  /** For failed runs: the failure reason (e.g. `USER_ERROR`). */
  failureReason?: string;
  /** Additional detail about the state transition. */
  stateDetails?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An EMR on EKS job run EventBridge event delivered to the handler. */
export type JobRunEvent = EventRecord<JobRunEventDetail>;

export interface JobRunEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "EMRContainersJobRunEvents"
   */
  id?: string;
  /**
   * Restrict to job runs on specific virtual clusters (matched against the
   * event detail's `virtualClusterId`).
   */
  virtualClusterIds?: readonly string[];
  /**
   * Restrict to specific job run states (e.g. `["FAILED", "COMPLETED"]`).
   * @default all states
   */
  states?: readonly string[];
}

/**
 * Event source connecting Amazon EMR on EKS job run state changes to the
 * hosting compute. EMR on EKS publishes every job run state transition
 * (`PENDING` → `SUBMITTED` → `RUNNING` → `COMPLETED`/`FAILED`/`CANCELLED`)
 * to the account's default EventBridge bus (source `aws.emr-containers`,
 * detail-type `EMR Job Run State Change`); this subscribes the host
 * Function to those events so it can react when Spark jobs finish or fail.
 *
 * EMR on EKS publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Job Run Events
 * @example Alert On Failed Spark Jobs
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.EMRContainers.consumeJobRunEvents(
 *       { states: ["FAILED"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.logError(
 *             `job run ${event.detail.id} failed: ${event.detail.failureReason}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeJobRunEvents = <StreamReq = never, Req = never>(
  props: JobRunEventSourceProps,
  process: (
    events: Stream.Stream<JobRunEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "EMRContainersJobRunEvents",
    {
      source: ["aws.emr-containers"],
      "detail-type": ["EMR Job Run State Change"],
      ...(props.virtualClusterIds !== undefined || props.states !== undefined
        ? {
            detail: {
              ...(props.virtualClusterIds !== undefined
                ? { virtualClusterId: [...props.virtualClusterIds] }
                : {}),
              ...(props.states !== undefined
                ? { state: [...props.states] }
                : {}),
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
