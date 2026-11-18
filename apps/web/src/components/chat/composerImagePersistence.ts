import type {
  ComposerImageAttachment,
  PersistedComposerImageAttachment,
} from "../../composerDraftStore";
import { MAX_STASH_IMAGE_DATA_URL_CHARS, readFileAsDataUrl } from "../../lib/imageCompression";
import { serializeImageEditorSession } from "../image-editor/imageEditorSession";

export async function serializeComposerImages(
  images: ReadonlyArray<ComposerImageAttachment>,
  persistedAttachments: ReadonlyArray<PersistedComposerImageAttachment>,
): Promise<PersistedComposerImageAttachment[]> {
  const existingPersistedById = new Map(
    persistedAttachments.map((attachment) => [attachment.id, attachment]),
  );
  const staged = await Promise.all(
    images.map(async (image) => {
      try {
        const existing = existingPersistedById.get(image.id);
        const dataUrl = existing?.dataUrl ?? (await readFileAsDataUrl(image.file));
        const sessionFits =
          image.imageEditor &&
          4 * Math.ceil(image.imageEditor.originalFile.size / 3) +
            image.imageEditor.originalFile.type.length +
            13 <=
            MAX_STASH_IMAGE_DATA_URL_CHARS;
        const imageEditor =
          existing?.imageEditor ??
          (sessionFits
            ? await serializeImageEditorSession(image.imageEditor).catch(() => undefined)
            : undefined);
        const imageEditRequest = image.imageEditRequest ?? image.imageEditor?.stagedRequest;
        return {
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl,
          ...(image.source ? { source: image.source } : {}),
          ...(imageEditor ? { imageEditor } : {}),
          ...(imageEditRequest ? { imageEditRequest } : {}),
        };
      } catch {
        return existingPersistedById.get(image.id);
      }
    }),
  );
  return staged.filter((attachment) => attachment !== undefined);
}
