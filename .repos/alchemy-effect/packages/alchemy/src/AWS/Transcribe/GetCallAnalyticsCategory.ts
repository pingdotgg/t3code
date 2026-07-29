import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:GetCallAnalyticsCategory` — read a Call Analytics category's rules.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:GetCallAnalyticsCategory` on `*`.
 *
 * @binding
 * @section Call Analytics Categories
 * @example Get a Call Analytics Category
 * ```typescript
 * // init
 * const getCallAnalyticsCategory = yield* AWS.Transcribe.GetCallAnalyticsCategory();
 *
 * // runtime
 * const { CategoryProperties } = yield* getCallAnalyticsCategory({
 *   CategoryName: "long-silence",
 * });
 * ```
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
export const GetCallAnalyticsCategory =
  Binding.Service<GetCallAnalyticsCategory>(
    "AWS.Transcribe.GetCallAnalyticsCategory",
  );
