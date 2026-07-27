import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:PutFeedback`.
 *
 * Records feedback on an insight's usefulness (`VALID` / `NOT_VALID` and variants) — feeding triage decisions back into DevOps Guru.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.PutFeedbackHttp)`.
 * @binding
 * @section Feedback
 * @example Rate an Insight
 * ```typescript
 * // init — account-level binding, no resource argument
 * const putFeedback = yield* AWS.DevOpsGuru.PutFeedback();
 *
 * // runtime
 * yield* putFeedback({
 *   InsightFeedback: { Id: insightId, Feedback: "VALID_COLLECTION" },
 * });
 * ```
 */
export interface PutFeedback extends Binding.Service<
  PutFeedback,
  "AWS.DevOpsGuru.PutFeedback",
  () => Effect.Effect<
    (
      request?: devopsguru.PutFeedbackRequest,
    ) => Effect.Effect<
      devopsguru.PutFeedbackResponse,
      devopsguru.PutFeedbackError
    >
  >
> {}
export const PutFeedback = Binding.Service<PutFeedback>(
  "AWS.DevOpsGuru.PutFeedback",
);
