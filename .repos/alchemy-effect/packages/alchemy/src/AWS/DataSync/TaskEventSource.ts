import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS DataSync delivers to EventBridge. Task
 * state-change events describe the task's new state (`AVAILABLE`,
 * `RUNNING`, `UNAVAILABLE`, `QUEUED`); task-execution state-change events
 * describe the run's transfer phase (`LAUNCHING`, `PREPARING`,
 * `TRANSFERRING`, `VERIFYING`, `SUCCESS`, `ERROR`). Fields not shared by
 * every event kind are optional (the schema grows over time).
 */
export interface TaskEventDetail {
  /** The state the task or task execution transitioned to. */
  State?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A DataSync EventBridge event delivered to the handler. */
export type TaskEvent = EventRecord<TaskEventDetail>;

/** Which DataSync notifications to subscribe to. */
export type TaskEventKind = "task-state-change" | "task-execution-state-change";

const DETAIL_TYPES: Record<TaskEventKind, string> = {
  "task-state-change": "DataSync Task State Change",
  "task-execution-state-change": "DataSync Task Execution State Change",
};

export interface TaskEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "DataSyncTaskEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: task state changes (e.g. a task
   * becoming `UNAVAILABLE`) and/or task-execution state changes (a run
   * progressing through `LAUNCHING` → … → `SUCCESS`/`ERROR`).
   * @default ["task-execution-state-change"]
   */
  kinds?: readonly TaskEventKind[];
  /**
   * Restrict to events about specific tasks. Matched as a prefix against
   * the event's top-level `resources`, so a task ARN also matches its
   * execution ARNs (`{taskArn}/execution/{id}`).
   */
  taskArns?: readonly string[];
}

/**
 * Event source connecting AWS DataSync notifications to the hosting
 * compute. DataSync publishes task state changes and task-execution state
 * changes to the account's default EventBridge bus (source `aws.datasync`);
 * this subscribes the host Function to those events so it can react when a
 * transfer finishes, fails, or a task drops offline.
 *
 * DataSync publishes to EventBridge automatically — no additional resource
 * is created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Task Events
 * @example React When A Transfer Finishes
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.DataSync.consumeTaskEvents(
 *       { kinds: ["task-execution-state-change"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.State === "ERROR"
 *             ? Effect.logError(`transfer failed: ${event.resources[0]}`)
 *             : Effect.log(`transfer ${event.detail.State}`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeTaskEvents = <StreamReq = never, Req = never>(
  props: TaskEventSourceProps,
  process: (
    events: Stream.Stream<TaskEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "DataSyncTaskEvents",
    {
      source: ["aws.datasync"],
      "detail-type": (
        props.kinds ?? (["task-execution-state-change"] as const)
      ).map((kind) => DETAIL_TYPES[kind]),
      ...(props.taskArns !== undefined
        ? { resources: props.taskArns.map((arn) => ({ prefix: arn })) }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
