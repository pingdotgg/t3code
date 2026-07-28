import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetResourceSet}.
 */
export interface GetResourceSetRequest extends fms.GetResourceSetRequest {}

/**
 * Runtime binding for `fms:GetResourceSet`.
 *
 * Returns the specified Firewall Manager resource set. Provide the
 * implementation with `Effect.provide(AWS.FMS.GetResourceSetHttp)`.
 * @binding
 * @section Resource Sets
 * @example Read a Resource Set
 * ```typescript
 * // init — account-level binding takes no resource
 * const getResourceSet = yield* AWS.FMS.GetResourceSet();
 *
 * // runtime
 * const result = yield* getResourceSet({ Identifier: resourceSetId });
 * console.log(result.ResourceSet.Name);
 * ```
 */
export interface GetResourceSet extends Binding.Service<
  GetResourceSet,
  "AWS.FMS.GetResourceSet",
  () => Effect.Effect<
    (
      request: GetResourceSetRequest,
    ) => Effect.Effect<fms.GetResourceSetResponse, fms.GetResourceSetError>
  >
> {}

export const GetResourceSet = Binding.Service<GetResourceSet>(
  "AWS.FMS.GetResourceSet",
);
