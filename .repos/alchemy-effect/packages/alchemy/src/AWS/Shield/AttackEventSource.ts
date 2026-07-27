import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The AWS Health services that carry Shield Advanced DDoS attack events.
 * Attacks against most resources surface as `SHIELD` events; attacks against
 * Route 53 hosted zones surface as `ROUTE53` events.
 */
export type AttackEventService = "SHIELD" | "ROUTE53";

/**
 * The `detail` payload of an AWS Health event for a Shield Advanced DDoS
 * attack. Only the commonly-matched fields are typed; the AWS Health schema
 * grows over time.
 */
export interface AttackEventDetail {
  /** The AWS Health event ARN. */
  eventArn?: string;
  /** The service the event belongs to (`SHIELD`, or `ROUTE53` for hosted-zone attacks). */
  service?: string;
  /** The event type code, e.g. `AWS_SHIELD_DDOS_ATTACK_DETECTED`. */
  eventTypeCode?: string;
  /** The event type category — Shield attack events are `issue`s. */
  eventTypeCategory?: string;
  /** When the attack event started (ISO timestamp). */
  startTime?: string;
  /** When the attack event ended, if it has (ISO timestamp). */
  endTime?: string;
  /** Human-readable descriptions of the event. */
  eventDescription?: { language?: string; latestDescription?: string }[];
  /** The attacked resources, when AWS Health can identify them. */
  affectedEntities?: { entityValue?: string }[];
  /** Additional AWS Health fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Shield Advanced attack EventBridge event delivered to the handler. */
export type AttackEvent = EventRecord<AttackEventDetail>;

export interface AttackEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "ShieldAttacks"
   */
  id?: string;
  /**
   * Which AWS Health services to match. Shield Advanced reports attacks on
   * most resource types under `SHIELD`; attacks on Route 53 hosted zones are
   * reported under `ROUTE53`.
   * @default ["SHIELD"]
   */
  services?: readonly AttackEventService[];
  /**
   * Restrict to specific AWS Health event type codes (matched against
   * `detail.eventTypeCode`), e.g. `["AWS_SHIELD_DDOS_ATTACK_DETECTED"]`.
   */
  eventTypeCodes?: readonly string[];
}

/**
 * Event source connecting Shield Advanced DDoS attack notifications to the
 * hosting compute. When Shield Advanced detects an attack against a protected
 * resource it posts an event to AWS Health, which delivers it to the
 * account's default EventBridge bus (source `aws.health`, service `SHIELD` —
 * or `ROUTE53` for hosted-zone attacks); this subscribes the host Function to
 * those events so it can page, annotate dashboards, or trigger mitigations.
 *
 * Shield publishes through AWS Health automatically — no additional resource
 * is created besides the EventBridge rule targeting the host, but events only
 * fire for accounts with an active Shield Advanced subscription. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Attack Events
 * @example Page on Detected DDoS Attacks
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Shield.consumeAttackEvents({}, (events) =>
 *       Stream.runForEach(events, (event) =>
 *         Effect.logError(
 *           `Shield: ${event.detail.eventTypeCode} affecting ${
 *             event.detail.affectedEntities?.[0]?.entityValue
 *           }`,
 *         ),
 *       ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeAttackEvents = <StreamReq = never, Req = never>(
  props: AttackEventSourceProps,
  process: (
    events: Stream.Stream<AttackEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "ShieldAttacks",
    {
      source: ["aws.health"],
      "detail-type": ["AWS Health Event"],
      detail: {
        service: [...(props.services ?? ["SHIELD"])],
        eventTypeCategory: ["issue"],
        ...(props.eventTypeCodes !== undefined
          ? { eventTypeCode: [...props.eventTypeCodes] }
          : {}),
      },
    },
    { description: props.description, state: props.state },
    process,
  );
