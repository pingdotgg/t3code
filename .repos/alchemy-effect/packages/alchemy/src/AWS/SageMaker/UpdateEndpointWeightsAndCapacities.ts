import type * as sagemaker from "@distilled.cloud/aws/sagemaker";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Endpoint } from "./Endpoint.ts";

export interface UpdateEndpointWeightsAndCapacitiesRequest extends Omit<
  sagemaker.UpdateEndpointWeightsAndCapacitiesInput,
  "EndpointName"
> {}

/**
 * Runtime binding for `sagemaker:UpdateEndpointWeightsAndCapacities` — shift
 * traffic between an endpoint's production variants (or resize one variant)
 * without redeploying.
 *
 * Bind this operation to an `Endpoint` inside a function runtime to get a
 * callable that automatically injects the endpoint name. Only applies to
 * instance-based variants (serverless variants have no weights/capacities);
 * the endpoint transitions through `Updating` back to `InService`.
 * @binding
 * @section Shifting Traffic
 * @example Canary a Variant
 * ```typescript
 * // init
 * const updateWeights =
 *   yield* AWS.SageMaker.UpdateEndpointWeightsAndCapacities(endpoint);
 *
 * // runtime
 * yield* updateWeights({
 *   DesiredWeightsAndCapacities: [
 *     { VariantName: "Blue", DesiredWeight: 9 },
 *     { VariantName: "Green", DesiredWeight: 1 },
 *   ],
 * });
 * ```
 */
export interface UpdateEndpointWeightsAndCapacities extends Binding.Service<
  UpdateEndpointWeightsAndCapacities,
  "AWS.SageMaker.UpdateEndpointWeightsAndCapacities",
  <E extends Endpoint>(
    endpoint: E,
  ) => Effect.Effect<
    (
      request: UpdateEndpointWeightsAndCapacitiesRequest,
    ) => Effect.Effect<
      sagemaker.UpdateEndpointWeightsAndCapacitiesOutput,
      sagemaker.UpdateEndpointWeightsAndCapacitiesError
    >
  >
> {}
export const UpdateEndpointWeightsAndCapacities =
  Binding.Service<UpdateEndpointWeightsAndCapacities>(
    "AWS.SageMaker.UpdateEndpointWeightsAndCapacities",
  );
