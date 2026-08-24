import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:TerminateProvisionedProduct`.
 *
 * Terminates a provisioned product, deleting the underlying CloudFormation stack. Returns the in-flight record — poll it with `DescribeRecord`.
 *
 * Also grants the CloudFormation stack-deletion actions Service Catalog performs with the caller's credentials when the product has no launch-role constraint.
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.TerminateProvisionedProductHttp)`.
 * @binding
 * @section Provisioning Products
 * @example Terminate a Provisioned Product
 * ```typescript
 * // init — account-level binding, no resource argument
 * const terminateProvisionedProduct = yield* AWS.ServiceCatalog.TerminateProvisionedProduct();
 *
 * // runtime
 * const { RecordDetail } = yield* terminateProvisionedProduct({
 *   ProvisionedProductName: "my-vpc",
 *   TerminateToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface TerminateProvisionedProduct extends Binding.Service<
  TerminateProvisionedProduct,
  "AWS.ServiceCatalog.TerminateProvisionedProduct",
  () => Effect.Effect<
    (
      request: servicecatalog.TerminateProvisionedProductInput,
    ) => Effect.Effect<
      servicecatalog.TerminateProvisionedProductOutput,
      servicecatalog.TerminateProvisionedProductError
    >
  >
> {}
export const TerminateProvisionedProduct =
  Binding.Service<TerminateProvisionedProduct>(
    "AWS.ServiceCatalog.TerminateProvisionedProduct",
  );
