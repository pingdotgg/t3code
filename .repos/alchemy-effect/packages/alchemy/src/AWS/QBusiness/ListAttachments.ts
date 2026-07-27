import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `ListAttachments` request with `applicationId` injected from the bound application.
 */
export interface ListAttachmentsRequest extends Omit<
  qbusiness.ListAttachmentsRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `ListAttachments` operation (IAM action
 * `qbusiness:ListAttachments`), scoped to one {@link Application}.
 *
 * Lists the files attached to chat conversations.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.ListAttachmentsHttp)`.
 *
 * @binding
 * @section Conversations
 * @example List Attachments
 * ```typescript
 * const listAttachments = yield* AWS.QBusiness.ListAttachments(app);
 *
 * const { attachments } = yield* listAttachments({ conversationId });
 * ```
 */
export interface ListAttachments extends Binding.Service<
  ListAttachments,
  "AWS.QBusiness.ListAttachments",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: ListAttachmentsRequest,
    ) => Effect.Effect<
      qbusiness.ListAttachmentsResponse,
      qbusiness.ListAttachmentsError
    >
  >
> {}
export const ListAttachments = Binding.Service<ListAttachments>(
  "AWS.QBusiness.ListAttachments",
);
