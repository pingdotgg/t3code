import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload DataBrew delivers to EventBridge when a job run
 * changes state. Fields not shared by every event kind are optional (the
 * schema grows over time).
 */
export interface JobEventDetail {
  /** Name of the job the run belongs to. */
  jobName?: string;
  /** The run's id (`db_…`). */
  jobRunId?: string;
  /**
   * The new run state — `RUNNING`, `SUCCEEDED`, `FAILED`, `STOPPED`, or
   * `TIMEOUT`.
   */
  state?: string;
  /** Event severity, e.g. `INFO`. */
  severity?: string;
  /** Human-readable state-change message. */
  message?: string;
  /** The account the job belongs to. */
  accountId?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A DataBrew EventBridge event delivered to the handler. */
export type JobEvent = EventRecord<JobEventDetail>;

export interface JobEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "DataBrewJobEvents"
   */
  id?: string;
  /**
   * Restrict to events about specific jobs (matched against the event's
   * `jobName`).
   */
  jobNames?: readonly string[];
  /**
   * Restrict to specific run states, e.g. `["FAILED", "TIMEOUT"]`.
   */
  states?: readonly string[];
}

/**
 * Event source connecting DataBrew job-run notifications to the hosting
 * compute. DataBrew publishes every job-run state change to the account's
 * default EventBridge bus (source `aws.databrew`, detail-type
 * `DataBrew Job State Change`); this subscribes the host Function to those
 * events so it can alert on failed runs or chain post-run automation.
 *
 * DataBrew publishes to EventBridge automatically — no additional resource
 * is created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Job Events
 * @example Alert On Failed Runs
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.DataBrew.consumeJobEvents(
 *       { states: ["FAILED", "TIMEOUT"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `run ${event.detail.jobRunId} of ${event.detail.jobName} failed`,
 *           ),
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
    events: Stream.Stream<JobEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "DataBrewJobEvents",
    {
      source: ["aws.databrew"],
      "detail-type": ["DataBrew Job State Change"],
      ...(props.jobNames !== undefined || props.states !== undefined
        ? {
            detail: {
              ...(props.jobNames !== undefined
                ? { jobName: [...props.jobNames] }
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
