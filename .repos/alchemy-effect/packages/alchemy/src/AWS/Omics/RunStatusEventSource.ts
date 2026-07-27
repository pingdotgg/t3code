import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon HealthOmics delivers to EventBridge when a
 * workflow run changes state (`Run Status Change`, source `aws.omics`). Which
 * fields are present depends on the event, so everything run-specific is
 * optional.
 */
export interface OmicsRunEventDetail {
  /** The run's id. */
  id?: string;
  /** ARN of the run. */
  arn?: string;
  /** The run status: `PENDING`, `STARTING`, `RUNNING`, `STOPPING`, `COMPLETED`, `DELETED`, `CANCELLED`, or `FAILED`. */
  status?: string;
  /** The id of the workflow the run executes. */
  workflowId?: string;
  /** The id of the run group the run belongs to, if any. */
  runGroupId?: string;
  /** A human-readable status message (populated on `FAILED`). */
  statusMessage?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A HealthOmics run EventBridge event delivered to the handler. */
export type OmicsRunEvent = EventRecord<OmicsRunEventDetail>;

export interface RunStatusEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "OmicsRunStatusEvents"
   */
  id?: string;
  /**
   * Only deliver events with these `detail.status` values (e.g.
   * `["COMPLETED", "FAILED"]`).
   * @default all statuses
   */
  statuses?: readonly string[];
}

/**
 * Event source connecting Amazon HealthOmics run state changes to the hosting
 * compute. HealthOmics publishes every run state transition (`Run Status
 * Change`, source `aws.omics`) to the account's default EventBridge bus; this
 * subscribes the host Function to those events so it can chain post-run
 * automation (fetch outputs, kick off downstream analysis) or alert on
 * `FAILED` runs.
 *
 * HealthOmics publishes to EventBridge automatically — no additional resource
 * is created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Run Events
 * @example React To Finished Runs
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default RunReactor.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Omics.consumeRunEvents(
 *       { statuses: ["COMPLETED", "FAILED"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.status === "FAILED"
 *             ? Effect.log(`run ${event.detail.id} failed: ${event.detail.statusMessage}`)
 *             : Effect.log(`run ${event.detail.id} complete`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeRunEvents = <StreamReq = never, Req = never>(
  props: RunStatusEventSourceProps,
  process: (
    events: Stream.Stream<OmicsRunEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "OmicsRunStatusEvents",
    {
      source: ["aws.omics"],
      "detail-type": ["Run Status Change"],
      ...(props.statuses ? { detail: { status: [...props.statuses] } } : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
