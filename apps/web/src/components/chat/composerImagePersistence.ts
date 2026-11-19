import type {
  ComposerImageAttachment,
  PersistedComposerImageAttachment,
} from "../../composerDraftStore";
import { readFileAsDataUrl } from "../../lib/imageCompression";

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
        const dataUrl =
          existingPersistedById.get(image.id)?.dataUrl ?? (await readFileAsDataUrl(image.file));
        return {
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl,
          ...(image.source ? { source: image.source } : {}),
        };
      } catch {
        return existingPersistedById.get(image.id);
      }
    }),
  );
  return staged.filter((attachment) => attachment !== undefined);
}
