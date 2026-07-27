import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `PutFeedback` request with `applicationId` injected from the bound application.
 */
export interface PutFeedbackRequest extends Omit<
  qbusiness.PutFeedbackRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `PutFeedback` operation (IAM action
 * `qbusiness:PutFeedback`), scoped to one {@link Application}.
 *
 * Records end-user usefulness feedback (thumbs up/down and reasons)
 * for a chat message, which Amazon Q Business uses to improve
 * response quality.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.PutFeedbackHttp)`.
 *
 * @binding
 * @section Chat
 * @example Submit Feedback for a Message
 * ```typescript
 * const feedback = yield* AWS.QBusiness.PutFeedback(app);
 *
 * yield* feedback({
 *   conversationId: reply.conversationId!,
 *   messageId: reply.systemMessageId!,
 *   messageUsefulness: {
 *     usefulness: "USEFUL",
 *     submittedAt: new Date(),
 *   },
 * });
 * ```
 */
export interface PutFeedback extends Binding.Service<
  PutFeedback,
  "AWS.QBusiness.PutFeedback",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: PutFeedbackRequest,
    ) => Effect.Effect<
      qbusiness.PutFeedbackResponse,
      qbusiness.PutFeedbackError
    >
  >
> {}
export const PutFeedback = Binding.Service<PutFeedback>(
  "AWS.QBusiness.PutFeedback",
);
