import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:UpdateProvisionedProduct`.
 *
 * Updates a provisioned product to a new provisioning artifact (version), parameters, or launch path — the self-service equivalent of a stack update. Returns the in-flight record.
 *
 * Also grants the CloudFormation stack-update actions Service Catalog performs with the caller's credentials when the product has no launch-role constraint.
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.UpdateProvisionedProductHttp)`.
 * @binding
 * @section Provisioning Products
 * @example Update a Provisioned Product to a New Version
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateProvisionedProduct = yield* AWS.ServiceCatalog.UpdateProvisionedProduct();
 *
 * // runtime
 * const { RecordDetail } = yield* updateProvisionedProduct({
 *   ProvisionedProductName: "my-vpc",
 *   ProvisioningArtifactName: "v2",
 *   UpdateToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface UpdateProvisionedProduct extends Binding.Service<
  UpdateProvisionedProduct,
  "AWS.ServiceCatalog.UpdateProvisionedProduct",
  () => Effect.Effect<
    (
      request: servicecatalog.UpdateProvisionedProductInput,
    ) => Effect.Effect<
      servicecatalog.UpdateProvisionedProductOutput,
      servicecatalog.UpdateProvisionedProductError
    >
  >
> {}
export const UpdateProvisionedProduct =
  Binding.Service<UpdateProvisionedProduct>(
    "AWS.ServiceCatalog.UpdateProvisionedProduct",
  );
