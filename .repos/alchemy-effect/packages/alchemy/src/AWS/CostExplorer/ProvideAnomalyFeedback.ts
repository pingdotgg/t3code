import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ProvideAnomalyFeedback}.
 */
export interface ProvideAnomalyFeedbackRequest
  extends ce.ProvideAnomalyFeedbackRequest {}

/**
 * Runtime binding for `ce:ProvideAnomalyFeedback`.
 *
 * Record feedback on a detected anomaly (`YES` / `NO` /
 * `PLANNED_ACTIVITY`), improving future detection. Anomalies are
 * addressed by id; per the `ce` service authorization reference the action
 * supports no resource types, so this is an account-level binding. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.ProvideAnomalyFeedbackHttp)`.
 * @binding
 * @section Anomaly Detection at Runtime
 * @example Mark an Anomaly as Expected
 * ```typescript
 * // init — account-level binding takes no resource
 * const provideAnomalyFeedback = yield* AWS.CostExplorer.ProvideAnomalyFeedback();
 *
 * // runtime
 * yield* provideAnomalyFeedback({
 *   AnomalyId: anomalyId,
 *   Feedback: "PLANNED_ACTIVITY",
 * });
 * ```
 */
export interface ProvideAnomalyFeedback extends Binding.Service<
  ProvideAnomalyFeedback,
  "AWS.CostExplorer.ProvideAnomalyFeedback",
  () => Effect.Effect<
    (
      request: ProvideAnomalyFeedbackRequest,
    ) => Effect.Effect<
      ce.ProvideAnomalyFeedbackResponse,
      ce.ProvideAnomalyFeedbackError
    >
  >
> {}

export const ProvideAnomalyFeedback = Binding.Service<ProvideAnomalyFeedback>(
  "AWS.CostExplorer.ProvideAnomalyFeedback",
);
