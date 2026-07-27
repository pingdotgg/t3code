import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:ListEnabledProductsForImport`.
 *
 * Lists the product integrations currently enabled to import findings into Security Hub.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.ListEnabledProductsForImportHttp)`.
 * @binding
 * @section Product Integrations
 * @example List Enabled Products
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listEnabledProductsForImport = yield* AWS.SecurityHub.ListEnabledProductsForImport();
 *
 * // runtime
 * const { ProductSubscriptions } = yield* listEnabledProductsForImport();
 * ```
 */
export interface ListEnabledProductsForImport extends Binding.Service<
  ListEnabledProductsForImport,
  "AWS.SecurityHub.ListEnabledProductsForImport",
  () => Effect.Effect<
    (
      request?: securityhub.ListEnabledProductsForImportRequest,
    ) => Effect.Effect<
      securityhub.ListEnabledProductsForImportResponse,
      securityhub.ListEnabledProductsForImportError
    >
  >
> {}
export const ListEnabledProductsForImport =
  Binding.Service<ListEnabledProductsForImport>(
    "AWS.SecurityHub.ListEnabledProductsForImport",
  );
