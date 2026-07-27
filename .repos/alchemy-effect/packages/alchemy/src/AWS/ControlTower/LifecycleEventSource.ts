import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The documented AWS Control Tower lifecycle event names — one per
 * completed Control Tower action (account provisioning, guardrail
 * enablement, landing zone setup, OU registration).
 */
export type ControlTowerLifecycleEventName =
  | "CreateManagedAccount"
  | "UpdateManagedAccount"
  | "EnableGuardrail"
  | "DisableGuardrail"
  | "SetupLandingZone"
  | "UpdateLandingZone"
  | "RegisterOrganizationalUnit"
  | "DeregisterOrganizationalUnit"
  | "PrecheckOrganizationalUnit";

/**
 * The `detail` payload AWS Control Tower delivers to EventBridge when a
 * lifecycle action completes. Control Tower publishes them as AWS service
 * events via CloudTrail, so the detail carries the CloudTrail record shape;
 * the interesting outcome lives under `serviceEventDetails`.
 */
export interface ControlTowerLifecycleEventDetail {
  /** The lifecycle event name, e.g. `CreateManagedAccount`. */
  eventName?: ControlTowerLifecycleEventName | (string & {});
  /** Always `controltower.amazonaws.com` for lifecycle events. */
  eventSource?: string;
  /** The Control Tower home region that recorded the event. */
  awsRegion?: string;
  /** When the lifecycle action completed. */
  eventTime?: string;
  /**
   * The lifecycle outcome, keyed by `{eventName}Status` (e.g.
   * `createManagedAccountStatus.state` is `SUCCEEDED` or `FAILED`).
   */
  serviceEventDetails?: Record<string, unknown>;
  /** Additional CloudTrail record fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An AWS Control Tower lifecycle EventBridge event delivered to the handler. */
export type ControlTowerLifecycleEvent =
  EventRecord<ControlTowerLifecycleEventDetail>;

export interface LifecycleEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "ControlTowerLifecycleEvents"
   */
  id?: string;
  /**
   * Which lifecycle event names to subscribe to.
   * @default all lifecycle events
   */
  events?: readonly ControlTowerLifecycleEventName[];
}

/**
 * Event source connecting AWS Control Tower lifecycle events to the hosting
 * compute. Control Tower publishes every completed lifecycle action —
 * account provisioning (`CreateManagedAccount`), guardrail changes
 * (`EnableGuardrail`), landing zone setup/upgrade (`SetupLandingZone`,
 * `UpdateLandingZone`), and OU registration — to the management account's
 * default EventBridge bus in the home region (source `aws.controltower`);
 * this subscribes the host Function to those events so it can trigger
 * account-customization or notification automation.
 *
 * Control Tower publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Lifecycle Events
 * @example Customize Newly Provisioned Accounts
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default OnboardFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.ControlTower.consumeLifecycleEvents(
 *       { events: ["CreateManagedAccount"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `account provisioned: ${JSON.stringify(
 *               event.detail.serviceEventDetails,
 *             )}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeLifecycleEvents = <StreamReq = never, Req = never>(
  props: LifecycleEventSourceProps,
  process: (
    events: Stream.Stream<ControlTowerLifecycleEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "ControlTowerLifecycleEvents",
    {
      source: ["aws.controltower"],
      "detail-type": ["AWS Service Event via CloudTrail"],
      ...(props.events === undefined
        ? {}
        : { detail: { eventName: [...props.events] } }),
    },
    { description: props.description, state: props.state },
    process,
  );
