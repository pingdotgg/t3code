import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon DataZone delivers to EventBridge. Every
 * DataZone event carries `metadata` (the entity's id/version) and a
 * type-specific `data` object; the schema grows over time so both are kept
 * open.
 */
export interface DataZoneEventDetail {
  /** The versioned identity of the entity the event is about. */
  metadata?: {
    /** The id of the entity (e.g. the subscription request id). */
    id?: string;
    /** The revision/version of the entity. */
    version?: string;
    /** Additional metadata fields. */
    [key: string]: unknown;
  };
  /**
   * The type-specific event body — e.g. for `Subscription Request Created`:
   * the domain, requester, and subscribed listing identifiers.
   */
  data?: {
    /** The identifier of the domain the event originated in. */
    domainId?: string;
    /** Additional event fields (the schema grows over time). */
    [key: string]: unknown;
  };
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An Amazon DataZone EventBridge event delivered to the handler. */
export type DataZoneEvent = EventRecord<DataZoneEventDetail>;

export interface DataZoneEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "DataZoneEvents"
   */
  id?: string;
  /**
   * Restrict to specific DataZone detail types, e.g.
   * `["Subscription Request Created", "Subscription Created"]`. When omitted
   * the host receives every event DataZone publishes (source
   * `aws.datazone`).
   */
  detailTypes?: readonly string[];
}

/**
 * Event source connecting Amazon DataZone notifications to the hosting
 * compute. DataZone publishes its workflow events — subscription requests
 * being created/accepted/rejected, subscriptions being granted, revoked, or
 * cancelled, data source run state changes, asset changes, and domain
 * changes — to the account's default EventBridge bus (source
 * `aws.datazone`); this subscribes the host Function to those events so it
 * can drive automated approval workflows or downstream syncs.
 *
 * DataZone publishes to EventBridge automatically — no additional resource
 * is created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming DataZone Events
 * @example Auto-approve Subscription Requests
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default ApprovalFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const acceptSubscriptionRequest =
 *       yield* AWS.DataZone.AcceptSubscriptionRequest(domain);
 *
 *     yield* AWS.DataZone.consumeDataZoneEvents(
 *       { detailTypes: ["Subscription Request Created"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.gen(function* () {
 *             const requestId = event.detail.metadata?.id;
 *             if (requestId !== undefined) {
 *               yield* acceptSubscriptionRequest({
 *                 identifier: requestId,
 *                 decisionComment: "auto-approved",
 *               }).pipe(Effect.ignore);
 *             }
 *           }),
 *         ),
 *     );
 *     return {};
 *   }).pipe(
 *     Effect.provide(AWS.Lambda.EventSource),
 *     Effect.provide(AWS.DataZone.AcceptSubscriptionRequestHttp),
 *   ),
 * );
 * ```
 */
export const consumeDataZoneEvents = <StreamReq = never, Req = never>(
  props: DataZoneEventSourceProps,
  process: (
    events: Stream.Stream<DataZoneEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "DataZoneEvents",
    {
      source: ["aws.datazone"],
      ...(props.detailTypes !== undefined
        ? { "detail-type": [...props.detailTypes] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
