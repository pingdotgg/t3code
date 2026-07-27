import type * as lf from "@distilled.cloud/aws/lakeformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetResourceLFTags}.
 */
export interface GetResourceLFTagsRequest extends lf.GetResourceLFTagsRequest {}

/**
 * Runtime binding for `lakeformation:GetResourceLFTags`.
 *
 * Reads the LF-tags attached to a Data Catalog resource (database, table,
 * or columns) — lets a function make tag-driven decisions about the data it
 * touches. Provide the implementation with
 * `Effect.provide(AWS.LakeFormation.GetResourceLFTagsHttp)`.
 * @binding
 * @section Reading LF-Tags
 * @example Read a Database's LF-Tags
 * ```typescript
 * // init — account-level binding takes no resource
 * const getResourceLFTags = yield* AWS.LakeFormation.GetResourceLFTags();
 *
 * // runtime
 * const { LFTagOnDatabase } = yield* getResourceLFTags({
 *   Resource: { Database: { Name: database.databaseName } },
 * });
 * ```
 */
export interface GetResourceLFTags extends Binding.Service<
  GetResourceLFTags,
  "AWS.LakeFormation.GetResourceLFTags",
  () => Effect.Effect<
    (
      request: GetResourceLFTagsRequest,
    ) => Effect.Effect<lf.GetResourceLFTagsResponse, lf.GetResourceLFTagsError>
  >
> {}

export const GetResourceLFTags = Binding.Service<GetResourceLFTags>(
  "AWS.LakeFormation.GetResourceLFTags",
);
