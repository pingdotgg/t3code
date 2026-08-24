import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload CloudFormation delivers to EventBridge when a stack,
 * resource, drift detection, or StackSet changes status. CloudFormation uses
 * hyphenated keys; fields not shared by every event kind are optional (the
 * schema grows over time).
 */
export interface StackEventDetail {
  /** The ARN of the stack the event is about. */
  "stack-id"?: string;
  /** Resource events: the logical id of the resource within the stack. */
  "logical-resource-id"?: string;
  /** Resource events: the physical id of the resource. */
  "physical-resource-id"?: string;
  /** Resource events: the resource type, e.g. `AWS::SNS::Topic`. */
  "resource-type"?: string;
  /** Drift events: the drift detection run id. */
  "stack-drift-detection-id"?: string;
  /** The new status and reason. */
  "status-details"?: {
    /** The new status, e.g. `CREATE_COMPLETE`, `UPDATE_ROLLBACK_COMPLETE`. */
    status?: string;
    /** Human-readable reason accompanying the status, when present. */
    "status-reason"?: string;
    [key: string]: unknown;
  };
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A CloudFormation EventBridge event delivered to the handler. */
export type StackEvent = EventRecord<StackEventDetail>;

/** Which CloudFormation status-change events to subscribe to. */
export type StackEventKind =
  | "stack"
  | "resource"
  | "drift-detection"
  | "stack-set"
  | "stack-set-operation"
  | "stack-set-stack-instance";

const DETAIL_TYPES: Record<StackEventKind, string> = {
  stack: "CloudFormation Stack Status Change",
  resource: "CloudFormation Resource Status Change",
  "drift-detection": "CloudFormation Drift Detection Status Change",
  "stack-set": "CloudFormation StackSet Status Change",
  "stack-set-operation": "CloudFormation StackSet Operation Status Change",
  "stack-set-stack-instance":
    "CloudFormation StackSet StackInstance Status Change",
};

export interface StackEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "CloudFormationEvents"
   */
  id?: string;
  /**
   * Which status-change events to subscribe to.
   * @default all kinds
   */
  kinds?: readonly StackEventKind[];
  /**
   * Restrict to events about specific stacks (matched against the event's
   * `stack-id`, the stack ARN).
   */
  stackIds?: readonly string[];
}

/**
 * Event source connecting CloudFormation status changes to the hosting
 * compute. CloudFormation publishes every stack, resource, drift-detection,
 * and StackSet status change to the account's default EventBridge bus
 * (source `aws.cloudformation`); this subscribes the host Function to those
 * events so it can alert on failed deployments or chain post-deploy
 * automation.
 *
 * CloudFormation publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer
 * (e.g. `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Stack Events
 * @example Alert On Failed Stack Operations
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.CloudFormation.consumeStackEvents(
 *       { kinds: ["stack"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail["status-details"]?.status?.endsWith("_FAILED")
 *             ? Effect.log(`stack ${event.detail["stack-id"]} failed`)
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeStackEvents = <StreamReq = never, Req = never>(
  props: StackEventSourceProps,
  process: (
    events: Stream.Stream<StackEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "CloudFormationEvents",
    {
      source: ["aws.cloudformation"],
      "detail-type": (
        props.kinds ?? (Object.keys(DETAIL_TYPES) as StackEventKind[])
      ).map((kind) => DETAIL_TYPES[kind]),
      ...(props.stackIds !== undefined
        ? { detail: { "stack-id": [...props.stackIds] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
