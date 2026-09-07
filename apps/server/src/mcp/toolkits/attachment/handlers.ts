import { type ChatAttachment, MessageId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Upload from "../../../assets/AttachmentUpload.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import {
  newCommandId,
  readMutationCaller,
  readWritableThread,
  unavailable,
} from "../../threadAccess.ts";
import { AttachmentToolkit } from "./tools.ts";

export function resolveAttachmentReferences(
  requested: ReadonlyArray<ChatAttachment>,
  stored: ReadonlyArray<ChatAttachment>,
) {
  const owned = new Map(stored.map((attachment) => [attachment.id, attachment]));
  return Effect.forEach(requested, (attachment) => {
    const canonical = Claims.attachmentIsPendingUpload(attachment)
      ? attachment
      : owned.get(attachment.id);
    return canonical === undefined
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Attachments must be pending uploads or already belong to the target thread.",
          }),
        )
      : Effect.succeed(canonical);
  });
}

export const AttachmentHandlersLive = AttachmentToolkit.toLayer({
  t3_attachment_prepare_upload: (input) =>
    Effect.gen(function* () {
      yield* readMutationCaller();
      return yield* Upload.issueAttachmentUploadUrl(input.upload).pipe(
        Effect.mapError(unavailable),
      );
    }),
  t3_attachment_discard: (input) =>
    Effect.gen(function* () {
      yield* readMutationCaller();
      yield* Upload.deletePendingAttachment(input.attachmentId);
      return {};
    }),
  t3_thread_send_attachments: (input) =>
    Effect.gen(function* () {
      const { caller, threads, projection } = yield* readWritableThread(input.threadId);
      const attachments = yield* resolveAttachmentReferences(
        input.attachments,
        projection.messages.flatMap((message) => message.attachments),
      );
      const commandId = yield* newCommandId();
      const messageId = MessageId.make(commandId);
      const claimed = yield* Claims.claimPendingAttachments({
        threadId: projection.thread.id,
        attachments,
      }).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.message,
            }),
        ),
      );
      // Preserve claimed copies if dispatch may have committed before failing to return.
      const result = yield* threads
        .sendToThread({
          projectId: caller.projectId,
          threadId: projection.thread.id,
          commandId,
          messageId,
          text: input.message ?? "",
          attachments: claimed.attachments,
          mode: "auto",
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(unavailable));
      return {
        threadId: projection.thread.id,
        messageId,
        runId: result.run.id,
        status: result.run.status,
      };
    }),
});
