import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `ChatSync` request with `applicationId` injected from the bound application.
 */
export interface ChatSyncRequest extends Omit<
  qbusiness.ChatSyncInput,
  "applicationId"
> {}

/**
 * Runtime binding for the `ChatSync` operation (IAM action
 * `qbusiness:ChatSync`), scoped to one {@link Application}.
 *
 * Sends a user message to the application and returns the full
 * AI-generated answer in one response, including source attributions
 * and any suggested plugin actions.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.ChatSyncHttp)`.
 *
 * @binding
 * @section Chat
 * @example Ask a Question
 * ```typescript
 * const chat = yield* AWS.QBusiness.ChatSync(app);
 *
 * const reply = yield* chat({ userMessage: "What is our travel policy?" });
 * console.log(reply.systemMessage);
 * ```
 */
export interface ChatSync extends Binding.Service<
  ChatSync,
  "AWS.QBusiness.ChatSync",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: ChatSyncRequest,
    ) => Effect.Effect<qbusiness.ChatSyncOutput, qbusiness.ChatSyncError>
  >
> {}
export const ChatSync = Binding.Service<ChatSync>("AWS.QBusiness.ChatSync");
