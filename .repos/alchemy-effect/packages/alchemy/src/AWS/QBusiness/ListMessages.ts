import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `ListMessages` request with `applicationId` injected from the bound application.
 */
export interface ListMessagesRequest extends Omit<
  qbusiness.ListMessagesRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `ListMessages` operation (IAM action
 * `qbusiness:ListMessages`), scoped to one {@link Application}.
 *
 * Lists the messages of a chat conversation.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.ListMessagesHttp)`.
 *
 * @binding
 * @section Conversations
 * @example List a Conversation's Messages
 * ```typescript
 * const listMessages = yield* AWS.QBusiness.ListMessages(app);
 *
 * const { messages } = yield* listMessages({ conversationId });
 * ```
 */
export interface ListMessages extends Binding.Service<
  ListMessages,
  "AWS.QBusiness.ListMessages",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: ListMessagesRequest,
    ) => Effect.Effect<
      qbusiness.ListMessagesResponse,
      qbusiness.ListMessagesError
    >
  >
> {}
export const ListMessages = Binding.Service<ListMessages>(
  "AWS.QBusiness.ListMessages",
);
