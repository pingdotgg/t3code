import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `ListConversations` request with `applicationId` injected from the bound application.
 */
export interface ListConversationsRequest extends Omit<
  qbusiness.ListConversationsRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `ListConversations` operation (IAM action
 * `qbusiness:ListConversations`), scoped to one {@link Application}.
 *
 * Lists a user's chat conversations in the application.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.ListConversationsHttp)`.
 *
 * @binding
 * @section Conversations
 * @example List Conversations
 * ```typescript
 * const listConversations = yield* AWS.QBusiness.ListConversations(app);
 *
 * const { conversations } = yield* listConversations();
 * ```
 */
export interface ListConversations extends Binding.Service<
  ListConversations,
  "AWS.QBusiness.ListConversations",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: ListConversationsRequest,
    ) => Effect.Effect<
      qbusiness.ListConversationsResponse,
      qbusiness.ListConversationsError
    >
  >
> {}
export const ListConversations = Binding.Service<ListConversations>(
  "AWS.QBusiness.ListConversations",
);
