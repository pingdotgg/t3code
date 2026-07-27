import type * as frauddetector from "@distilled.cloud/aws/frauddetector";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * The `detectorId` is injected by the binding from the bound detector;
 * everything else (the event id, timestamp, entities, and variable values) is
 * the raw distilled request. Pin `detectorVersionId` to evaluate a specific
 * version; omit it to use the detector's `ACTIVE` version.
 */
export interface GetEventPredictionRequest extends Omit<
  frauddetector.GetEventPredictionRequest,
  "detectorId"
> {}

/**
 * Submit an event to a bound Amazon Fraud Detector detector and receive the
 * real-time model scores and rule outcomes for it — the effectful prediction
 * call made from a deployed Lambda or Task.
 *
 * @binding
 * @section Scoring Events
 * Provide the `GetEventPredictionHttp` implementation layer on the Function
 * effect, bind the detector in the init phase, then call the returned client
 * at runtime. The binding grants `frauddetector:GetEventPrediction` on the
 * detector and injects its `detectorId` automatically.
 *
 * @example Predict from a Lambda
 * ```typescript
 * // init
 * const getEventPrediction = yield* FraudDetector.GetEventPrediction(detector);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const { ruleResults } = yield* getEventPrediction({
 *       eventId: "order-123",
 *       eventTypeName: "purchase",
 *       eventTimestamp: new Date().toISOString(),
 *       entities: [{ entityType: "customer", entityId: "cust-1" }],
 *       eventVariables: { email: "fraud@example.com", ip: "1.2.3.4" },
 *     });
 *     const outcomes = ruleResults?.flatMap((r) => r.outcomes ?? []);
 *     return HttpServerResponse.json({ outcomes });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(FraudDetector.GetEventPredictionHttp))
 * ```
 */
export interface GetEventPrediction extends Binding.Service<
  GetEventPrediction,
  "AWS.FraudDetector.GetEventPrediction",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request: GetEventPredictionRequest,
    ) => Effect.Effect<
      frauddetector.GetEventPredictionResult,
      frauddetector.GetEventPredictionError
    >
  >
> {}
export const GetEventPrediction = Binding.Service<GetEventPrediction>(
  "AWS.FraudDetector.GetEventPrediction",
);
