import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload RDS delivers to EventBridge. Every field is optional
 * (the schema grows over time).
 */
export interface RdsEventDetail {
  /** Categories the event belongs to (e.g. `failover`, `backup`). */
  EventCategories?: string[];
  /** The kind of resource the event is about (e.g. `CLUSTER`, `DB_INSTANCE`). */
  SourceType?: string;
  /** ARN of the instance/cluster/snapshot the event is about. */
  SourceArn?: string;
  /** When the event occurred (ISO 8601). */
  Date?: string;
  /** RDS event id, e.g. `RDS-EVENT-0170`. */
  EventID?: string;
  /** Identifier of the source resource. */
  SourceIdentifier?: string;
  /** Human-readable description of what happened. */
  Message?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An RDS EventBridge event delivered to the handler. */
export type RdsEvent = EventRecord<RdsEventDetail>;

/**
 * Which RDS notifications to subscribe to. Each kind maps to one of the
 * detail-types RDS publishes to the account's default bus.
 */
export type RdsEventKind =
  | "db-instance"
  | "db-cluster"
  | "db-snapshot"
  | "db-cluster-snapshot"
  | "db-parameter-group"
  | "db-security-group"
  | "db-proxy"
  | "blue-green-deployment";

const DETAIL_TYPES: Record<RdsEventKind, string> = {
  "db-instance": "RDS DB Instance Event",
  "db-cluster": "RDS DB Cluster Event",
  "db-snapshot": "RDS DB Snapshot Event",
  "db-cluster-snapshot": "RDS DB Cluster Snapshot Event",
  "db-parameter-group": "RDS DB Parameter Group Event",
  "db-security-group": "RDS DB Security Group Event",
  "db-proxy": "RDS DB Proxy Event",
  "blue-green-deployment": "RDS Blue Green Deployment Event",
};

export interface RdsEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "RdsEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to.
   * @default all RDS detail-types
   */
  kinds?: readonly RdsEventKind[];
  /**
   * Restrict to events about specific instances, clusters, or snapshots
   * (matched against the event's top-level `resources`, which carries the
   * resource ARNs). Strongly recommended — the `aws.rds` source also
   * carries events for Neptune and DocumentDB resources in the account.
   */
  resourceArns?: readonly string[];
}

/**
 * Event source connecting RDS notifications to the hosting compute. RDS
 * publishes instance, cluster, snapshot, parameter-group, and proxy
 * lifecycle events — failovers, maintenance, completed backups,
 * configuration changes — to the account's default EventBridge bus (source
 * `aws.rds`); this subscribes the host Function to those events so it can
 * alert on failovers or react to completed snapshots.
 *
 * RDS publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Because the
 * `aws.rds` source is shared with Neptune and DocumentDB, pass
 * `resourceArns` (e.g. the cluster ARN) to scope the rule to your RDS
 * resources. Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming RDS Events
 * @example Alert on Cluster Failovers
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const clusterArn = yield* cluster.dbClusterArn;
 *     yield* AWS.RDS.consumeRdsEvents(
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
export const consumeRdsEvents = <StreamReq = never, Req = never>(
  props: RdsEventSourceProps,
  process: (
    events: Stream.Stream<RdsEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "RdsEvents",
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
