import { videoMimeType } from "@t3tools/shared/video";

import type { DraftComposerFileAttachment } from "./composerImages";
import { resolveOwnedComposerAttachmentFileUri } from "./composerAttachmentFiles";
import { shareLocalAttachment, type AttachmentPreviewFile } from "./attachmentDownload";
import { retainComposerAttachmentFileForPreview } from "../state/use-composer-drafts";

/** Retains the draft original for playback and gives each outgoing share its own lease. */
export async function loadLocalVideoPreview(
  attachment: DraftComposerFileAttachment,
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
              mimeType: videoMimeType(attachment) ?? attachment.mimeType,
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
    throw new Error("This video is no longer available. Attach the file again.", { cause });
  }
}
