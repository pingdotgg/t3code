import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link BatchAssociateResource}.
 */
export interface BatchAssociateResourceRequest
  extends fms.BatchAssociateResourceRequest {}

/**
 * Runtime binding for `fms:BatchAssociateResource`.
 *
 * Associates resources with the specified Firewall Manager resource set, reporting per-item failures. Provide the
 * implementation with `Effect.provide(AWS.FMS.BatchAssociateResourceHttp)`.
 * @binding
 * @section Resource Sets
 * @example Associate Resources into a Resource Set
 * ```typescript
 * // init — account-level binding takes no resource
 * const batchAssociateResource = yield* AWS.FMS.BatchAssociateResource();
 *
 * // runtime
 * const result = yield* batchAssociateResource({
 *   ResourceSetIdentifier: resourceSetId,
 *   Items: [firewallArn],
 * });
 * console.log(result.FailedItems.length);
 * ```
 */
export interface BatchAssociateResource extends Binding.Service<
  BatchAssociateResource,
  "AWS.FMS.BatchAssociateResource",
  () => Effect.Effect<
    (
      request: BatchAssociateResourceRequest,
    ) => Effect.Effect<
      fms.BatchAssociateResourceResponse,
      fms.BatchAssociateResourceError
    >
  >
> {}

export const BatchAssociateResource = Binding.Service<BatchAssociateResource>(
  "AWS.FMS.BatchAssociateResource",
);
