import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:BatchGetStandardsControlAssociations`.
 *
 * Returns the enablement status of a batch of controls within specific standards.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.BatchGetStandardsControlAssociationsHttp)`.
 * @binding
 * @section Standards & Controls
 * @example Read Control Associations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const batchGetStandardsControlAssociations = yield* AWS.SecurityHub.BatchGetStandardsControlAssociations();
 *
 * // runtime
 * const { StandardsControlAssociationDetails } =
 *   yield* batchGetStandardsControlAssociations({
 *     StandardsControlAssociationIds: [
 *       { SecurityControlId: "IAM.1", StandardsArn: standardsArn },
 *     ],
 *   });
 * ```
 */
export interface BatchGetStandardsControlAssociations extends Binding.Service<
  BatchGetStandardsControlAssociations,
  "AWS.SecurityHub.BatchGetStandardsControlAssociations",
  () => Effect.Effect<
    (
      request?: securityhub.BatchGetStandardsControlAssociationsRequest,
    ) => Effect.Effect<
      securityhub.BatchGetStandardsControlAssociationsResponse,
      securityhub.BatchGetStandardsControlAssociationsError
    >
  >
> {}
export const BatchGetStandardsControlAssociations =
  Binding.Service<BatchGetStandardsControlAssociations>(
    "AWS.SecurityHub.BatchGetStandardsControlAssociations",
  );
