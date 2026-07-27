import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";
import type { StateMachine } from "./StateMachine.ts";

/**
 * The `detail` payload Step Functions delivers to EventBridge when an
 * execution changes status (`Step Functions Execution Status Change`).
 * Fields not shared by every status are optional (the schema grows over
 * time).
 */
export interface ExecutionEventDetail {
  /** The execution's ARN (`arn:…:execution:{machine}:{name}`). */
  executionArn?: string;
  /** ARN of the state machine the execution belongs to. */
  stateMachineArn?: string;
  /** The execution name. */
  name?: string;
  /** The new status: `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `ABORTED`. */
  status?: string;
  /** Epoch millis the execution started. */
  startDate?: number;
  /** Epoch millis the execution stopped (terminal statuses only). */
  stopDate?: number | null;
  /** The execution input (JSON string), when execution data is included. */
  input?: string | null;
  /** The execution output (JSON string) on `SUCCEEDED`, else `null`. */
  output?: string | null;
  /** The `Error` name on `FAILED`/`TIMED_OUT`, when present. */
  error?: string | null;
  /** The `Cause` string on `FAILED`/`TIMED_OUT`, when present. */
  cause?: string | null;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Step Functions EventBridge event delivered to the handler. */
export type ExecutionEvent = EventRecord<ExecutionEventDetail>;

/** An execution status a subscription can filter on. */
export type ExecutionEventStatus =
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "ABORTED";

export interface ExecutionEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "SfnExecutionEvents"
   */
  id?: string;
  /**
   * Restrict the subscription to executions of specific state machines.
   * Omit to receive status changes for every state machine in the
   * account/region.
   */
  stateMachines?: readonly StateMachine[];
  /**
   * Which execution statuses to subscribe to.
   * @default all statuses
   */
  statuses?: readonly ExecutionEventStatus[];
}

/**
 * Event source connecting Step Functions execution status changes to the
 * hosting compute. Step Functions publishes every STANDARD execution status
 * transition to the account's default EventBridge bus (source `aws.states`,
 * detail-type `Step Functions Execution Status Change`); this subscribes
 * the host Function to those events so it can alert on `FAILED` executions
 * or chain post-completion automation.
 *
 * Step Functions publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * `EXPRESS` workflows do not emit execution status change events.
 *
 * @section Consuming Execution Events
 * @example Alert On Failed Executions
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.StepFunctions.consumeExecutionEvents(
 *       { stateMachines: [orderWorkflow], statuses: ["FAILED", "TIMED_OUT"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(`execution ${event.detail.executionArn} failed`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeExecutionEvents = <StreamReq = never, Req = never>(
  props: ExecutionEventSourceProps,
  process: (
    events: Stream.Stream<ExecutionEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "SfnExecutionEvents",
    {
      source: ["aws.states"],
      "detail-type": ["Step Functions Execution Status Change"],
      ...(props.stateMachines !== undefined && props.stateMachines.length > 0
        ? props.statuses !== undefined && props.statuses.length > 0
          ? {
              detail: {
                stateMachineArn: props.stateMachines.map(
                  (machine) => machine.stateMachineArn,
                ),
                status: [...props.statuses],
              },
            }
          : {
              detail: {
                stateMachineArn: props.stateMachines.map(
                  (machine) => machine.stateMachineArn,
                ),
              },
            }
        : props.statuses !== undefined && props.statuses.length > 0
          ? { detail: { status: [...props.statuses] } }
          : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
