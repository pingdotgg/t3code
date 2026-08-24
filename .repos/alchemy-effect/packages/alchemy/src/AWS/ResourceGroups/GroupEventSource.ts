import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS Resource Groups delivers to EventBridge for
 * group lifecycle events. State-change events describe the group create/
 * update/delete; membership-change events describe resources entering or
 * leaving a group. Fields not shared by every event kind are optional (the
 * schema grows over time).
 */
export interface GroupEventDetail {
  /** Monotonic ordering hint for events about the same group. */
  "event-sequence"?: number;
  /** State-change events: the transition, e.g. `create`, `update`, `delete`. */
  "state-change"?: string;
  /** The group the event is about (`arn`, `name`, …). */
  group?: {
    arn?: string;
    name?: string;
    [key: string]: unknown;
  };
  /** Membership-change events: the resources that entered or left the group. */
  resources?: {
    arn?: string;
    "membership-change"?: string;
    [key: string]: unknown;
  }[];
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Resource Groups EventBridge event delivered to the handler. */
export type GroupEvent = EventRecord<GroupEventDetail>;

/** Which Resource Groups group lifecycle notifications to subscribe to. */
export type GroupEventKind = "state-change" | "membership-change";

const DETAIL_TYPES: Record<GroupEventKind, string> = {
  "state-change": "ResourceGroups Group State Change",
  "membership-change": "ResourceGroups Group Membership Change",
};

export interface GroupEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "ResourceGroupsGroupEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: group state changes (create /
   * update / delete) and/or membership changes (resources entering or
   * leaving a group).
   * @default ["state-change", "membership-change"]
   */
  kinds?: readonly GroupEventKind[];
  /**
   * Restrict to events about specific groups (matched against the event's
   * top-level `resources`, which carries the group ARN).
   */
  groupArns?: readonly string[];
}

/**
 * Event source connecting AWS Resource Groups group lifecycle events to
 * the hosting compute. When the account setting `GroupLifecycleEvents` is
 * `ACTIVE` (one-time opt-in via `UpdateAccountSettings`; check with the
 * {@link GetAccountSettings} binding), Resource Groups publishes group
 * state changes and membership changes to the account's default
 * EventBridge bus (source `aws.resource-groups`); this subscribes the host
 * Function to those events so it can react to resources entering or
 * leaving a group.
 *
 * Resource Groups publishes to EventBridge automatically once the account
 * setting is active — no additional resource is created besides the
 * EventBridge rule targeting the host. Provide the host-specific
 * implementation layer (e.g. `AWS.Lambda.EventSource`) on the Function
 * effect.
 *
 * @section Consuming Group Lifecycle Events
 * @example React To Membership Changes
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default MembershipFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.ResourceGroups.consumeGroupEvents(
 *       { kinds: ["membership-change"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `group ${event.detail.group?.name} membership changed`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeGroupEvents = <StreamReq = never, Req = never>(
  props: GroupEventSourceProps,
  process: (
    events: Stream.Stream<GroupEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "ResourceGroupsGroupEvents",
    {
      source: ["aws.resource-groups"],
      "detail-type": (
        props.kinds ?? (["state-change", "membership-change"] as const)
      ).map((kind) => DETAIL_TYPES[kind]),
      ...(props.groupArns !== undefined
        ? { resources: [...props.groupArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
