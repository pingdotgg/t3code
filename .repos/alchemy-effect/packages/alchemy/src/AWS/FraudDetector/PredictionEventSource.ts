import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon Fraud Detector delivers to EventBridge when
 * event orchestration is enabled on an event type and a prediction is
 * generated. The payload mirrors the `GetEventPrediction` inputs and results;
 * fields are optional because the schema grows over time.
 */
export interface PredictionEventDetail {
  /** Id of the evaluated event. */
  eventId?: string;
  /** Name of the event type the event belongs to. */
  eventTypeName?: string;
  /** Id of the detector that produced the prediction. */
  detectorId?: string;
  /** Version of the detector that produced the prediction. */
  detectorVersionId?: string;
  /** ISO-8601 timestamp of the evaluated event. */
  eventTimestamp?: string;
  /** Entities the event was recorded against. */
  entities?: ReadonlyArray<Record<string, unknown>>;
  /** Variable values the prediction was computed from. */
  eventVariables?: Record<string, unknown>;
  /** Matched-rule results, including the returned outcomes. */
  ruleResults?: ReadonlyArray<Record<string, unknown>>;
  /** Model scores, when the detector uses models. */
  modelScores?: ReadonlyArray<Record<string, unknown>>;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Fraud Detector prediction EventBridge event delivered to the handler. */
export type PredictionEvent = EventRecord<PredictionEventDetail>;

export interface PredictionEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "FraudDetectorPredictions"
   */
  id?: string;
  /**
   * Restrict to predictions for specific event types (matched against the
   * event's `eventTypeName`).
   */
  eventTypeNames?: readonly string[];
  /**
   * Restrict to predictions produced by specific detectors (matched against
   * the event's `detectorId`).
   */
  detectorIds?: readonly string[];
}

/**
 * Event source connecting Amazon Fraud Detector prediction results to the
 * hosting compute. When event orchestration is enabled on an event type
 * (`EventType` with `eventBridgeEnabled: true`), every `GetEventPrediction`
 * result is published to the account's default EventBridge bus (source
 * `aws.frauddetector`, detail-type `Event Prediction Result Returned`); this
 * subscribes the host Function to those events so it can trigger downstream
 * workflows — queue a manual review, block an account, notify the customer.
 *
 * Fraud Detector publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Prediction Results
 * @example React To High-Risk Predictions
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default ReviewFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.FraudDetector.consumePredictionEvents(
 *       { eventTypeNames: ["purchase"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `prediction for ${event.detail.eventId}: ` +
 *               JSON.stringify(event.detail.ruleResults),
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumePredictionEvents = <StreamReq = never, Req = never>(
  props: PredictionEventSourceProps,
  process: (
    events: Stream.Stream<PredictionEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "FraudDetectorPredictions",
    {
      source: ["aws.frauddetector"],
      "detail-type": ["Event Prediction Result Returned"],
      ...(props.eventTypeNames !== undefined || props.detectorIds !== undefined
        ? {
            detail: {
              ...(props.eventTypeNames !== undefined
                ? { eventTypeName: [...props.eventTypeNames] }
                : {}),
              ...(props.detectorIds !== undefined
                ? { detectorId: [...props.detectorIds] }
                : {}),
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
