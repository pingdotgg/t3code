import type * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `transcribe:GetCallAnalyticsCategory` — read a Call Analytics category's rules.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:GetCallAnalyticsCategory` on `*`.
 *
 * ### Call Analytics Categories
 * **Example:** Get a Call Analytics Category
 * ```typescript
 * // init
 * const getCallAnalyticsCategory = yield* AWS.Transcribe.GetCallAnalyticsCategory();
 *
 * // runtime
 * const { CategoryProperties } = yield* getCallAnalyticsCategory({
 *   CategoryName: "long-silence",
 * });
 * ```
 *
 * @binding
 */
export interface GetCallAnalyticsCategory extends Binding.Service<
  GetCallAnalyticsCategory,
  "AWS.Transcribe.GetCallAnalyticsCategory",
  () => Effect.Effect<
    (
      request: transcribe.GetCallAnalyticsCategoryRequest,
    ) => Effect.Effect<
      transcribe.GetCallAnalyticsCategoryResponse,
      transcribe.GetCallAnalyticsCategoryError
    >
  >
> {}
export const GetCallAnalyticsCategory = Binding.Service<GetCallAnalyticsCategory>(
  "AWS.Transcribe.GetCallAnalyticsCategory",
);
