import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:EnableImportFindingsForProduct`.
 *
 * Enables a product integration so its findings flow into Security Hub.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.EnableImportFindingsForProductHttp)`.
 * @binding
 * @section Product Integrations
 * @example Enable a Product Integration
 * ```typescript
 * // init — account-level binding, no resource argument
 * const enableImportFindingsForProduct = yield* AWS.SecurityHub.EnableImportFindingsForProduct();
 *
 * // runtime
 * const { ProductSubscriptionArn } = yield* enableImportFindingsForProduct({
 *   ProductArn: productArn,
 * });
 * ```
 */
export interface EnableImportFindingsForProduct extends Binding.Service<
  EnableImportFindingsForProduct,
  "AWS.SecurityHub.EnableImportFindingsForProduct",
  () => Effect.Effect<
    (
      request?: securityhub.EnableImportFindingsForProductRequest,
    ) => Effect.Effect<
      securityhub.EnableImportFindingsForProductResponse,
      securityhub.EnableImportFindingsForProductError
    >
  >
> {}
export const EnableImportFindingsForProduct =
  Binding.Service<EnableImportFindingsForProduct>(
    "AWS.SecurityHub.EnableImportFindingsForProduct",
  );
