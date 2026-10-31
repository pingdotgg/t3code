import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import { Atom } from "effect/reactivity";

import type { DraftComposerImageAttachment } from "./composerImages";

const PREVIEW_CACHE_DIRECTORY = "t3-composer-previews";

async function materializeDataUrlPreview(id: string, dataUrl: string): Promise<string | null> {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const { Directory, File, Paths } = await import("expo-file-system");
  const mimeType = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? "image/jpeg";
  const extension = (mimeType.split("/")[1] ?? "jpg").replace("jpeg", "jpg");
  const directory = new Directory(Paths.cache, PREVIEW_CACHE_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, `${id}.${extension}`);
  if (file.exists) return file.uri;
  // Write beside the cache entry and move it in, so a failed or interrupted write is never reused.
  const partial = new File(directory, `${id}.${extension}.partial`);
  if (partial.exists) partial.delete();
  partial.create();
  try {
    await partial.write(dataUrl.slice(comma + 1), { encoding: "base64" });
  } catch (error) {
    partial.delete();
    throw error;
  }
  await partial.move(file);
  return file.uri;
}

/**
 * Keyed by attachment id only: the cached file is named by id, and an upload
 * reference landing on the same draft must not restart materialization and
 * blank the preview. Hashing the id also avoids rehashing a multi-megabyte data URL.
 */
export class MaterializedPreviewKey implements Equal.Equal {
  constructor(readonly attachment: DraftComposerImageAttachment) {}
  [Equal.symbol](that: unknown): boolean {
    return that instanceof MaterializedPreviewKey && that.attachment.id === this.attachment.id;
  }
  [Hash.symbol](): number {
    return Hash.string(this.attachment.id);
  }
}

export const materializedPreviewAtom = Atom.family(({ attachment }: MaterializedPreviewKey) =>
  Atom.make(
    Effect.tryPromise(() => materializeDataUrlPreview(attachment.id, attachment.previewUri)).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          console.warn("[composer-attachments] could not cache an image preview", error);
          return null;
        }),
      ),
    ),
  ).pipe(Atom.withLabel(`composer-image-preview:${attachment.id}`)),
);
