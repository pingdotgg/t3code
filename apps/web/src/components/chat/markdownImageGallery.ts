import { mediaKindFromPath } from "@t3tools/shared/mediaPreview";
import { mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";

export const markdownImageItems = new WeakMap<Element, ExpandedImageItem>();

export function markdownImageGallery(
  element: Element,
  selected: ExpandedImageItem,
): ExpandedImagePreview {
  const scope = element.closest("[data-image-gallery]") ?? element.closest(".chat-markdown");
  const images: ExpandedImageItem[] = [];
  let index = -1;
  for (const image of scope?.querySelectorAll("img") ?? []) {
    const registered = markdownImageItems.get(image);
    if (!registered) continue;
    const link = image.closest("a");
    const href = link?.getAttribute("href") ?? "";
    if (link && mediaKindFromPath(href) !== "image") continue;
    const linkedSource =
      resolveExternalWebLinkHost(href) !== null ? resolveProtocolRelativeMediaUrl(href) : null;
    const reference = mediaUrlReference(href);
    const item = linkedSource
      ? {
          ...registered,
          src: linkedSource,
          originalUrl: href,
          actionsSource: {
            kind: "image" as const,
            name: registered.name,
            src: linkedSource,
            ...(reference ? { reference } : {}),
          },
        }
      : registered;
    if (
      image === element ||
      (!markdownImageItems.has(element) && index < 0 && item.src === selected.src)
    ) {
      index = images.length;
      images.push(selected);
    } else {
      images.push(item);
    }
  }
  return index < 0 ? { images: [selected], index: 0 } : { images, index };
}

/**
 * Widens the single-image preview of an image in an expanded tool row to the images its group
 * viewed. Built from the group's entries: its thumbnail strip can be virtualized out of the DOM.
 */
export function workGroupImageGallery(
  viewedImages: ReadonlyArray<{ readonly path: string; readonly item: ExpandedImageItem | null }>,
  clickedPath: string | null,
  preview: ExpandedImagePreview,
): ExpandedImagePreview {
  const selected = preview.images[preview.index];
  if (preview.images.length !== 1 || !selected) return preview;
  const images: ExpandedImageItem[] = [];
  let index = -1;
  for (const viewed of viewedImages) {
    if (viewed.path === clickedPath) {
      index = images.length;
      images.push(selected);
    } else if (viewed.item) {
      images.push(viewed.item);
    }
  }
  return index < 0 ? preview : { images, index };
}
