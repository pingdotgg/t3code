import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link PutResourceSet}.
 */
export interface PutResourceSetRequest extends fms.PutResourceSetRequest {}

/**
 * Runtime binding for `fms:PutResourceSet`.
 *
 * Creates or updates a Firewall Manager resource set — a collection of resources that a Firewall Manager policy can protect as a unit. Provide the
 * implementation with `Effect.provide(AWS.FMS.PutResourceSetHttp)`.
 * @binding
 * @section Resource Sets
 * @example Create a Resource Set
 * ```typescript
 * // init — account-level binding takes no resource
 * const putResourceSet = yield* AWS.FMS.PutResourceSet();
 *
 * // runtime
 * const result = yield* putResourceSet({
 *   ResourceSet: {
 *     Name: "edge-resources",
 *     ResourceTypeList: ["AWS::NetworkFirewall::Firewall"],
 *   },
 * });
 * console.log(result.ResourceSet.Id);
 * ```
 */
export interface PutResourceSet extends Binding.Service<
  PutResourceSet,
  "AWS.FMS.PutResourceSet",
  () => Effect.Effect<
    (
      request: PutResourceSetRequest,
    ) => Effect.Effect<fms.PutResourceSetResponse, fms.PutResourceSetError>
  >
> {}

export const PutResourceSet = Binding.Service<PutResourceSet>(
  "AWS.FMS.PutResourceSet",
);
