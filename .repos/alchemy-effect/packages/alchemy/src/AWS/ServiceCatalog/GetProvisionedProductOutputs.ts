import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:GetProvisionedProductOutputs`.
 *
 * Gets the CloudFormation stack outputs of a provisioned product — how downstream code discovers the endpoints and IDs a launched product created.
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.GetProvisionedProductOutputsHttp)`.
 * @binding
 * @section Tracking Provisioned Products
 * @example Read a Provisioned Product's Stack Outputs
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getProvisionedProductOutputs = yield* AWS.ServiceCatalog.GetProvisionedProductOutputs();
 *
 * // runtime
 * const { Outputs } = yield* getProvisionedProductOutputs({
 *   ProvisionedProductName: "my-vpc",
 * });
 * ```
 */
export interface GetProvisionedProductOutputs extends Binding.Service<
  GetProvisionedProductOutputs,
  "AWS.ServiceCatalog.GetProvisionedProductOutputs",
  () => Effect.Effect<
    (
      request?: servicecatalog.GetProvisionedProductOutputsInput,
    ) => Effect.Effect<
      servicecatalog.GetProvisionedProductOutputsOutput,
      servicecatalog.GetProvisionedProductOutputsError
    >
  >
> {}
export const GetProvisionedProductOutputs =
  Binding.Service<GetProvisionedProductOutputs>(
    "AWS.ServiceCatalog.GetProvisionedProductOutputs",
  );
