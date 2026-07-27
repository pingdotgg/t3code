import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:DescribeProvisioningParameters`.
 *
 * Gets the template parameters, constraints, and usage instructions needed to provision a product — call it before `ProvisionProduct` to build the parameter form.
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.DescribeProvisioningParametersHttp)`.
 * @binding
 * @section Browsing the Catalog
 * @example Read a Product's Template Parameters
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeProvisioningParameters = yield* AWS.ServiceCatalog.DescribeProvisioningParameters();
 *
 * // runtime
 * const { ProvisioningArtifactParameters } =
 *   yield* describeProvisioningParameters({
 *     ProductId: "prod-abc123",
 *     ProvisioningArtifactId: "pa-abc123",
 *   });
 * ```
 */
export interface DescribeProvisioningParameters extends Binding.Service<
  DescribeProvisioningParameters,
  "AWS.ServiceCatalog.DescribeProvisioningParameters",
  () => Effect.Effect<
    (
      request?: servicecatalog.DescribeProvisioningParametersInput,
    ) => Effect.Effect<
      servicecatalog.DescribeProvisioningParametersOutput,
      servicecatalog.DescribeProvisioningParametersError
    >
  >
> {}
export const DescribeProvisioningParameters =
  Binding.Service<DescribeProvisioningParameters>(
    "AWS.ServiceCatalog.DescribeProvisioningParameters",
  );
