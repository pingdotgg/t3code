import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:DescribeFeedback`.
 *
 * Returns the most recently recorded feedback (e.g. `VALID` / `NOT_VALID`) for an insight.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.DescribeFeedbackHttp)`.
 * @binding
 * @section Feedback
 * @example Read Recorded Feedback
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeFeedback = yield* AWS.DevOpsGuru.DescribeFeedback();
 *
 * // runtime
 * const { InsightFeedback } = yield* describeFeedback({ InsightId: insightId });
 * yield* Effect.log(`feedback: ${InsightFeedback?.Feedback}`);
 * ```
 */
export interface DescribeFeedback extends Binding.Service<
  DescribeFeedback,
  "AWS.DevOpsGuru.DescribeFeedback",
  () => Effect.Effect<
    (
      request?: devopsguru.DescribeFeedbackRequest,
    ) => Effect.Effect<
      devopsguru.DescribeFeedbackResponse,
      devopsguru.DescribeFeedbackError
    >
  >
> {}
export const DescribeFeedback = Binding.Service<DescribeFeedback>(
  "AWS.DevOpsGuru.DescribeFeedback",
);
