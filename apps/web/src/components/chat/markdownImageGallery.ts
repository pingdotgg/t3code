import { mediaKindFromPath } from "@t3tools/shared/filePreview";
import { mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";

// Weak keys retain resolved media actions only while the rendered image is reachable.
export const markdownImageItems = new WeakMap<Element, ExpandedImageItem>();

/** Collect in document order only when opened, including PR sections separated by videos. */
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
