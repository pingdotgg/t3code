import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface RejectPredictionsRequest extends Omit<
  datazone.RejectPredictionsInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:RejectPredictions`.
 *
 * Rejects ML-generated metadata predictions on an asset in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.RejectPredictionsHttp)`.
 * @binding
 * @section Publishing Assets
 * @example Reject All Predictions
 * ```typescript
 * // init — bind the operation to the domain
 * const rejectPredictions = yield* AWS.DataZone.RejectPredictions(domain);
 *
 * // runtime
 * yield* rejectPredictions({ identifier: assetId, rejectRule: { rule: "ALL" } });
 * ```
 */
export interface RejectPredictions extends Binding.Service<
  RejectPredictions,
  "AWS.DataZone.RejectPredictions",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: RejectPredictionsRequest,
    ) => Effect.Effect<
      datazone.RejectPredictionsOutput,
      datazone.RejectPredictionsError
    >
  >
> {}
export const RejectPredictions = Binding.Service<RejectPredictions>(
  "AWS.DataZone.RejectPredictions",
);
