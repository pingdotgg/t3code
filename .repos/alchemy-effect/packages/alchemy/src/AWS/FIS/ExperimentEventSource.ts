import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS FIS delivers to EventBridge when an experiment
 * changes state. Delivery is best-effort and near real time; fields not
 * shared by every event are optional (the schema grows over time).
 */
export interface ExperimentEventDetail {
  /** The id of the experiment the event is about, e.g. `EXP1a2b3c4d`. */
  "experiment-id"?: string;
  /** The id of the template the experiment was started from. */
  "experiment-template-id"?: string;
  /** The state the experiment transitioned to. */
  "new-state"?: {
    /** e.g. `initiating`, `running`, `completed`, `stopped`, `failed`. */
    status?: string;
    /** Why the experiment entered this state. */
    reason?: string;
  };
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An AWS FIS EventBridge event delivered to the handler. */
export type ExperimentEvent = EventRecord<ExperimentEventDetail>;

export interface ExperimentEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "FISExperimentEvents"
   */
  id?: string;
  /**
   * Restrict to events about experiments started from specific templates
   * (matched against the event detail's `experiment-template-id`).
   */
  experimentTemplateIds?: readonly string[];
  /**
   * Restrict to specific experiment state transitions (matched against the
   * event detail's `new-state.status`), e.g. `["completed", "failed"]`.
   */
  statuses?: readonly string[];
}

/**
 * Event source connecting AWS Fault Injection Service experiment state
 * changes to the hosting compute. FIS publishes an event to the account's
 * default EventBridge bus (source `aws.fis`, detail-type
 * `FIS Experiment State Change`) whenever an experiment transitions state —
 * starts running, completes, stops, or fails — so a function can post
 * chaos-run reports or trigger follow-up verification the moment an
 * experiment finishes.
 *
 * FIS publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Experiment Events
 * @example Report When an Experiment Finishes
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default ReportFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.FIS.consumeExperimentEvents(
 *       { statuses: ["completed", "stopped", "failed"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `experiment ${event.detail["experiment-id"]} -> ` +
 *               `${event.detail["new-state"]?.status}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeExperimentEvents = <StreamReq = never, Req = never>(
  props: ExperimentEventSourceProps,
  process: (
    events: Stream.Stream<ExperimentEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "FISExperimentEvents",
    {
      source: ["aws.fis"],
      "detail-type": ["FIS Experiment State Change"],
      ...(props.experimentTemplateIds !== undefined ||
      props.statuses !== undefined
        ? {
            detail: {
              ...(props.experimentTemplateIds !== undefined
                ? { "experiment-template-id": [...props.experimentTemplateIds] }
                : {}),
              ...(props.statuses !== undefined
                ? { "new-state": { status: [...props.statuses] } }
                : {}),
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
