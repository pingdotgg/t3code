import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The commonly-consumed AWS Organizations event names. Organizations
 * publishes CloudTrail-backed events — `CreateAccountResult` arrives as an
 * AWS service event when an asynchronous `CreateAccount` request completes;
 * the management operations (account moves, OU changes, policy attachments,
 * handshakes) arrive as AWS API call events.
 */
export type OrganizationsEventName =
  | "CreateAccountResult"
  | "CreateOrganizationalUnit"
  | "DeleteOrganizationalUnit"
  | "MoveAccount"
  | "RemoveAccountFromOrganization"
  | "CloseAccount"
  | "InviteAccountToOrganization"
  | "AcceptHandshake"
  | "DeclineHandshake"
  | "CancelHandshake"
  | "AttachPolicy"
  | "DetachPolicy"
  | "TagResource"
  | "UntagResource";

/**
 * The `detail` payload AWS Organizations delivers to EventBridge. The events
 * are published as CloudTrail records (service events for asynchronous
 * outcomes like `CreateAccountResult`, API call events for management
 * operations), so the detail carries the CloudTrail record shape; the
 * asynchronous outcome lives under `serviceEventDetails`.
 */
export interface OrganizationsEventDetail {
  /** The event name, e.g. `CreateAccountResult` or `MoveAccount`. */
  eventName?: OrganizationsEventName | (string & {});
  /** Always `organizations.amazonaws.com`. */
  eventSource?: string;
  /** Always `us-east-1` — Organizations is a global service homed there. */
  awsRegion?: string;
  /** When the operation completed. */
  eventTime?: string;
  /** For API call events, the request parameters of the operation. */
  requestParameters?: Record<string, unknown> | null;
  /** For API call events, the response elements of the operation. */
  responseElements?: Record<string, unknown> | null;
  /**
   * For service events (e.g. `CreateAccountResult`), the asynchronous
   * outcome — `createAccountStatus.state` is `SUCCEEDED` or `FAILED`.
   */
  serviceEventDetails?: Record<string, unknown>;
  /** Additional CloudTrail record fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An AWS Organizations EventBridge event delivered to the handler. */
export type OrganizationsEvent = EventRecord<OrganizationsEventDetail>;

export interface OrganizationsEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "OrganizationsEvents"
   */
  id?: string;
  /**
   * Which event names to subscribe to (matched against `detail.eventName`),
   * e.g. `["CreateAccountResult"]`.
   * @default all Organizations events
   */
  events?: readonly (OrganizationsEventName | (string & {}))[];
}

/**
 * Event source connecting AWS Organizations events to the hosting compute.
 * Organizations publishes CloudTrail-backed events — asynchronous
 * account-creation outcomes (`CreateAccountResult`) and every management
 * operation (account moves, OU changes, policy attachments, handshake
 * responses) — to the **management account's** default EventBridge bus in
 * **us-east-1** (source `aws.organizations`); this subscribes the host
 * Function to those events so it can drive account-vending, baseline, or
 * compliance automation.
 *
 * Organizations publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host. The
 * rule must be deployed in us-east-1 of the management account to receive
 * events. Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Organization Events
 * @example React to Completed Account Creations
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default VendingFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Organizations.consumeOrganizationsEvents(
 *       { events: ["CreateAccountResult"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `account creation: ${JSON.stringify(
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
export const consumeOrganizationsEvents = <StreamReq = never, Req = never>(
  props: OrganizationsEventSourceProps,
  process: (
    events: Stream.Stream<OrganizationsEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "OrganizationsEvents",
    {
      source: ["aws.organizations"],
      ...(props.events !== undefined
        ? { detail: { eventName: [...props.events] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
