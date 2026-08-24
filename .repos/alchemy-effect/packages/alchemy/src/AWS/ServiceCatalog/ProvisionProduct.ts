import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:ProvisionProduct`.
 *
 * Provisions (launches) a product, creating the underlying CloudFormation stack. Returns the in-flight provisioning record — poll it with `DescribeRecord`.
 *
 * Also grants the CloudFormation stack-creation and template-fetch (`s3:GetObject`) actions Service Catalog performs with the caller's credentials when the product has no launch-role constraint.
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.ProvisionProductHttp)`.
 * @binding
 * @section Provisioning Products
 * @example Launch a Product
 * ```typescript
 * // init — account-level binding, no resource argument
 * const provisionProduct = yield* AWS.ServiceCatalog.ProvisionProduct();
 *
 * // runtime
 * const { RecordDetail } = yield* provisionProduct({
 *   ProductId: "prod-abc123",
 *   ProvisioningArtifactId: "pa-abc123",
 *   ProvisionedProductName: "my-vpc",
 *   ProvisionToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface ProvisionProduct extends Binding.Service<
  ProvisionProduct,
  "AWS.ServiceCatalog.ProvisionProduct",
  () => Effect.Effect<
    (
      request: servicecatalog.ProvisionProductInput,
    ) => Effect.Effect<
      servicecatalog.ProvisionProductOutput,
      servicecatalog.ProvisionProductError
    >
  >
> {}
export const ProvisionProduct = Binding.Service<ProvisionProduct>(
  "AWS.ServiceCatalog.ProvisionProduct",
);
