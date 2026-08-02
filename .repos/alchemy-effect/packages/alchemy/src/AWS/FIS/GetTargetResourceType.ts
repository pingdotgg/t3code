import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `fis:GetTargetResourceType`.
 *
 * Reads a single targetable resource type from the FIS catalog — its
 * description and the parameters targets of that type accept (e.g.
 * `aws:ec2:instance`). Provide the implementation with
 * `Effect.provide(AWS.FIS.GetTargetResourceTypeHttp)`.
 * @binding
 * @section Browsing the Action Catalog
 * @example Inspect a Target Resource Type
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getTargetResourceType = yield* AWS.FIS.GetTargetResourceType();
 *
 * // runtime
 * const { targetResourceType } = yield* getTargetResourceType({
 *   resourceType: "aws:ec2:instance",
 * });
 * console.log(targetResourceType?.description);
 * ```
 */
export interface GetTargetResourceType extends Binding.Service<
  GetTargetResourceType,
  "AWS.FIS.GetTargetResourceType",
  () => Effect.Effect<
    (
      request: fis.GetTargetResourceTypeRequest,
    ) => Effect.Effect<
      fis.GetTargetResourceTypeResponse,
      fis.GetTargetResourceTypeError
    >
  >
> {}
export const GetTargetResourceType = Binding.Service<GetTargetResourceType>(
  "AWS.FIS.GetTargetResourceType",
);
