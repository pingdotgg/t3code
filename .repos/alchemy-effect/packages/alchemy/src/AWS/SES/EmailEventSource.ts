import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload SES delivers to EventBridge for an email sending
 * event. Every event carries `eventType` and `mail`; the event-specific
 * member (`bounce`, `complaint`, `delivery`, …) is present only on that
 * event kind.
 */
export interface EmailEventDetail {
  /** The event kind, e.g. `Send`, `Delivery`, `Bounce`, `Complaint`. */
  eventType?: string;
  /**
   * The original message: `messageId`, `source`, `destination`, and the
   * message `tags` (including `ses:configuration-set`).
   */
  mail?: {
    messageId?: string;
    source?: string;
    destination?: string[];
    tags?: Record<string, string[]>;
    [key: string]: unknown;
  };
  /** Bounce events: bounce type/subtype and the bounced recipients. */
  bounce?: Record<string, unknown>;
  /** Complaint events: the complained recipients and feedback type. */
  complaint?: Record<string, unknown>;
  /** Delivery events: recipients, SMTP response, processing time. */
  delivery?: Record<string, unknown>;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An SES email EventBridge event delivered to the handler. */
export type EmailEvent = EventRecord<EmailEventDetail>;

/** Which SES email sending events to subscribe to. */
export type EmailEventKind =
  | "send"
  | "reject"
  | "delivery"
  | "delivery-delay"
  | "bounce"
  | "complaint"
  | "open"
  | "click"
  | "rendering-failure"
  | "subscription";

const DETAIL_TYPES: Record<EmailEventKind, string> = {
  send: "Email Sent",
  reject: "Email Rejected",
  delivery: "Email Delivered",
  "delivery-delay": "Email Delivery Delayed",
  bounce: "Email Bounced",
  complaint: "Email Complaint Received",
  open: "Email Opened",
  click: "Email Clicked",
  "rendering-failure": "Email Rendering Failed",
  subscription: "Email Subscription",
};

export interface EmailEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "SESEmailEvents"
   */
  id?: string;
  /**
   * Which email sending events to subscribe to.
   * @default ["bounce", "complaint"]
   */
  kinds?: readonly EmailEventKind[];
  /**
   * Restrict to events sent through specific configuration sets (matched
   * against the message's `ses:configuration-set` tag).
   */
  configurationSets?: readonly string[];
}

/**
 * Event source connecting SES email sending events to the hosting compute.
 * SES publishes send/delivery/bounce/complaint (and open/click) events to
 * the account's default EventBridge bus (source `aws.ses`) for every
 * configuration set that has an EventBridge event destination; this
 * subscribes the host Function to those events so it can suppress bouncing
 * addresses, update subscriber state, or alert on complaints.
 *
 * Events only flow for messages sent through a `ConfigurationSet` that has
 * a `ConfigurationSetEventDestination` with an `eventBridgeDestination`
 * (the default bus). Provide the host-specific implementation layer
 * (e.g. `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Email Events
 * @example Suppress Hard-Bouncing Addresses
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default FeedbackFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.SES.consumeEmailEvents(
 *       { kinds: ["bounce", "complaint"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(`${event["detail-type"]}: ${event.detail.mail?.messageId}`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeEmailEvents = <StreamReq = never, Req = never>(
  props: EmailEventSourceProps,
  process: (
    events: Stream.Stream<EmailEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "SESEmailEvents",
    {
      source: ["aws.ses"],
      "detail-type": (props.kinds ?? (["bounce", "complaint"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.configurationSets !== undefined
        ? {
            detail: {
              mail: {
                tags: {
                  "ses:configuration-set": [...props.configurationSets],
                },
              },
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
