import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:BatchUpdateStandardsControlAssociations`.
 *
 * Enables or disables a batch of controls within specific standards.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.BatchUpdateStandardsControlAssociationsHttp)`.
 * @binding
 * @section Standards & Controls
 * @example Disable a Control in One Standard
 * ```typescript
 * // init — account-level binding, no resource argument
 * const batchUpdateStandardsControlAssociations = yield* AWS.SecurityHub.BatchUpdateStandardsControlAssociations();
 *
 * // runtime
 * yield* batchUpdateStandardsControlAssociations({
 *   StandardsControlAssociationUpdates: [{
 *     SecurityControlId: "IAM.1",
 *     StandardsArn: standardsArn,
 *     AssociationStatus: "DISABLED",
 *     UpdatedReason: "handled by SSO",
 *   }],
 * });
 * ```
 */
export interface BatchUpdateStandardsControlAssociations extends Binding.Service<
  BatchUpdateStandardsControlAssociations,
  "AWS.SecurityHub.BatchUpdateStandardsControlAssociations",
  () => Effect.Effect<
    (
      request?: securityhub.BatchUpdateStandardsControlAssociationsRequest,
    ) => Effect.Effect<
      securityhub.BatchUpdateStandardsControlAssociationsResponse,
      securityhub.BatchUpdateStandardsControlAssociationsError
    >
  >
> {}
export const BatchUpdateStandardsControlAssociations =
  Binding.Service<BatchUpdateStandardsControlAssociations>(
    "AWS.SecurityHub.BatchUpdateStandardsControlAssociations",
  );
