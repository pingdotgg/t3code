import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon EMR delivers to EventBridge when a cluster,
 * step, instance group/fleet, or auto-scaling policy changes state. EMR uses
 * camelCase keys; fields not shared by every event kind are optional (the
 * schema grows over time).
 */
export interface ClusterEventDetail {
  /** The id of the cluster the event is about (`j-…`). */
  clusterId?: string;
  /** The new state, e.g. `RUNNING`, `WAITING`, `TERMINATED`, `COMPLETED`. */
  state?: string;
  /** Event severity: `CRITICAL`, `ERROR`, or `INFO`. */
  severity?: string;
  /** Human-readable description of the state change. */
  message?: string;
  /** Cluster events: the cluster's name. Step events: the step's name. */
  name?: string;
  /** Cluster events: why the cluster changed state. */
  stateChangeReason?: string;
  /** Step events: the step's id (`s-…`). */
  stepId?: string;
  /** Step events: the step's configured action on failure. */
  actionOnFailure?: string;
  /** Instance-group events: the group's id (`ig-…`). */
  instanceGroupId?: string;
  /** Instance-fleet events: the fleet's id (`if-…`). */
  instanceFleetId?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An EMR EventBridge event delivered to the handler. */
export type ClusterEvent = EventRecord<ClusterEventDetail>;

/** Which EMR notifications to subscribe to. */
export type ClusterEventKind =
  | "cluster"
  | "step"
  | "instance-group"
  | "instance-fleet"
  | "auto-scaling";

const DETAIL_TYPES: Record<ClusterEventKind, string> = {
  cluster: "EMR Cluster State Change",
  step: "EMR Step Status Change",
  "instance-group": "EMR Instance Group State Change",
  "instance-fleet": "EMR Instance Fleet State Change",
  "auto-scaling": "EMR Auto Scaling Policy State Change",
};

export interface ClusterEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "EMRClusterEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: cluster state changes, step status
   * changes, instance group/fleet state changes, auto-scaling policy state
   * changes, or any combination.
   * @default ["cluster"]
   */
  kinds?: readonly ClusterEventKind[];
  /**
   * Restrict to events about specific clusters (matched against the event's
   * `clusterId`).
   */
  clusterIds?: readonly string[];
}

/**
 * Event source connecting Amazon EMR notifications to the hosting compute.
 * EMR publishes every cluster state change, step status change, instance
 * group/fleet state change, and auto-scaling policy state change to the
 * account's default EventBridge bus (source `aws.emr`); this subscribes the
 * host Function to those events so it can alert on failed steps or chain
 * post-cluster automation.
 *
 * EMR publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Cluster Events
 * @example Alert On Failed Steps
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.EMR.consumeClusterEvents(
 *       { kinds: ["step"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.state === "FAILED"
 *             ? Effect.log(`step ${event.detail.stepId} failed`)
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeClusterEvents = <StreamReq = never, Req = never>(
  props: ClusterEventSourceProps,
  process: (
    events: Stream.Stream<ClusterEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "EMRClusterEvents",
    {
      source: ["aws.emr"],
      "detail-type": (props.kinds ?? (["cluster"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.clusterIds !== undefined
        ? { detail: { clusterId: [...props.clusterIds] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
