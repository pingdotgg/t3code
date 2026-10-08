import { type ChatAttachment, MessageId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Upload from "../../../assets/AttachmentUpload.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, readThread, unavailable } from "../../threadAccess.ts";
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

export const layer = McpToolAccess.toLayer(AttachmentToolkit, {
  t3_attachment_prepare_upload: McpToolAccess.writes((input) =>
    Upload.issueAttachmentUploadUrl(input.upload).pipe(Effect.mapError(unavailable)),
  ),
  t3_attachment_discard: McpToolAccess.writes((input) =>
    Upload.deletePendingAttachment(input.attachmentId).pipe(Effect.as({})),
  ),
  t3_thread_send_attachments: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { caller, projection } = yield* readThread(input.threadId, ["messages"]);
        if (projection.thread.archivedAt !== null)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Unarchive the target thread before sending attachments.",
          });
        const attachments = yield* resolveAttachmentReferences(
          input.attachments,
          projection.messages.flatMap((message) => message.attachments),
        );
        const commandId = yield* newCommandId();
        const messageId = MessageId.make(commandId);
        const result = yield* ThreadMessageIntake.sendToThread({
          projectId: projection.thread.projectId,
          threadId: projection.thread.id,
          commandId,
          messageId,
          ...(caller === undefined ? {} : { senderThreadId: caller.id }),
          text: input.message ?? "",
          attachments,
          mode: "auto",
          createdBy: "agent",
          creationSource: "mcp",
        }).pipe(
          Effect.mapError((error) =>
            error._tag === "AttachmentClaimError"
              ? new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message })
              : unavailable(),
          ),
        );
        return {
          threadId: projection.thread.id,
          messageId,
          runId: result.run.id,
          status: result.run.status,
        };
      }),
  ),
});
