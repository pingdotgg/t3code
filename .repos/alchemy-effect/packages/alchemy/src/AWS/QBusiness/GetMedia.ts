import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `GetMedia` request with `applicationId` injected from the bound application.
 */
export interface GetMediaRequest extends Omit<
  qbusiness.GetMediaRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `GetMedia` operation (IAM action
 * `qbusiness:GetMedia`), scoped to one {@link Application}.
 *
 * Fetches the media object (e.g. an extracted image) associated with
 * a chat message.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.GetMediaHttp)`.
 *
 * @binding
 * @section Conversations
 * @example Fetch Message Media
 * ```typescript
 * const getMedia = yield* AWS.QBusiness.GetMedia(app);
 *
 * const media = yield* getMedia({ conversationId, messageId, mediaId });
 * ```
 */
export interface GetMedia extends Binding.Service<
  GetMedia,
  "AWS.QBusiness.GetMedia",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: GetMediaRequest,
    ) => Effect.Effect<qbusiness.GetMediaResponse, qbusiness.GetMediaError>
  >
> {}
export const GetMedia = Binding.Service<GetMedia>("AWS.QBusiness.GetMedia");
