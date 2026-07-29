import type * as frauddetector from "@distilled.cloud/aws/frauddetector";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * The `detectorId` filter is injected by the binding from the bound detector;
 * the remaining filters (event id, event type, detector version, prediction
 * time range) and pagination controls are the caller's.
 */
export interface ListEventPredictionsRequest extends Omit<
  frauddetector.ListEventPredictionsRequest,
  "detectorId"
> {}

/**
 * List the past predictions made by a bound Amazon Fraud Detector detector —
 * the effectful search call made from a deployed Lambda or Task, e.g. to find
 * the `predictionTimestamp` needed by `GetEventPredictionMetadata`.
 *
 * @binding
 * @section Auditing Predictions
 * Provide the `ListEventPredictionsHttp` implementation layer on the Function
 * effect, bind the detector in the init phase, then call the returned client
 * at runtime. The binding grants `frauddetector:ListEventPredictions` (the
 * action supports no resource-level scoping) and filters results to the bound
 * detector automatically.
 *
 * @example List from a Lambda
 * ```typescript
 * // init
 * const listEventPredictions =
 *   yield* FraudDetector.ListEventPredictions(detector);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const { eventPredictionSummaries } = yield* listEventPredictions({
 *       eventId: { value: "order-123" },
 *     });
 *     return HttpServerResponse.json({
 *       predictions: eventPredictionSummaries ?? [],
 *     });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(FraudDetector.ListEventPredictionsHttp))
 * ```
 */
export interface ListEventPredictions extends Binding.Service<
  ListEventPredictions,
  "AWS.FraudDetector.ListEventPredictions",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request: ListEventPredictionsRequest,
    ) => Effect.Effect<
      frauddetector.ListEventPredictionsResult,
      frauddetector.ListEventPredictionsError
    >
  >
> {}
export const ListEventPredictions = Binding.Service<ListEventPredictions>(
  "AWS.FraudDetector.ListEventPredictions",
);
