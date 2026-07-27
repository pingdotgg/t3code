import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link BatchDisassociateResource}.
 */
export interface BatchDisassociateResourceRequest
  extends fms.BatchDisassociateResourceRequest {}

/**
 * Runtime binding for `fms:BatchDisassociateResource`.
 *
 * Disassociates resources from the specified Firewall Manager resource set, reporting per-item failures. Provide the
 * implementation with `Effect.provide(AWS.FMS.BatchDisassociateResourceHttp)`.
 * @binding
 * @section Resource Sets
 * @example Disassociate Resources from a Resource Set
 * ```typescript
 * // init — account-level binding takes no resource
 * const batchDisassociateResource = yield* AWS.FMS.BatchDisassociateResource();
 *
 * // runtime
 * const result = yield* batchDisassociateResource({
 *   ResourceSetIdentifier: resourceSetId,
 *   Items: [firewallArn],
 * });
 * console.log(result.FailedItems.length);
 * ```
 */
export interface BatchDisassociateResource extends Binding.Service<
  BatchDisassociateResource,
  "AWS.FMS.BatchDisassociateResource",
  () => Effect.Effect<
    (
      request: BatchDisassociateResourceRequest,
    ) => Effect.Effect<
      fms.BatchDisassociateResourceResponse,
      fms.BatchDisassociateResourceError
    >
  >
> {}

export const BatchDisassociateResource =
  Binding.Service<BatchDisassociateResource>(
    "AWS.FMS.BatchDisassociateResource",
  );
