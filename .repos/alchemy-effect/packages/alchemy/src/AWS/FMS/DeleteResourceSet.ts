import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link DeleteResourceSet}.
 */
export interface DeleteResourceSetRequest
  extends fms.DeleteResourceSetRequest {}

/**
 * Runtime binding for `fms:DeleteResourceSet`.
 *
 * Permanently deletes the specified Firewall Manager resource set. Provide the
 * implementation with `Effect.provide(AWS.FMS.DeleteResourceSetHttp)`.
 * @binding
 * @section Resource Sets
 * @example Delete a Resource Set
 * ```typescript
 * // init — account-level binding takes no resource
 * const deleteResourceSet = yield* AWS.FMS.DeleteResourceSet();
 *
 * // runtime
 * yield* deleteResourceSet({ Identifier: resourceSetId });
 * ```
 */
export interface DeleteResourceSet extends Binding.Service<
  DeleteResourceSet,
  "AWS.FMS.DeleteResourceSet",
  () => Effect.Effect<
    (
      request: DeleteResourceSetRequest,
    ) => Effect.Effect<
      fms.DeleteResourceSetResponse,
      fms.DeleteResourceSetError
    >
  >
> {}

export const DeleteResourceSet = Binding.Service<DeleteResourceSet>(
  "AWS.FMS.DeleteResourceSet",
);
