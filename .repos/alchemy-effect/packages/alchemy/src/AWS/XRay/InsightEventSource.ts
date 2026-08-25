import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload X-Ray delivers to EventBridge when an insight is
 * created, updated, or closed. Delivery requires an X-Ray group with both
 * `insightsEnabled` and `notificationsEnabled`.
 */
export interface InsightEventDetail {
  /** The id of the insight the event is about. */
  InsightId?: string;
  /** Name of the X-Ray group the insight belongs to. */
  GroupName?: string;
  /** ARN of the X-Ray group the insight belongs to. */
  GroupARN?: string;
  /** The service at the root of the detected anomaly. */
  RootCauseServiceId?: {
    Name?: string;
    Type?: string;
    AccountId?: string;
    [key: string]: unknown;
  };
  /** The categories the insight applies to, e.g. `FAULT`. */
  Categories?: string[];
  /** Insight state: `ACTIVE` or `CLOSED`. */
  State?: string;
  /** Time the insight started. */
  StartTime?: string | number;
  /** Time the insight ended (`null` while the insight is active). */
  EndTime?: string | number | null;
  /** Human-readable insight summary. */
  Summary?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An X-Ray insight EventBridge event delivered to the handler. */
export type InsightEvent = EventRecord<InsightEventDetail>;

export interface InsightEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "XRayInsightEvents"
   */
  id?: string;
  /**
   * Restrict to insights of the given X-Ray groups (matched against the
   * event detail's `GroupName`).
   */
  groupNames?: readonly string[];
  /**
   * Restrict to insights in the given states (matched against the event
   * detail's `State`: `ACTIVE`, `CLOSED`).
   */
  states?: readonly string[];
}

/**
 * Event source connecting X-Ray insight notifications to the hosting
 * compute. When an X-Ray group has insights and notifications enabled
 * (`Group({ insightsEnabled: true, notificationsEnabled: true })`), X-Ray
 * publishes insight lifecycle updates to the account's default EventBridge
 * bus (source `aws.xray`, detail-type `AWS X-Ray Insight Update`); this
 * subscribes the host Function to those events so it can page, annotate
 * incidents, or drive remediation.
 *
 * X-Ray publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Insight Events
 * @example Alert on Active Insights
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.XRay.consumeInsightEvents(
 *       { states: ["ACTIVE"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.logError(
 *             `X-Ray insight ${event.detail.InsightId}: ${event.detail.Summary}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeInsightEvents = <StreamReq = never, Req = never>(
  props: InsightEventSourceProps,
  process: (
    events: Stream.Stream<InsightEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "XRayInsightEvents",
    {
      source: ["aws.xray"],
      "detail-type": ["AWS X-Ray Insight Update"],
      ...(props.groupNames !== undefined || props.states !== undefined
        ? {
            detail: {
              ...(props.groupNames !== undefined
                ? { GroupName: [...props.groupNames] }
                : {}),
              ...(props.states !== undefined
                ? { State: [...props.states] }
                : {}),
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
