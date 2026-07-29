import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `DeleteConversation` request with `applicationId` injected from the bound application.
 */
export interface DeleteConversationRequest extends Omit<
  qbusiness.DeleteConversationRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `DeleteConversation` operation (IAM action
 * `qbusiness:DeleteConversation`), scoped to one {@link Application}.
 *
 * Deletes a chat conversation and its messages.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.DeleteConversationHttp)`.
 *
 * @binding
 * @section Conversations
 * @example Delete a Conversation
 * ```typescript
 * const deleteConversation = yield* AWS.QBusiness.DeleteConversation(app);
 *
 * yield* deleteConversation({ conversationId });
 * ```
 */
export interface DeleteConversation extends Binding.Service<
  DeleteConversation,
  "AWS.QBusiness.DeleteConversation",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: DeleteConversationRequest,
    ) => Effect.Effect<
      qbusiness.DeleteConversationResponse,
      qbusiness.DeleteConversationError
    >
  >
> {}
export const DeleteConversation = Binding.Service<DeleteConversation>(
  "AWS.QBusiness.DeleteConversation",
);
