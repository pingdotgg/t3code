import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS Deadline Cloud delivers to EventBridge. Every
 * event kind identifies the farm and the affected resource (queue, job,
 * step, task, fleet, worker, or budget); status-change events carry the
 * previous and new status. Fields not shared by every event kind are
 * optional (the schema grows over time).
 */
export interface FarmEventDetail {
  /** The farm the event is about. */
  farmId?: string;
  /** Job/step/task and budget events: the queue the resource belongs to. */
  queueId?: string;
  /** Job/step/task events: the job the event is about. */
  jobId?: string;
  /** Step/task events: the step the event is about. */
  stepId?: string;
  /** Task events: the task the event is about. */
  taskId?: string;
  /** Fleet and worker events: the fleet the event is about. */
  fleetId?: string;
  /** Worker events: the worker the event is about. */
  workerId?: string;
  /** Budget Threshold Reached: the budget that crossed a threshold. */
  budgetId?: string;
  /** Status-change events: the status before the transition. */
  previousStatus?: string;
  /** Status-change events: the status after the transition. */
  status?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Deadline Cloud EventBridge event delivered to the handler. */
export type FarmEvent = EventRecord<FarmEventDetail>;

/** Which Deadline Cloud notifications to subscribe to. */
export type FarmEventKind =
  | "job-lifecycle"
  | "job-run"
  | "step-lifecycle"
  | "step-run"
  | "task-run"
  | "budget-threshold"
  | "fleet-size-recommendation"
  | "worker-unhealthy";

const DETAIL_TYPES: Record<FarmEventKind, string> = {
  "job-lifecycle": "Job Lifecycle Status Change",
  "job-run": "Job Run Status Change",
  "step-lifecycle": "Step Lifecycle Status Change",
  "step-run": "Step Run Status Change",
  "task-run": "Task Run Status Change",
  "budget-threshold": "Budget Threshold Reached",
  "fleet-size-recommendation": "Fleet Size Recommendation Change",
  "worker-unhealthy": "Worker Status Unhealthy",
};

export interface FarmEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "DeadlineFarmEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: job/step lifecycle and run status
   * changes, task run status changes, budget threshold crossings, fleet
   * size recommendations, and unhealthy-worker reports.
   * @default ["job-run"]
   */
  kinds?: readonly FarmEventKind[];
  /**
   * Restrict to events about specific farms (matched against the event
   * detail's `farmId`).
   */
  farmIds?: readonly string[];
}

/**
 * Event source connecting AWS Deadline Cloud notifications to the hosting
 * compute. Deadline Cloud publishes job/step/task status changes, budget
 * threshold crossings, fleet size recommendations, and unhealthy-worker
 * reports to the account's default EventBridge bus (source `aws.deadline`);
 * this subscribes the host Function to those events so it can react to
 * finished renders or runaway spend.
 *
 * Deadline Cloud publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Farm Events
 * @example Alert When A Job Finishes
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default RenderAlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Deadline.consumeFarmEvents(
 *       { kinds: ["job-run"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.status === "SUCCEEDED"
 *             ? Effect.log(`render ${event.detail.jobId} finished`)
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 *
 * @example Stop The Farm On A Budget Threshold
 * ```typescript
 * yield* AWS.Deadline.consumeFarmEvents(
 *   { kinds: ["budget-threshold"], farmIds: [farm.farmId] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.logWarning(`budget ${event.detail.budgetId} threshold hit`),
 *     ),
 * );
 * ```
 */
export const consumeFarmEvents = <StreamReq = never, Req = never>(
  props: FarmEventSourceProps,
  process: (
    events: Stream.Stream<FarmEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "DeadlineFarmEvents",
    {
      source: ["aws.deadline"],
      "detail-type": (props.kinds ?? (["job-run"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.farmIds !== undefined
        ? { detail: { farmId: [...props.farmIds] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
