import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:UpdateCallAnalyticsCategory` — replace a Call Analytics category's rules.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:UpdateCallAnalyticsCategory` on `*`.
 *
 * @binding
 * @section Call Analytics Categories
 * @example Update a Call Analytics Category
 * ```typescript
 * // init
 * const updateCallAnalyticsCategory = yield* AWS.Transcribe.UpdateCallAnalyticsCategory();
 *
 * // runtime
 * yield* updateCallAnalyticsCategory({
 *   CategoryName: "long-silence",
 *   Rules: [{ NonTalkTimeFilter: { Threshold: 60000 } }],
 * });
 * ```
 */
export interface UpdateCallAnalyticsCategory extends Binding.Service<
  UpdateCallAnalyticsCategory,
  "AWS.Transcribe.UpdateCallAnalyticsCategory",
  () => Effect.Effect<
    (
      request: transcribe.UpdateCallAnalyticsCategoryRequest,
    ) => Effect.Effect<
      transcribe.UpdateCallAnalyticsCategoryResponse,
      transcribe.UpdateCallAnalyticsCategoryError
    >
  >
> {}
export const UpdateCallAnalyticsCategory =
  Binding.Service<UpdateCallAnalyticsCategory>(
    "AWS.Transcribe.UpdateCallAnalyticsCategory",
  );
