export interface ExpandedImageItem {
  src: string;
  name: string;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

export function buildExpandedImagePreview(
  images: ReadonlyArray<{
    id: string;
    name: string;
    previewUrl?: string;
    previewUrlKind?: "asset";
  }>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const previewableImages = images.flatMap((image) =>
    image.previewUrl &&
    isSafeAssistantImagePreviewUrl(image.previewUrl, {
      trustedAsset: image.previewUrlKind === "asset",
    })
      ? [{ id: image.id, src: image.previewUrl, name: image.name }]
      : [],
  );
  if (previewableImages.length === 0) {
    return null;
  }
  const selectedIndex = previewableImages.findIndex((image) => image.id === selectedImageId);
  if (selectedIndex < 0) {
    return null;
  }
  return {
    images: previewableImages.map((image) => ({
      src: image.src,
      name: image.name,
    })),
    index: selectedIndex,
  };
}
import { isSafeAssistantImagePreviewUrl } from "./AssistantMessageImages";
