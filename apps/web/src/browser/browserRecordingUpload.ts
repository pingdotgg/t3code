import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingTooLargeError,
  PreviewAutomationRecordingDeadlineExpiredError,
  type DesktopPreviewRecordingArtifact,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { attachmentEnvironment } from "~/state/attachments";
import { readPreparedConnection } from "~/state/session";

/** Sends the finished encoded file once; capture frames never cross the environment connection. */
export async function uploadBrowserRecording(
  { environmentId, threadId }: ScopedThreadRef,
  artifact: DesktopPreviewRecordingArtifact,
  blob: Blob,
  deadlineMs: number,
): Promise<string> {
  if (blob.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
    throw new PreviewAutomationRecordingTooLargeError({ threadId });
  }
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    upload: {
      type: "file",
      name: artifact.path.split(/[\\/]/).at(-1) ?? artifact.id,
      mimeType: artifact.mimeType,
      sizeBytes: blob.size,
    },
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) => {
      const controller = new AbortController();
      // Encoding, saving and minting consume the same request budget. Leave time to reply.
      const remainingMs = deadlineMs - Date.now() - 1_000;
      return {
        abort: () => controller.abort(),
        done:
          remainingMs <= 0
            ? Promise.reject(new Error("Recording transfer deadline expired."))
            : fetch(url, {
                method: "POST",
                headers: { "Content-Type": artifact.mimeType },
                body: blob,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(remainingMs)]),
              }).then((response) => {
                if (!response.ok)
                  throw new Error(`Recording upload rejected (${response.status}).`);
              }),
      };
    },
  });
  if (result.status !== "uploaded") {
    if (result.attachmentId) {
      deletePendingAttachmentUpload({
        registry: appAtomRegistry,
        remove: attachmentEnvironment.remove,
        environmentId,
        attachmentId: result.attachmentId,
      });
    }
    const cause = result.status === "failed" ? result.error : undefined;
    if (Date.now() >= deadlineMs - 1_000) {
      throw new PreviewAutomationRecordingDeadlineExpiredError({ threadId, cause });
    }
    throw new PreviewAutomationRecordingTransferError({
      threadId,
      cause,
    });
  }
  return result.attachmentId;
}
