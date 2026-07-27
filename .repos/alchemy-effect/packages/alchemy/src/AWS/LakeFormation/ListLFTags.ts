import type * as lf from "@distilled.cloud/aws/lakeformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListLFTags}.
 */
export interface ListLFTagsRequest extends lf.ListLFTagsRequest {}

/**
 * Runtime binding for `lakeformation:ListLFTags`.
 *
 * Lists the LF-tag definitions visible to the caller. Provide the
 * implementation with `Effect.provide(AWS.LakeFormation.ListLFTagsHttp)`.
 * @binding
 * @section Reading LF-Tags
 * @example List Visible Tag Definitions
 * ```typescript
 * // init — account-level binding takes no resource
 * const listLFTags = yield* AWS.LakeFormation.ListLFTags();
 *
 * // runtime
 * const { LFTags } = yield* listLFTags();
 * ```
 */
export interface ListLFTags extends Binding.Service<
  ListLFTags,
  "AWS.LakeFormation.ListLFTags",
  () => Effect.Effect<
    (
      request?: ListLFTagsRequest,
    ) => Effect.Effect<lf.ListLFTagsResponse, lf.ListLFTagsError>
  >
> {}

export const ListLFTags = Binding.Service<ListLFTags>(
  "AWS.LakeFormation.ListLFTags",
);
