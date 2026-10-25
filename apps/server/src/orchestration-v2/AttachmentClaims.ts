import * as FileSystem from "effect/FileSystem";
import {
  ChatAttachmentId,
  getProviderAttachmentLimitError,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isSvgAttachment } from "@t3tools/shared/image";

import {
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  planAttachmentClaim,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

export class AttachmentClaimError extends Schema.TaggedError<AttachmentClaimError>()(
  "AttachmentClaimError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const validateAttachmentLimits = Effect.fn("AttachmentClaims.validateAttachmentLimits")(
  function* (attachments: ReadonlyArray<ChatAttachment>) {
    const error = getProviderAttachmentLimitError(attachments);
    if (error) return yield* new AttachmentClaimError({ message: error });
  },
);

export interface ClaimedAttachments {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly claimedPaths: ReadonlyArray<string>;
}

export function attachmentIsPendingUpload(attachment: ChatAttachment): boolean {
  return parseThreadSegmentFromAttachmentId(attachment.id) === PENDING_ATTACHMENT_THREAD_SEGMENT;
}

/** Remove partial claims only before dispatch, or after proving they were not accepted. */
export const releaseClaimedAttachments = Effect.fn("AttachmentClaims.releaseClaimedAttachments")(
  function* (claimedPaths: ReadonlyArray<string>) {
    if (claimedPaths.length === 0) return;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(claimedPaths, (path) => fileSystem.remove(path).pipe(Effect.ignore), {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.uninterruptible);
  },
);

/** Copies preserve the pending retry source after failed bootstrap; the pending sweep reclaims it. */
export const claimPendingAttachments = Effect.fn("AttachmentClaims.claimPendingAttachments")(
  function* (input: {
    readonly threadId: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) {
    yield* validateAttachmentLimits(input.attachments);
    if (
      new Set(input.attachments.map((attachment) => attachment.id)).size !==
      input.attachments.length
    ) {
      return yield* new AttachmentClaimError({
        message: "Duplicate attachment ids are not allowed.",
      });
    }
    if (!input.attachments.some(attachmentIsPendingUpload)) {
      return { attachments: input.attachments, claimedPaths: [] } satisfies ClaimedAttachments;
    }
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const claimedPaths: string[] = [];
    const attachments = yield* Effect.forEach(
      input.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (!attachmentIsPendingUpload(attachment)) {
            return attachment;
          }
          const claim = planAttachmentClaim({
            attachmentsDir: serverConfig.attachmentsDir,
            threadId: input.threadId,
            attachmentId: attachment.id,
          });
          if (!claim.ok) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
            });
          }
          const info = yield* fileSystem.stat(claim.currentPath).pipe(
            Effect.mapError(
              (cause) =>
                new AttachmentClaimError({
                  message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                  cause,
                }),
            ),
          );
          if (Number(info.size) !== attachment.sizeBytes) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
            });
          }
          const normalized: ChatAttachment = {
            ...attachment,
            id: ChatAttachmentId.make(claim.finalId),
            name:
              attachment.type === "file" &&
              isSvgAttachment(attachment) &&
              !/\.svg$/i.test(attachment.name)
                ? `${attachment.name}.svg`
                : attachment.name,
            mimeType: attachment.mimeType.toLowerCase(),
          };
          const expectedPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: normalized,
          });
          if (expectedPath !== claim.finalPath) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
            });
          }
          // Copies isolate edits from the retry source. Keep the uncancellable copy and rollback registration
          // uninterruptible so cleanup always sees completed writes.
          yield* fileSystem.copyFile(claim.currentPath, claim.finalPath).pipe(
            Effect.mapError(
              (cause) =>
                new AttachmentClaimError({
                  message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                  cause,
                }),
            ),
            Effect.andThen(Effect.sync(() => claimedPaths.push(claim.finalPath))),
            Effect.uninterruptible,
          );
          return normalized;
        }),
      { concurrency: 1 },
    ).pipe(Effect.onError(() => releaseClaimedAttachments(claimedPaths)));
    return { attachments, claimedPaths } satisfies ClaimedAttachments;
  },
);
