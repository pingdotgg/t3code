import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:ListStackInstancesForProvisionedProduct`.
 *
 * Lists the CloudFormation stack instances (account/region pairs) of a StackSet-backed provisioned product.
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.ListStackInstancesForProvisionedProductHttp)`.
 * @binding
 * @section Tracking Provisioned Products
 * @example List a StackSet Product's Stack Instances
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listStackInstancesForProvisionedProduct = yield* AWS.ServiceCatalog.ListStackInstancesForProvisionedProduct();
 *
 * // runtime
 * const { StackInstances } =
 *   yield* listStackInstancesForProvisionedProduct({
 *     ProvisionedProductId: "pp-abc123",
 *   });
 * ```
 */
export interface ListStackInstancesForProvisionedProduct extends Binding.Service<
  ListStackInstancesForProvisionedProduct,
  "AWS.ServiceCatalog.ListStackInstancesForProvisionedProduct",
  () => Effect.Effect<
    (
      request: servicecatalog.ListStackInstancesForProvisionedProductInput,
    ) => Effect.Effect<
      servicecatalog.ListStackInstancesForProvisionedProductOutput,
      servicecatalog.ListStackInstancesForProvisionedProductError
    >
  >
> {}
export const ListStackInstancesForProvisionedProduct =
  Binding.Service<ListStackInstancesForProvisionedProduct>(
    "AWS.ServiceCatalog.ListStackInstancesForProvisionedProduct",
  );
