import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Archive } from "./Archive.ts";

/**
 * Runtime binding for `ses:GetArchiveMessageContent`.
 *
 * Fetches the parsed text/HTML body of one archived message (by
 * `ArchivedMessageId` from a search result). IAM access is granted on
 * the bound archive's ARN. Provide the implementation with
 * `Effect.provide(AWS.MailManager.GetArchiveMessageContentHttp)`.
 * @binding
 * @section Reading Archived Messages
 * @example Read a Message Body
 * ```typescript
 * const getMessageContent = yield* MailManager.GetArchiveMessageContent(archive);
 *
 * // runtime
 * const { Body } = yield* getMessageContent({ ArchivedMessageId });
 * yield* Effect.log(Body?.Text ?? Body?.Html ?? "(malformed)");
 * ```
 */
export interface GetArchiveMessageContent extends Binding.Service<
  GetArchiveMessageContent,
  "AWS.MailManager.GetArchiveMessageContent",
  (
    archive: Archive,
  ) => Effect.Effect<
    (
      request: mm.GetArchiveMessageContentRequest,
    ) => Effect.Effect<
      mm.GetArchiveMessageContentResponse,
      mm.GetArchiveMessageContentError
    >
  >
> {}
export const GetArchiveMessageContent =
  Binding.Service<GetArchiveMessageContent>(
    "AWS.MailManager.GetArchiveMessageContent",
  );
