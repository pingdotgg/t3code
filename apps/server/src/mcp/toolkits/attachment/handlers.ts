import {
  ATTACHMENT_UPLOAD_URL_TTL_MS,
  type ChatAttachment,
  MessageId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
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

/**
 * As long as the pending file can live. The sweep counts its 24 hours from when
 * the upload finishes, which can be up to the upload URL's lifetime after issue.
 */
const UPLOAD_OWNER_TTL_MS = 24 * 60 * 60 * 1000 + ATTACHMENT_UPLOAD_URL_TTL_MS;

/** A thread owns its uploads across provider sessions; an outside client per MCP session. */
const uploadOwner = McpInvocationContext.McpInvocationContext.pipe(
  Effect.map((scope) => scope.thread?.threadId ?? scope.requestNamespace),
);

export const layer = McpToolAccess.toLayer(
  AttachmentToolkit,
  Effect.sync(() => {
    // Which caller prepared each pending upload, so only that caller can discard it.
    const uploadOwners = new Map<string, { readonly owner: string; readonly issuedAt: number }>();
    return {
      t3_attachment_prepare_upload: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          const result = yield* Upload.issueAttachmentUploadUrl(input.upload).pipe(
            Effect.mapError(unavailable),
          );
          const now = yield* Clock.currentTimeMillis;
          for (const [id, entry] of uploadOwners) {
            if (now - entry.issuedAt > UPLOAD_OWNER_TTL_MS) uploadOwners.delete(id);
          }
          uploadOwners.set(result.attachmentId, { owner: yield* uploadOwner, issuedAt: now });
          return result;
        }),
      ),
      t3_attachment_discard: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          if (uploadOwners.get(input.attachmentId)?.owner !== (yield* uploadOwner)) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Only the caller that prepared a pending upload can discard it.",
            });
          }
          yield* Upload.deletePendingAttachment(input.attachmentId);
          uploadOwners.delete(input.attachmentId);
          return {};
        }),
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
                  ? new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: error.message,
                    })
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
    };
  }),
);
