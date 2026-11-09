import type { FilePreviewImage, FilePreviewImages } from "./FilePreviewModal.types";

/** 1×1 transparent PNG so a failed page can finish loading instead of spinning forever. */
export const FAILED_IMAGE_SOURCE = {
  uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
} as const;

type ImageViewingSource = { readonly uri: string } | Record<string, never>;

function imageViewingSource(
  image: FilePreviewImage,
  index: number,
  uriSources: Map<string, { readonly uri: string }>,
  pendingSources: Map<number, Record<string, never>>,
): ImageViewingSource {
  if (image.uri) {
    const cached = uriSources.get(image.uri);
    if (cached) return cached;
    const next = { uri: image.uri };
    uriSources.set(image.uri, next);
    return next;
  }
  if (image.failed) return FAILED_IMAGE_SOURCE;
  const pending = pendingSources.get(index);
  if (pending) return pending;
  const next = {};
  pendingSources.set(index, next);
  return next;
}

function imageViewingKey(image: FilePreviewImage | undefined, index: number) {
  if (image?.uri) return image.uri;
  if (image?.failed) return `failed:${index}`;
  return `pending:${index}`;
}

// Images still resolving show the viewer's loading page, and remount by key once their URL arrives.
// Stable source object identity keeps the selected page's pan/zoom when a sibling settles.
export function imageViewingProps(
  source: FilePreviewImages,
  uriSources: Map<string, { readonly uri: string }> = new Map(),
  pendingSources: Map<number, Record<string, never>> = new Map(),
) {
  return {
    images: source.images.map((image, index) =>
      imageViewingSource(image, index, uriSources, pendingSources),
    ),
    keyExtractor: (_: unknown, index: number) => imageViewingKey(source.images[index], index),
    // Stays fixed: react-native-image-viewing remounts the Modal and replays its fade when it changes.
    imageIndex: source.selectedIndex,
  };
}
