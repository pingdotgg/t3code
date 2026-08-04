import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `SubmitFeedback` request with `IndexId` injected from the bound index.
 */
export interface SubmitFeedbackRequest extends Omit<
  kendra.SubmitFeedbackRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `SubmitFeedback` operation (IAM action
 * `kendra:SubmitFeedback`), scoped to one {@link Index}.
 *
 * Submits click and relevance feedback for a query's results — Kendra
 * uses it to tune the index's relevance over time (incremental learning).
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.SubmitFeedbackHttp)`.
 *
 * @binding
 * @section Querying an Index
 * @example Submit Click Feedback
 * ```typescript
 * const submitFeedback = yield* AWS.Kendra.SubmitFeedback(index);
 *
 * yield* submitFeedback({
 *   QueryId: queryId,
 *   ClickFeedbackItems: [{ ResultId: resultId, ClickTime: new Date() }],
 * });
 * ```
 */
export interface SubmitFeedback extends Binding.Service<
  SubmitFeedback,
  "AWS.Kendra.SubmitFeedback",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: SubmitFeedbackRequest,
    ) => Effect.Effect<
      kendra.SubmitFeedbackResponse,
      kendra.SubmitFeedbackError
    >
  >
> {}
export const SubmitFeedback = Binding.Service<SubmitFeedback>(
  "AWS.Kendra.SubmitFeedback",
);
