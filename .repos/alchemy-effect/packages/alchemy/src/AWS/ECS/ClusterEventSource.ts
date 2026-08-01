import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon ECS delivers to EventBridge. Task state-change
 * events carry the task's shape (`lastStatus`, `stoppedReason`, `containers`,
 * …); container-instance state-change events carry the instance's shape;
 * deployment and service-action events carry `eventName`/`reason`. Fields not
 * shared by every event kind are optional (the schema grows over time).
 */
export interface ClusterEventDetail {
  /** ARN of the cluster the event's resource belongs to. */
  clusterArn?: string;
  /** Task events: the state the task transitioned to (e.g. `STOPPED`). */
  lastStatus?: string;
  /** Task events: desired state of the task. */
  desiredStatus?: string;
  /** Task events: why the task stopped. */
  stoppedReason?: string;
  /** Task events: ARN of the task. */
  taskArn?: string;
  /** Task events: what started the task (e.g. `ecs-svc/…` for services). */
  startedBy?: string;
  /** Deployment / service-action events: the event name (e.g. `SERVICE_DEPLOYMENT_COMPLETED`). */
  eventName?: string;
  /** Deployment / service-action events: human-readable reason. */
  reason?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An ECS EventBridge event delivered to the handler. */
export type ClusterEvent = EventRecord<ClusterEventDetail>;

/** Which ECS notifications to subscribe to. */
export type ClusterEventKind =
  | "task-state-change"
  | "container-instance-state-change"
  | "deployment-state-change"
  | "service-action";

const DETAIL_TYPES: Record<ClusterEventKind, string> = {
  "task-state-change": "ECS Task State Change",
  "container-instance-state-change": "ECS Container Instance State Change",
  "deployment-state-change": "ECS Deployment State Change",
  "service-action": "ECS Service Action",
};

export interface ClusterEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "EcsClusterEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: task state changes, container
   * instance state changes, deployment state changes, and/or service
   * actions.
   * @default ["task-state-change"]
   */
  kinds?: readonly ClusterEventKind[];
  /**
   * Restrict to events about specific clusters, matched against the event
   * detail's `clusterArn`.
   */
  clusterArns?: readonly string[];
}

/**
 * Event source connecting Amazon ECS notifications to the hosting compute.
 * ECS publishes task state changes, container-instance state changes,
 * deployment state changes, and service actions to the account's default
 * EventBridge bus (source `aws.ecs`); this subscribes the host Function to
 * those events so it can react when a task stops, a deployment completes or
 * rolls back, or an instance drops out.
 *
 * ECS publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Cluster Events
 * @example React When A Task Stops
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.ECS.consumeClusterEvents(
 *       { kinds: ["task-state-change"], clusterArns: [cluster.clusterArn] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.lastStatus === "STOPPED"
 *             ? Effect.logError(`task stopped: ${event.detail.stoppedReason}`)
 *             : Effect.log(`task ${event.detail.lastStatus}`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 *
 * @example Alert On Failed Deployments
 * ```typescript
 * yield* AWS.ECS.consumeClusterEvents(
 *   { kinds: ["deployment-state-change"] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       event.detail.eventName === "SERVICE_DEPLOYMENT_FAILED"
 *         ? Effect.logError(`deployment failed: ${event.detail.reason}`)
 *         : Effect.void,
 *     ),
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
    props.id ?? "EcsClusterEvents",
    {
      source: ["aws.ecs"],
      "detail-type": (props.kinds ?? (["task-state-change"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.clusterArns !== undefined
        ? { detail: { clusterArn: [...props.clusterArns] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
