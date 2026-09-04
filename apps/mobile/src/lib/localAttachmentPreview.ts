import { videoMimeType } from "@t3tools/shared/video";

import type { FileBackedComposerAttachment } from "./composerImages";
import { resolveOwnedComposerAttachmentFileUri } from "./composerAttachmentFiles";
import { shareLocalAttachment, type AttachmentPreviewFile } from "./attachmentDownload";
import { retainComposerAttachmentFileForPreview } from "../state/use-composer-drafts";

/** Retains the draft original for preview and gives each outgoing share its own lease. */
export async function loadLocalAttachmentPreview(
  attachment: FileBackedComposerAttachment,
  signal: AbortSignal,
): Promise<AttachmentPreviewFile | null> {
  if (signal.aborted) return null;
  const release = retainComposerAttachmentFileForPreview(attachment);
  try {
    const { File, Paths } = await import("expo-file-system");
    if (signal.aborted) {
      release();
      return null;
    }
    const uri =
      resolveOwnedComposerAttachmentFileUri(attachment.fileUri, Paths.document.uri) ??
      attachment.fileUri;
    const file = new File(uri);
    if (!file.exists) {
      throw new Error("The local attachment file is missing.");
    }
    let disposed = false;
    return {
      uri: file.uri,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        release();
      },
      share: async (shareSignal, sourceIdentifier) => {
        if (disposed || shareSignal.aborted) return;
        const releaseShare = retainComposerAttachmentFileForPreview(attachment);
        try {
          await shareLocalAttachment({
            uri: file.uri,
            attachment: {
              name: attachment.name,
              mimeType:
                attachment.type === "file"
                  ? (videoMimeType(attachment) ?? attachment.mimeType)
                  : attachment.mimeType,
            },
            signal: shareSignal,
            sourceIdentifier,
          });
        } finally {
          releaseShare();
        }
      },
    };
  } catch (cause) {
    release();
    if (signal.aborted) return null;
    throw new Error("This attachment is no longer available. Attach the file again.", { cause });
  }
}
