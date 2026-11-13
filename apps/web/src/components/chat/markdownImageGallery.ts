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
  const scope =
    element.closest("[data-image-gallery]") ??
    element.closest(".chat-markdown") ??
    linkedGallery(element);
  // An image shown outside its linked gallery is found there by its source and name.
  const linked = markdownImageItems.has(element) && !scope?.contains(element);
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
      (index < 0 &&
        item.src === selected.src &&
        (linked ? item.name === selected.name : !markdownImageItems.has(element)))
    ) {
      index = images.length;
      images.push(selected);
    } else {
      images.push(item);
    }
  }
  return index < 0 ? { images: [selected], index: 0 } : { images, index };
}

function linkedGallery(element: Element): Element | null {
  const id = element.closest("[data-image-gallery-for]")?.getAttribute("data-image-gallery-for");
  return id
    ? element.ownerDocument.querySelector(`[data-image-gallery="${CSS.escape(id)}"]`)
    : null;
}
