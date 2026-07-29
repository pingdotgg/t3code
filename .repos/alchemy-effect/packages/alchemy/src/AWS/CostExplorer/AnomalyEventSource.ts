import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Cost Anomaly Detection delivers to EventBridge when
 * a monitor detects a cost anomaly. Fields mirror the `Anomaly` shape the
 * `GetAnomalies` API returns; the schema grows over time so unknown fields
 * are preserved.
 */
export interface AnomalyEventDetail {
  /** Id of the detected anomaly (usable with `ProvideAnomalyFeedback`). */
  anomalyId?: string;
  /** First day the anomaly was observed (ISO timestamp). */
  anomalyStartDate?: string;
  /** Last day the anomaly was observed (ISO timestamp). */
  anomalyEndDate?: string;
  /** How anomalous the spend is. */
  anomalyScore?: {
    currentScore?: number;
    maxScore?: number;
  };
  /** The dollar impact of the anomaly. */
  impact?: {
    maxImpact?: number;
    totalActualSpend?: number;
    totalExpectedSpend?: number;
    totalImpact?: number;
    totalImpactPercentage?: number;
  };
  /** The services / accounts / usage types driving the anomaly. */
  rootCauses?: {
    linkedAccount?: string;
    linkedAccountName?: string;
    region?: string;
    service?: string;
    usageType?: string;
    impact?: { contribution?: number };
  }[];
  /** ARN of the monitor that detected the anomaly. */
  monitorArn?: string;
  /** Name of the monitor that detected the anomaly. */
  monitorName?: string;
  /** The monitored dimension's value (e.g. the service name). */
  dimensionValue?: string;
  /** 12-digit id of the account the anomaly was detected in. */
  accountId?: string;
  /** Name of the account the anomaly was detected in. */
  accountName?: string;
  /** Console deep link to the anomaly. */
  anomalyDetailsLink?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Cost Anomaly Detection EventBridge event delivered to the handler. */
export type AnomalyEvent = EventRecord<AnomalyEventDetail>;

export interface AnomalyEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "CostAnomalyEvents"
   */
  id?: string;
  /**
   * Restrict to anomalies detected by specific monitors (matched against
   * the event's top-level `resources`, which carries the monitor's ARN).
   */
  monitorArns?: readonly string[];
}

/**
 * Event source connecting Cost Anomaly Detection to the hosting compute.
 * When an {@link AnomalyMonitor} detects a cost anomaly, Cost Explorer
 * publishes an `Anomaly Detected` event (source `aws.ce`, best-effort
 * delivery) to the account's default EventBridge bus; this subscribes the
 * host Function to those events so it can page, open tickets, or trigger
 * automated cost-control actions the moment unusual spend appears.
 *
 * Cost Anomaly Detection publishes to EventBridge automatically — no
 * additional resource is created besides the EventBridge rule targeting
 * the host. Events are delivered to the Cost Anomaly Detection home region
 * (`us-east-1`), so deploy the consuming stack there. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on
 * the Function effect.
 *
 * @section Consuming Anomaly Events
 * @example React To Detected Cost Anomalies
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 * import * as Stream from "effect/Stream";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.CostExplorer.consumeAnomalyEvents({}, (events) =>
 *       Stream.runForEach(events, (event) =>
 *         Effect.log(
 *           `anomaly ${event.detail.anomalyId}: $${event.detail.impact?.totalImpact} on ${event.detail.dimensionValue}`,
 *         ),
 *       ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 *
 * @example Only Anomalies From One Monitor
 * ```typescript
 * yield* AWS.CostExplorer.consumeAnomalyEvents(
 *   { monitorArns: ["arn:aws:ce::123456789012:anomalymonitor/abcd..."] },
 *   (events) =>
 *     Stream.runForEach(events, (event) => Effect.log(event.detail)),
 * );
 * ```
 */
export const consumeAnomalyEvents = <StreamReq = never, Req = never>(
  props: AnomalyEventSourceProps,
  process: (
    events: Stream.Stream<AnomalyEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "CostAnomalyEvents",
    {
      source: ["aws.ce"],
      "detail-type": ["Anomaly Detected"],
      ...(props.monitorArns !== undefined
        ? { resources: [...props.monitorArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
