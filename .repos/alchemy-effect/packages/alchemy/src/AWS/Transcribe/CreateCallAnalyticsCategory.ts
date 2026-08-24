import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:CreateCallAnalyticsCategory` — create a Call Analytics category whose rules automatically flag matching calls (e.g. long silence, specific phrases, negative sentiment).
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:CreateCallAnalyticsCategory` on `*`.
 *
 * @binding
 * @section Call Analytics Categories
 * @example Create a Call Analytics Category
 * ```typescript
 * // init
 * const createCallAnalyticsCategory = yield* AWS.Transcribe.CreateCallAnalyticsCategory();
 *
 * // runtime
 * yield* createCallAnalyticsCategory({
 *   CategoryName: "long-silence",
 *   Rules: [{ NonTalkTimeFilter: { Threshold: 30000 } }],
 * });
 * ```
 */
export interface CreateCallAnalyticsCategory extends Binding.Service<
  CreateCallAnalyticsCategory,
  "AWS.Transcribe.CreateCallAnalyticsCategory",
  () => Effect.Effect<
    (
      request: transcribe.CreateCallAnalyticsCategoryRequest,
    ) => Effect.Effect<
      transcribe.CreateCallAnalyticsCategoryResponse,
      transcribe.CreateCallAnalyticsCategoryError
    >
  >
> {}
export const CreateCallAnalyticsCategory =
  Binding.Service<CreateCallAnalyticsCategory>(
    "AWS.Transcribe.CreateCallAnalyticsCategory",
  );
