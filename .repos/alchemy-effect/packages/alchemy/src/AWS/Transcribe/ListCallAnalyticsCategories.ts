import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:ListCallAnalyticsCategories` — list the Call Analytics categories in the account.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:ListCallAnalyticsCategories` on `*`.
 *
 * @binding
 * @section Call Analytics Categories
 * @example List Call Analytics Categories
 * ```typescript
 * // init
 * const listCallAnalyticsCategories = yield* AWS.Transcribe.ListCallAnalyticsCategories();
 *
 * // runtime
 * const { Categories } = yield* listCallAnalyticsCategories({ MaxResults: 10 });
 * ```
 */
export interface ListCallAnalyticsCategories extends Binding.Service<
  ListCallAnalyticsCategories,
  "AWS.Transcribe.ListCallAnalyticsCategories",
  () => Effect.Effect<
    (
      request?: transcribe.ListCallAnalyticsCategoriesRequest,
    ) => Effect.Effect<
      transcribe.ListCallAnalyticsCategoriesResponse,
      transcribe.ListCallAnalyticsCategoriesError
    >
  >
> {}
export const ListCallAnalyticsCategories =
  Binding.Service<ListCallAnalyticsCategories>(
    "AWS.Transcribe.ListCallAnalyticsCategories",
  );
