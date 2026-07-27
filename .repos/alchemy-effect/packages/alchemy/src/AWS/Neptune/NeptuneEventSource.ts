import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Neptune delivers to EventBridge. Neptune publishes
 * through the shared RDS eventing plane, so the shape is the RDS event
 * schema; every field is optional (the schema grows over time).
 */
export interface NeptuneEventDetail {
  /** Categories the event belongs to (e.g. `failover`, `maintenance`). */
  EventCategories?: string[];
  /** The kind of resource the event is about (e.g. `CLUSTER`, `DB_INSTANCE`). */
  SourceType?: string;
  /** ARN of the cluster/instance/snapshot the event is about. */
  SourceArn?: string;
  /** When the event occurred (ISO 8601). */
  Date?: string;
  /** RDS-plane event id, e.g. `RDS-EVENT-0170`. */
  EventID?: string;
  /** Identifier of the source resource. */
  SourceIdentifier?: string;
  /** Human-readable description of what happened. */
  Message?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Neptune EventBridge event delivered to the handler. */
export type NeptuneEvent = EventRecord<NeptuneEventDetail>;

/**
 * Which Neptune notifications to subscribe to. Each kind maps to one of the
 * detail-types the RDS eventing plane publishes to the account's default
 * bus on behalf of Neptune.
 */
export type NeptuneEventKind =
  | "db-cluster"
  | "db-instance"
  | "db-cluster-snapshot"
  | "db-parameter-group";

const DETAIL_TYPES: Record<NeptuneEventKind, string> = {
  "db-cluster": "RDS DB Cluster Event",
  "db-instance": "RDS DB Instance Event",
  "db-cluster-snapshot": "RDS DB Cluster Snapshot Event",
  "db-parameter-group": "RDS DB Parameter Group Event",
};

export interface NeptuneEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "NeptuneEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to.
   * @default all Neptune-relevant detail-types
   */
  kinds?: readonly NeptuneEventKind[];
  /**
   * Restrict to events about specific clusters, instances, or snapshots
   * (matched against the event's top-level `resources`, which carries the
   * resource ARNs). Strongly recommended — the `aws.rds` source also carries
   * events for RDS and DocumentDB resources in the account.
   */
  resourceArns?: readonly string[];
}

/**
 * Event source connecting Neptune notifications to the hosting compute.
 * Neptune publishes cluster, instance, snapshot, and parameter-group
 * lifecycle events — failovers, maintenance, backups, configuration changes
 * — through the shared RDS eventing plane to the account's default
 * EventBridge bus (source `aws.rds`); this subscribes the host Function to
 * those events so it can alert on failovers or react to completed
 * snapshots.
 *
 * Neptune publishes to EventBridge automatically — no additional resource
 * is created besides the EventBridge rule targeting the host. Because the
 * `aws.rds` source is shared with RDS and DocumentDB, pass `resourceArns`
 * (e.g. the cluster ARN) to scope the rule to your Neptune resources.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Neptune Events
 * @example Alert on Cluster Failovers
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const clusterArn = yield* cluster.dbClusterArn;
 *     yield* AWS.Neptune.consumeNeptuneEvents(
 *       { kinds: ["db-cluster"], resourceArns: [clusterArn] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.logError(
 *             `${event["detail-type"]}: ${event.detail.Message}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeNeptuneEvents = <StreamReq = never, Req = never>(
  props: NeptuneEventSourceProps,
  process: (
    events: Stream.Stream<NeptuneEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "NeptuneEvents",
    {
      source: ["aws.rds"],
      ...(props.kinds !== undefined
        ? { "detail-type": props.kinds.map((kind) => DETAIL_TYPES[kind]) }
        : {}),
      ...(props.resourceArns !== undefined
        ? { resources: [...props.resourceArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
