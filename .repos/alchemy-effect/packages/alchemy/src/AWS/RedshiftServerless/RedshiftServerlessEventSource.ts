import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Redshift Serverless delivers to EventBridge. Every
 * field is optional (the schema grows over time and varies by event kind).
 */
export interface RedshiftServerlessEventDetail {
  /** Categories the event belongs to (e.g. `configuration`, `monitoring`). */
  eventCategories?: string[];
  /** Severity of the event (e.g. `INFO`, `ERROR`). */
  severity?: string;
  /** Human-readable description of what happened. */
  eventMessage?: string;
  /** Identifier of the namespace/workgroup/snapshot the event is about. */
  sourceId?: string;
  /** The kind of resource the event is about (e.g. `NAMESPACE`, `WORKGROUP`). */
  sourceType?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Redshift Serverless EventBridge event delivered to the handler. */
export type RedshiftServerlessEvent =
  EventRecord<RedshiftServerlessEventDetail>;

export interface RedshiftServerlessEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "RedshiftServerlessEvents"
   */
  id?: string;
  /**
   * Restrict to specific EventBridge `detail-type`s (e.g.
   * `"Redshift Serverless Snapshot Event"`). Omit to receive every
   * detail-type the `aws.redshift-serverless` source publishes.
   */
  detailTypes?: readonly string[];
  /**
   * Restrict to events about specific namespaces, workgroups, or snapshots
   * (matched against the event's top-level `resources`, which carries the
   * resource ARNs). Recommended when the account hosts more than one
   * data warehouse.
   */
  resourceArns?: readonly string[];
}

/**
 * Event source connecting Redshift Serverless notifications to the hosting
 * compute. Redshift Serverless publishes namespace, workgroup, and snapshot
 * lifecycle events — capacity changes, completed snapshots, configuration
 * updates — to the account's default EventBridge bus (source
 * `aws.redshift-serverless`); this subscribes the host Function to those
 * events so it can react to completed snapshots or alert on workgroup
 * status changes.
 *
 * Redshift Serverless publishes to EventBridge automatically — no
 * additional resource is created besides the EventBridge rule targeting the
 * host. Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Redshift Serverless Events
 * @example React to Data Warehouse Events
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const namespaceArn = yield* namespace.namespaceArn;
 *     yield* AWS.RedshiftServerless.consumeRedshiftServerlessEvents(
 *       { resourceArns: [namespaceArn] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.logInfo(
 *             `${event["detail-type"]}: ${event.detail.eventMessage}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeRedshiftServerlessEvents = <StreamReq = never, Req = never>(
  props: RedshiftServerlessEventSourceProps,
  process: (
    events: Stream.Stream<RedshiftServerlessEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "RedshiftServerlessEvents",
    {
      source: ["aws.redshift-serverless"],
      ...(props.detailTypes !== undefined
        ? { "detail-type": [...props.detailTypes] }
        : {}),
      ...(props.resourceArns !== undefined
        ? { resources: [...props.resourceArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
