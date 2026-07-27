import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:DisableImportFindingsForProduct`.
 *
 * Disables a product integration so its findings no longer flow into Security Hub.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.DisableImportFindingsForProductHttp)`.
 * @binding
 * @section Product Integrations
 * @example Disable a Product Integration
 * ```typescript
 * // init — account-level binding, no resource argument
 * const disableImportFindingsForProduct = yield* AWS.SecurityHub.DisableImportFindingsForProduct();
 *
 * // runtime
 * yield* disableImportFindingsForProduct({
 *   ProductSubscriptionArn: subscriptionArn,
 * });
 * ```
 */
export interface DisableImportFindingsForProduct extends Binding.Service<
  DisableImportFindingsForProduct,
  "AWS.SecurityHub.DisableImportFindingsForProduct",
  () => Effect.Effect<
    (
      request: securityhub.DisableImportFindingsForProductRequest,
    ) => Effect.Effect<
      securityhub.DisableImportFindingsForProductResponse,
      securityhub.DisableImportFindingsForProductError
    >
  >
> {}
export const DisableImportFindingsForProduct =
  Binding.Service<DisableImportFindingsForProduct>(
    "AWS.SecurityHub.DisableImportFindingsForProduct",
  );
