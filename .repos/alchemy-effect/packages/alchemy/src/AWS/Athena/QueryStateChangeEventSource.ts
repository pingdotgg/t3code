import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * A query execution state, as reported in the EventBridge event detail.
 */
export type QueryState =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

/**
 * The `detail` payload Athena delivers to EventBridge on every query
 * execution state transition (`Athena Query State Change`).
 */
export interface QueryStateChangeDetail {
  /** The state the query transitioned into. */
  currentState: QueryState;
  /** The state the query transitioned out of (absent on the first event). */
  previousState?: QueryState;
  /** Id of the query execution. */
  queryExecutionId: string;
  /** Statement type: `DDL`, `DML`, or `UTILITY`. */
  statementType?: string;
  /** Name of the workgroup the query ran in. */
  workgroupName?: string;
  /** Monotonic sequence number of this transition within the execution. */
  sequenceNumber?: string;
  /** Version of the event schema. */
  versionId?: string;
  /** Error details when `currentState` is `FAILED`. */
  athenaError?: {
    errorCategory?: number;
    errorType?: number;
    errorMessage?: string;
    retryable?: boolean;
  };
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An Athena query state change EventBridge event delivered to the handler. */
export type QueryStateChangeEvent = EventRecord<QueryStateChangeDetail>;

export interface QueryStateChangesProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "AthenaQueryStateChanges"
   */
  id?: string;
  /**
   * Only deliver transitions into these states (e.g. `["SUCCEEDED",
   * "FAILED"]` for terminal outcomes).
   * @default all states
   */
  states?: QueryState[];
  /**
   * Only deliver events for queries that ran in these workgroups (by name).
   * @default all workgroups
   */
  workGroups?: string[];
}

/**
 * Event source connecting Athena query state changes to the hosting compute.
 * Athena publishes every query execution state transition to the account's
 * default EventBridge bus (source `aws.athena`, detail-type `Athena Query
 * State Change`); this subscribes the host Function to those events so it can
 * react to completed or failed queries without polling.
 *
 * Athena publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Query State Changes
 * @example React to Terminal Query Outcomes
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default EtlFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Athena.consumeQueryStateChanges(
 *       { states: ["SUCCEEDED", "FAILED"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `query ${event.detail.queryExecutionId} → ${event.detail.currentState}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeQueryStateChanges = <StreamReq = never, Req = never>(
  props: QueryStateChangesProps,
  process: (
    events: Stream.Stream<QueryStateChangeEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "AthenaQueryStateChanges",
    {
      source: ["aws.athena"],
      "detail-type": ["Athena Query State Change"],
      ...(props.states || props.workGroups
        ? {
            detail: {
              ...(props.states ? { currentState: [...props.states] } : {}),
              ...(props.workGroups
                ? { workgroupName: [...props.workGroups] }
                : {}),
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
