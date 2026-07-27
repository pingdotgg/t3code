import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:DeleteCallAnalyticsCategory` — delete a Call Analytics category.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:DeleteCallAnalyticsCategory` on `*`.
 *
 * @binding
 * @section Call Analytics Categories
 * @example Delete a Call Analytics Category
 * ```typescript
 * // init
 * const deleteCallAnalyticsCategory = yield* AWS.Transcribe.DeleteCallAnalyticsCategory();
 *
 * // runtime
 * yield* deleteCallAnalyticsCategory({ CategoryName: "long-silence" });
 * ```
 */
export interface DeleteCallAnalyticsCategory extends Binding.Service<
  DeleteCallAnalyticsCategory,
  "AWS.Transcribe.DeleteCallAnalyticsCategory",
  () => Effect.Effect<
    (
      request: transcribe.DeleteCallAnalyticsCategoryRequest,
    ) => Effect.Effect<
      transcribe.DeleteCallAnalyticsCategoryResponse,
      transcribe.DeleteCallAnalyticsCategoryError
    >
  >
> {}
export const DeleteCallAnalyticsCategory =
  Binding.Service<DeleteCallAnalyticsCategory>(
    "AWS.Transcribe.DeleteCallAnalyticsCategory",
  );
