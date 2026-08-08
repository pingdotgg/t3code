import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon EMR Serverless delivers to EventBridge.
 * Job-run state-change events describe the run's transition; application
 * state-change events describe the application's lifecycle. Fields not
 * shared by every event kind are optional (the schema grows over time).
 */
export interface JobRunEventDetail {
  /** The id of the EMR Serverless application the event is about. */
  applicationId?: string;
  /** Job-run events: the id of the job run. */
  jobRunId?: string;
  /** The state transitioned to, e.g. `RUNNING`, `SUCCESS`, `FAILED`. */
  state?: string;
  /** Why the state changed (e.g. the failure reason). */
  stateDetails?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An EMR Serverless EventBridge event delivered to the handler. */
export type JobRunEvent = EventRecord<JobRunEventDetail>;

/** Which EMR Serverless notifications to subscribe to. */
export type JobRunEventKind =
  | "job-run-state-change"
  | "application-state-change";

const DETAIL_TYPES: Record<JobRunEventKind, string> = {
  "job-run-state-change": "EMR Serverless Job Run State Change",
  "application-state-change": "EMR Serverless Application State Change",
};

export interface JobRunEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "EMRServerlessJobRunEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: job-run state changes and/or
   * application state changes.
   * @default ["job-run-state-change"]
   */
  kinds?: readonly JobRunEventKind[];
  /**
   * Restrict to events about specific applications (matched against the
   * event detail's `applicationId`).
   */
  applicationIds?: readonly string[];
  /**
   * Restrict to specific states (matched against the event detail's
   * `state`), e.g. `["FAILED"]` to alert only on failures.
   */
  states?: readonly string[];
}

/**
 * Event source connecting Amazon EMR Serverless notifications to the
 * hosting compute. EMR Serverless publishes job-run state changes (most
 * importantly a job dropping into `FAILED`) and application state changes
 * to the account's default EventBridge bus (source `aws.emr-serverless`);
 * this subscribes the host Function to those events so it can alert on
 * failed jobs or chain follow-up work when a job succeeds.
 *
 * EMR Serverless publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Job Run Events
 * @example Alert On Failed Jobs
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.EMRServerless.consumeJobRunEvents(
 *       { states: ["FAILED"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.logError(
 *             `job ${event.detail.jobRunId} failed: ${event.detail.stateDetails}`,
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
    props.id ?? "EMRServerlessJobRunEvents",
    {
      source: ["aws.emr-serverless"],
      "detail-type": (props.kinds ?? (["job-run-state-change"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.applicationIds !== undefined || props.states !== undefined
        ? {
            detail: {
              ...(props.applicationIds !== undefined
                ? { applicationId: [...props.applicationIds] }
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
