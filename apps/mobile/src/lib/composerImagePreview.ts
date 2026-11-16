import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import * as Schema from "effect/Schema";
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

const inFlightPreviews = new Map<string, Promise<string | null>>();

// Mounted previews and sent-image handoffs each hold the cached file they show; the last
// release deletes it. Deletion waits a task so a preview rebuilt mid-write can take it over.
const previewFileHolders = new Map<string, number>();

/** Holds a cached preview file; false when the uri is not one, so there is nothing to release. */
export function retainComposerImagePreviewFile(uri: string): boolean {
  const holders = previewFileHolders.get(uri);
  if (holders === undefined) return false;
  previewFileHolders.set(uri, holders + 1);
  return true;
}

export function releaseComposerImagePreviewFile(uri: string): void {
  const holders = previewFileHolders.get(uri);
  if (holders === undefined) return;
  previewFileHolders.set(uri, holders - 1);
  if (holders > 1) return;
  setTimeout(() => {
    if (previewFileHolders.get(uri) !== 0) return;
    previewFileHolders.delete(uri);
    void deletePreviewFile(uri);
  }, 0);
}

async function deletePreviewFile(uri: string): Promise<void> {
  try {
    const { Directory, File, Paths } = await import("expo-file-system");
    const file = new File(
      new Directory(Paths.cache, PREVIEW_CACHE_DIRECTORY),
      uri.slice(uri.lastIndexOf("/") + 1),
    );
    if (file.exists) file.delete();
  } catch (error) {
    console.warn("[composer-attachments] could not remove a cached image preview", error);
  }
}

const holdPreviewFile = (uri: string | null) => {
  if (uri !== null) previewFileHolders.set(uri, (previewFileHolders.get(uri) ?? 0) + 1);
  return uri;
};

// A render reads the atom before its effect subscribes, so the registry can drop and rebuild it
// mid-write; a second writer would delete the first one's partial file and fail its own move.
function materializePreviewOnce(id: string, dataUrl: string): Promise<string | null> {
  const pending = inFlightPreviews.get(id);
  if (pending) return pending;
  const next = materializeDataUrlPreview(id, dataUrl).finally(() => inFlightPreviews.delete(id));
  inFlightPreviews.set(id, next);
  return next;
}

class ImagePreviewCacheError extends Schema.TaggedError<ImagePreviewCacheError>()(
  "ImagePreviewCacheError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not cache an image preview.";
  }
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
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          materializePreviewOnce(attachment.id, attachment.previewUri).then(holdPreviewFile),
        catch: (cause) => new ImagePreviewCacheError({ cause }),
      }),
      (uri) =>
        uri === null ? Effect.void : Effect.sync(() => releaseComposerImagePreviewFile(uri)),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("[composer-attachments] could not cache an image preview", error).pipe(
          Effect.as(null),
        ),
      ),
    ),
  ).pipe(Atom.withLabel(`composer-image-preview:${attachment.id}`)),
);
