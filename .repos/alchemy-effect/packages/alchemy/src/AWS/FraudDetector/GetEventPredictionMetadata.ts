import type * as frauddetector from "@distilled.cloud/aws/frauddetector";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * The `detectorId` is injected by the binding from the bound detector; the
 * caller supplies the event id, event type, detector version, and the
 * prediction timestamp (as returned by `ListEventPredictions`).
 */
export interface GetEventPredictionMetadataRequest extends Omit<
  frauddetector.GetEventPredictionMetadataRequest,
  "detectorId"
> {}

/**
 * Read the full evaluation details of a past prediction made by a bound
 * Amazon Fraud Detector detector — the variables, rule evaluations, and model
 * scores recorded for the prediction — the effectful audit call made from a
 * deployed Lambda or Task.
 *
 * @binding
 * @section Auditing Predictions
 * Provide the `GetEventPredictionMetadataHttp` implementation layer on the
 * Function effect, bind the detector in the init phase, then call the
 * returned client at runtime. The binding grants
 * `frauddetector:GetEventPredictionMetadata` on the detector and injects its
 * `detectorId` automatically. Find `predictionTimestamp` values via the
 * `ListEventPredictions` binding.
 *
 * @example Audit from a Lambda
 * ```typescript
 * // init
 * const getPredictionMetadata =
 *   yield* FraudDetector.GetEventPredictionMetadata(detector);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const metadata = yield* getPredictionMetadata({
 *       eventId: "order-123",
 *       eventTypeName: "purchase",
 *       detectorVersionId: "1",
 *       predictionTimestamp: "2026-01-01T00:00:00Z",
 *     });
 *     return HttpServerResponse.json({ rules: metadata.rules });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(FraudDetector.GetEventPredictionMetadataHttp))
 * ```
 */
export interface GetEventPredictionMetadata extends Binding.Service<
  GetEventPredictionMetadata,
  "AWS.FraudDetector.GetEventPredictionMetadata",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request: GetEventPredictionMetadataRequest,
    ) => Effect.Effect<
      frauddetector.GetEventPredictionMetadataResult,
      frauddetector.GetEventPredictionMetadataError
    >
  >
> {}
export const GetEventPredictionMetadata =
  Binding.Service<GetEventPredictionMetadata>(
    "AWS.FraudDetector.GetEventPredictionMetadata",
  );
