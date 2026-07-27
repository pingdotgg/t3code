import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload OpenSearch Service delivers to EventBridge. The schema
 * is loosely specified and differs slightly per event kind, so every field is
 * optional (the schema grows over time).
 */
export interface DomainEventDetail {
  /** The event that occurred, e.g. `"Service Software Update"`. */
  event?: string;
  /** Status of the event, e.g. `"Available"`, `"Completed"`, `"Failed"`. */
  status?: string;
  /** Severity of the event: `"Informational"`, `"Low"`, `"Medium"`, `"High"`. */
  severity?: string;
  /** Human-readable description of what happened. */
  description?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An OpenSearch Service EventBridge event delivered to the handler. */
export type DomainEvent = EventRecord<DomainEventDetail>;

/**
 * Which OpenSearch Service notifications to subscribe to. Each kind maps to
 * one of the detail-types OpenSearch publishes to the account's default bus.
 */
export type DomainEventKind =
  | "software-update"
  | "auto-tune"
  | "cluster-status"
  | "domain-update"
  | "vpc-endpoint"
  | "node-retirement"
  | "dry-run-progress";

const DETAIL_TYPES: Record<DomainEventKind, string> = {
  "software-update": "Amazon OpenSearch Service Software Update Notification",
  "auto-tune": "Amazon OpenSearch Service Auto-Tune Notification",
  "cluster-status": "Amazon OpenSearch Service Cluster Status Notification",
  "domain-update": "Amazon OpenSearch Service Domain Update Notification",
  "vpc-endpoint": "Amazon OpenSearch Service VPC Endpoint Notification",
  "node-retirement": "Amazon OpenSearch Service Node Retirement Notification",
  "dry-run-progress": "Amazon OpenSearch Service Dry Run Progress Notification",
};

export interface DomainEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "OpenSearchDomainEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to.
   * @default all OpenSearch Service detail-types
   */
  kinds?: readonly DomainEventKind[];
  /**
   * Restrict to events about specific domains (matched against the event's
   * top-level `resources`, which carries the domain ARNs).
   */
  domainArns?: readonly string[];
}

/**
 * Event source connecting OpenSearch Service notifications to the hosting
 * compute. OpenSearch publishes domain lifecycle events — available and
 * completed service software updates, Auto-Tune optimizations, cluster
 * health transitions (e.g. a red cluster or blocked writes), VPC endpoint
 * changes, node retirements, and blue/green update progress — to the
 * account's default EventBridge bus (source `aws.es`); this subscribes the
 * host Function to those events so it can alert on degraded clusters or
 * auto-approve pending software updates.
 *
 * OpenSearch publishes to EventBridge automatically — no additional resource
 * is created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Domain Events
 * @example Alert When a Cluster Degrades or an Update Fails
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.OpenSearch.consumeDomainEvents(
 *       { kinds: ["cluster-status", "software-update"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.logError(
 *             `${event.detail.event}: ${event.detail.description}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeDomainEvents = <StreamReq = never, Req = never>(
  props: DomainEventSourceProps,
  process: (
    events: Stream.Stream<DomainEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "OpenSearchDomainEvents",
    {
      source: ["aws.es"],
      ...(props.kinds !== undefined
        ? { "detail-type": props.kinds.map((kind) => DETAIL_TYPES[kind]) }
        : {}),
      ...(props.domainArns !== undefined
        ? { resources: [...props.domainArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
