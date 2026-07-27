import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:ListStandardsControlAssociations`.
 *
 * Lists, for one security control, every standard it belongs to and its enablement status there.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.ListStandardsControlAssociationsHttp)`.
 * @binding
 * @section Standards & Controls
 * @example List a Control's Associations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listStandardsControlAssociations = yield* AWS.SecurityHub.ListStandardsControlAssociations();
 *
 * // runtime
 * const { StandardsControlAssociationSummaries } =
 *   yield* listStandardsControlAssociations({ SecurityControlId: "IAM.1" });
 * ```
 */
export interface ListStandardsControlAssociations extends Binding.Service<
  ListStandardsControlAssociations,
  "AWS.SecurityHub.ListStandardsControlAssociations",
  () => Effect.Effect<
    (
      request?: securityhub.ListStandardsControlAssociationsRequest,
    ) => Effect.Effect<
      securityhub.ListStandardsControlAssociationsResponse,
      securityhub.ListStandardsControlAssociationsError
    >
  >
> {}
export const ListStandardsControlAssociations =
  Binding.Service<ListStandardsControlAssociations>(
    "AWS.SecurityHub.ListStandardsControlAssociations",
  );
