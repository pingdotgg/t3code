import type * as lf from "@distilled.cloud/aws/lakeformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetLFTag}.
 */
export interface GetLFTagRequest extends lf.GetLFTagRequest {}

/**
 * Runtime binding for `lakeformation:GetLFTag`.
 *
 * Reads one LF-tag definition (its allowed values) by key. Provide the
 * implementation with `Effect.provide(AWS.LakeFormation.GetLFTagHttp)`.
 * @binding
 * @section Reading LF-Tags
 * @example Read a Tag Definition
 * ```typescript
 * // init — account-level binding takes no resource
 * const getLFTag = yield* AWS.LakeFormation.GetLFTag();
 *
 * // runtime
 * const { TagValues } = yield* getLFTag({ TagKey: "environment" });
 * ```
 */
export interface GetLFTag extends Binding.Service<
  GetLFTag,
  "AWS.LakeFormation.GetLFTag",
  () => Effect.Effect<
    (
      request: GetLFTagRequest,
    ) => Effect.Effect<lf.GetLFTagResponse, lf.GetLFTagError>
  >
> {}

export const GetLFTag = Binding.Service<GetLFTag>("AWS.LakeFormation.GetLFTag");
