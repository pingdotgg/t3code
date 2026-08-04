import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon MWAA Serverless delivers to EventBridge for
 * workflow-run and task state-change events. The schema is not pinned by
 * the service docs, so fields are optional and unknown fields are allowed
 * (the schema grows over time).
 */
export interface WorkflowRunEventDetail {
  /** ARN of the workflow the event is about. */
  workflowArn?: string;
  /** The run the event is about. */
  runId?: string;
  /** Task events: the task instance the event is about. */
  taskInstanceId?: string;
  /** The state transitioned to, e.g. `RUNNING`, `SUCCESS`, `FAILED`. */
  status?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An MWAA Serverless EventBridge event delivered to the handler. */
export type WorkflowRunEvent = EventRecord<WorkflowRunEventDetail>;

/**
 * Workflow-run states MWAA Serverless publishes as
 * `MWAA Serverless Workflow Run {State}` detail-types.
 */
export type WorkflowRunEventState =
  | "Started"
  | "Queued"
  | "Running"
  | "Succeeded"
  | "Failed"
  | "Stopped"
  | "Timeout";

/**
 * Task-instance states MWAA Serverless publishes as
 * `MWAA Serverless Task {State}` detail-types.
 */
export type TaskEventState =
  | "Queued"
  | "Scheduled"
  | "Upstream Failed"
  | "Running"
  | "Succeeded"
  | "Failed"
  | "Up For Retry"
  | "Timeout";

const ALL_RUN_STATES: readonly WorkflowRunEventState[] = [
  "Started",
  "Queued",
  "Running",
  "Succeeded",
  "Failed",
  "Stopped",
  "Timeout",
];

export interface WorkflowRunEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "MWAAServerlessWorkflowRunEvents"
   */
  id?: string;
  /**
   * Which workflow-run state transitions to subscribe to, e.g. `["Failed"]`
   * to alert only on failures.
   * @default all run states
   */
  runStates?: readonly WorkflowRunEventState[];
  /**
   * Which task-instance state transitions to additionally subscribe to.
   * @default none
   */
  taskStates?: readonly TaskEventState[];
}

/**
 * Event source connecting Amazon MWAA Serverless notifications to the
 * hosting compute. MWAA Serverless publishes workflow-run state changes
 * (started, queued, running, succeeded, failed, stopped, timeout) and task
 * state changes to the account's default EventBridge bus (source
 * `aws.airflow-serverless`); this subscribes the host Function to those
 * events so it can alert on failed runs or chain follow-up work when a run
 * succeeds.
 *
 * MWAA Serverless publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Workflow Run Events
 * @example Alert On Failed Runs
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.MWAAServerless.consumeWorkflowRunEvents(
 *       { runStates: ["Failed", "Timeout"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.logError(
 *             `workflow run failed: ${event["detail-type"]}`,
 *             event.detail,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeWorkflowRunEvents = <StreamReq = never, Req = never>(
  props: WorkflowRunEventSourceProps,
  process: (
    events: Stream.Stream<WorkflowRunEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "MWAAServerlessWorkflowRunEvents",
    {
      source: ["aws.airflow-serverless"],
      "detail-type": [
        ...(props.runStates ?? ALL_RUN_STATES).map(
          (state) => `MWAA Serverless Workflow Run ${state}`,
        ),
        ...(props.taskStates ?? []).map(
          (state) => `MWAA Serverless Task ${state}`,
        ),
      ],
    },
    { description: props.description, state: props.state },
    process,
  );
