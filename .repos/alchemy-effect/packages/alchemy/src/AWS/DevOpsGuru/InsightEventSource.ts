import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon DevOps Guru delivers to EventBridge. All
 * notifications share the insight envelope; anomaly/recommendation events
 * add their own arrays. Fields not shared by every event kind are optional
 * (the schema grows over time).
 */
export interface InsightEventDetail {
  /** The id of the insight the event is about. */
  insightId?: string;
  /** Human-readable insight summary. */
  insightDescription?: string;
  /** Insight type: `REACTIVE` or `PROACTIVE`. */
  insightType?: string;
  /** Insight severity: `LOW`, `MEDIUM`, or `HIGH`. */
  insightSeverity?: string;
  /** Console deep-link to the insight. */
  insightUrl?: string;
  /** The notification kind, e.g. `NEW_INSIGHT`, `CLOSED_INSIGHT`. */
  messageType?: string;
  /** Epoch millis the insight started. */
  startTime?: number;
  /** Epoch millis the insight ended (closed events). */
  endTime?: number;
  /** The anomalies associated with the insight (anomaly events). */
  anomalies?: unknown[];
  /** The recommendations created for the insight (recommendation events). */
  recommendations?: unknown[];
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A DevOps Guru EventBridge event delivered to the handler. */
export type InsightEvent = EventRecord<InsightEventDetail>;

/** Which DevOps Guru notifications to subscribe to. */
export type InsightEventKind =
  | "new-insight"
  | "severity-upgraded"
  | "insight-closed"
  | "new-anomaly"
  | "new-recommendation";

const DETAIL_TYPES: Record<InsightEventKind, string> = {
  "new-insight": "DevOps Guru New Insight Open",
  "severity-upgraded": "DevOps Guru Insight Severity Upgraded",
  "insight-closed": "DevOps Guru Insight Closed",
  "new-anomaly": "DevOps Guru New Anomaly Association",
  "new-recommendation": "DevOps Guru New Recommendation Created",
};

export interface InsightEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "DevOpsGuruInsightEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: insights opening, upgrading
   * severity, closing, new anomaly associations, and/or new
   * recommendations.
   * @default ["new-insight"]
   */
  kinds?: readonly InsightEventKind[];
  /**
   * Restrict to insights of the given severities (matched against the
   * event detail's `insightSeverity`: `LOW`, `MEDIUM`, `HIGH`).
   */
  severities?: readonly string[];
}

/**
 * Event source connecting Amazon DevOps Guru notifications to the hosting
 * compute. DevOps Guru publishes insight lifecycle events (an insight
 * opening, upgrading severity, or closing, plus new anomaly associations
 * and recommendations) to the account's default EventBridge bus (source
 * `aws.devops-guru`); this subscribes the host Function to those events so
 * it can page, annotate incidents, or drive remediation.
 *
 * DevOps Guru publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Insight Events
 * @example Page on High-Severity Insights
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.DevOpsGuru.consumeInsightEvents(
 *       { kinds: ["new-insight", "severity-upgraded"], severities: ["HIGH"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.logError(
 *             `DevOps Guru insight: ${event.detail.insightDescription} (${event.detail.insightUrl})`,
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
    props.id ?? "DevOpsGuruInsightEvents",
    {
      source: ["aws.devops-guru"],
      "detail-type": (props.kinds ?? (["new-insight"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.severities !== undefined
        ? { detail: { insightSeverity: [...props.severities] } }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
