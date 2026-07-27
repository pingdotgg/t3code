import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Archive } from "./Archive.ts";

/**
 * Runtime binding for `ses:GetArchiveMessage`.
 *
 * Fetches a pre-signed download link, envelope, and ingress metadata
 * for one archived message (by `ArchivedMessageId` from a search
 * result). IAM access is granted on the bound archive's ARN. Provide the implementation with
 * `Effect.provide(AWS.MailManager.GetArchiveMessageHttp)`.
 * @binding
 * @section Reading Archived Messages
 * @example Download an Archived Message
 * ```typescript
 * const getMessage = yield* MailManager.GetArchiveMessage(archive);
 *
 * // runtime
 * const { MessageDownloadLink, Envelope } = yield* getMessage({ ArchivedMessageId });
 * ```
 */
export interface GetArchiveMessage extends Binding.Service<
  GetArchiveMessage,
  "AWS.MailManager.GetArchiveMessage",
  (
    archive: Archive,
  ) => Effect.Effect<
    (
      request: mm.GetArchiveMessageRequest,
    ) => Effect.Effect<mm.GetArchiveMessageResponse, mm.GetArchiveMessageError>
  >
> {}
export const GetArchiveMessage = Binding.Service<GetArchiveMessage>(
  "AWS.MailManager.GetArchiveMessage",
);
