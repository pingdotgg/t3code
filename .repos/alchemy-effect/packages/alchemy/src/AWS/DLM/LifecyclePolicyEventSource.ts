import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon Data Lifecycle Manager delivers to
 * EventBridge. State-change events describe the transition (`state`,
 * `cause`, `policy_id`); pre/post script events describe the script
 * execution outcome. Fields not shared by every event kind are optional
 * (the schema grows over time).
 */
export interface LifecyclePolicyEventDetail {
  /**
   * State-change events: the state the policy transitioned to, e.g.
   * `ERROR` when the execution role was deleted out-of-band.
   */
  state?: string;
  /** State-change events: why the policy changed state. */
  cause?: string;
  /** The id or ARN of the lifecycle policy the event is about. */
  policy_id?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Data Lifecycle Manager EventBridge event delivered to the handler. */
export type LifecyclePolicyEvent = EventRecord<LifecyclePolicyEventDetail>;

/** Which Data Lifecycle Manager notifications to subscribe to. */
export type LifecyclePolicyEventKind = "state-change" | "pre-post-script";

const DETAIL_TYPES: Record<LifecyclePolicyEventKind, string> = {
  "state-change": "DLM Policy State Change",
  "pre-post-script": "DLM Pre Post Script Notification",
};

export interface LifecyclePolicyEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "DLMPolicyEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: policy state changes (e.g. a
   * policy entering `ERROR`) and/or pre/post script execution reports.
   * @default ["state-change"]
   */
  kinds?: readonly LifecyclePolicyEventKind[];
  /**
   * Restrict to events about specific lifecycle policies (matched against
   * the event's top-level `resources`, which includes the policy's ARN).
   */
  policyArns?: readonly string[];
}

/**
 * Event source connecting Amazon Data Lifecycle Manager notifications to
 * the hosting compute. DLM publishes lifecycle policy state changes (most
 * importantly a policy dropping into `ERROR` and no longer creating
 * snapshots) and pre/post script execution reports to the account's
 * default EventBridge bus (source `aws.dlm`); this subscribes the host
 * Function to those events so it can alert on stalled backup policies.
 *
 * DLM publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on
 * the Function effect.
 *
 * @section Consuming Lifecycle Policy Events
 * @example Alert When A Policy Stops Running
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.DLM.consumePolicyEvents(
 *       { kinds: ["state-change"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.state === "ERROR"
 *             ? Effect.logError(
 *                 `DLM policy ${event.detail.policy_id} failed: ${event.detail.cause}`,
 *               )
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumePolicyEvents = <StreamReq = never, Req = never>(
  props: LifecyclePolicyEventSourceProps,
  process: (
    events: Stream.Stream<LifecyclePolicyEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "DLMPolicyEvents",
    {
      source: ["aws.dlm"],
      "detail-type": (props.kinds ?? (["state-change"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.policyArns !== undefined
        ? { resources: [...props.policyArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
