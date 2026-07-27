import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload of a `Glue Job State Change` EventBridge event.
 * Emitted on the account's default bus (source `aws.glue`) when a job run
 * reaches `SUCCEEDED`, `FAILED`, `TIMEOUT`, or `STOPPED`.
 */
export interface JobEventDetail {
  /** The name of the Glue job the run belongs to. */
  jobName?: string;
  /** The severity of the notification (`INFO`, `WARN`, `ERROR`). */
  severity?: string;
  /** The state the job run transitioned to. */
  state?: "SUCCEEDED" | "FAILED" | "TIMEOUT" | "STOPPED" | (string & {});
  /** The id of the job run. */
  jobRunId?: string;
  /** A human-readable message (e.g. the failure reason). */
  message?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Glue job state-change EventBridge event delivered to the handler. */
export type JobEvent = EventRecord<JobEventDetail>;

export interface JobEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "GlueJobEvents"
   */
  id?: string;
  /**
   * Restrict to runs of specific jobs (matched against `detail.jobName`).
   * Omit to receive events for every Glue job in the account.
   */
  jobNames?: readonly string[];
  /**
   * Restrict to specific terminal states (matched against `detail.state`).
   * @default all states
   */
  states?: readonly ("SUCCEEDED" | "FAILED" | "TIMEOUT" | "STOPPED")[];
}

/**
 * Event source connecting Glue job run state changes to the hosting
 * compute. Glue publishes `Glue Job State Change` events to the account's
 * default EventBridge bus (source `aws.glue`) whenever a run reaches
 * `SUCCEEDED`, `FAILED`, `TIMEOUT`, or `STOPPED`; this subscribes the host
 * Function to those events so it can chain pipelines or alert on failures.
 *
 * Glue publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Job Events
 * @example Alert on Failed Runs
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Glue.consumeJobEvents(
 *       { states: ["FAILED", "TIMEOUT"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.logError(
 *             `glue run failed: ${event.detail.jobName} — ${event.detail.message}`,
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
    props.id ?? "GlueJobEvents",
    {
      source: ["aws.glue"],
      "detail-type": ["Glue Job State Change"],
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
