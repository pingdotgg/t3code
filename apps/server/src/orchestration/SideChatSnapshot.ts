import type { OrchestrationThread, ThreadId, ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ServerConfig } from "../config.ts";
import {
  createAttachmentId,
  resolveAttachmentPath,
  parseAttachmentFileExtension,
} from "../attachmentStore.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

export const snapshotSideChat = Effect.fn("snapshotSideChat")(function* (
  source: OrchestrationThread,
  threadId: ThreadId,
) {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const copied = new Map<string, ChatAttachment>();
  const messages = [];
  for (const message of source.messages) {
    const attachments: ChatAttachment[] = [];
    for (const attachment of message.attachments ?? []) {
      let clone = copied.get(attachment.id);
      if (!clone) {
        const id = createAttachmentId(
          threadId,
          parseAttachmentFileExtension(attachment.id) ?? undefined,
        );
        if (!id)
          return yield* new OrchestrationCommandInvariantError({
            commandType: "thread.side.create",
            detail: "Invalid side-chat attachment identity.",
          });
        clone = { ...attachment, id };
        const from = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
        const to = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: clone,
        });
        if (!from || !to)
          return yield* new OrchestrationCommandInvariantError({
            commandType: "thread.side.create",
            detail: `Cannot snapshot attachment ${attachment.name}.`,
          });
        yield* fs.copyFile(from, to);
        copied.set(attachment.id, clone);
      }
      attachments.push(clone);
    }
    messages.push({
      ...message,
      attachments,
      ...(message.context
        ? {
            context: {
              ...message.context,
              records: message.context.records.map((record) =>
                (record.kind === "image" || record.kind === "file") && "attachmentId" in record
                  ? {
                      ...record,
                      attachmentId: copied.get(record.attachmentId)?.id ?? record.attachmentId,
                    }
                  : record,
              ),
            },
          }
        : {}),
      ...(message.streaming
        ? {
            text: message.text + "\n[This answer was still in progress when the side chat opened.]",
            streaming: false,
          }
        : {}),
    });
  }
  return { ...source, messages };
});
