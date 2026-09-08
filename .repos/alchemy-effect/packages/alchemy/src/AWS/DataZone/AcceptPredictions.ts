import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface AcceptPredictionsRequest extends Omit<
  datazone.AcceptPredictionsInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:AcceptPredictions`.
 *
 * Accepts ML-generated metadata predictions (business-name suggestions) on an asset in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.AcceptPredictionsHttp)`.
 * ### Publishing Assets
 * **Example:** Accept All Predictions
 * ```typescript
 * // init — bind the operation to the domain
 * const acceptPredictions = yield* AWS.DataZone.AcceptPredictions(domain);
 *
 * // runtime
 * yield* acceptPredictions({ identifier: assetId, acceptRule: { rule: "ALL" } });
 * ```
 *
 * @binding
 */
export interface AcceptPredictions extends Binding.Service<
  AcceptPredictions,
  "AWS.DataZone.AcceptPredictions",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: AcceptPredictionsRequest,
    ) => Effect.Effect<
      datazone.AcceptPredictionsOutput,
      datazone.AcceptPredictionsError
    >
  >
> {}
export const AcceptPredictions = Binding.Service<AcceptPredictions>(
  "AWS.DataZone.AcceptPredictions",
);
