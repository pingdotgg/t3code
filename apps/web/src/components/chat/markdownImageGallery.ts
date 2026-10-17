import { mediaKindFromPath } from "@t3tools/shared/filePreview";
import { mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";

export const markdownImageItems = new WeakMap<Element, ExpandedImageItem>();

export function linkedMediaItem(
  asset: { environmentId: EnvironmentId; resource: AssetResource },
  href: string,
  name: string,
): ExpandedImageItem {
  const kind = mediaKindFromPath(href) === "video" ? "video" : "image";
  return {
    src: null,
    name,
    ...(kind === "video" ? { type: "video", autoPlay: false } : {}),
    originalUrl: href,
    actionsSource: { kind, name, src: null, asset },
  };
}

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
    const linkedAsset = link?.getAttribute("data-linear-media");
    const linkedSource =
      resolveExternalWebLinkHost(href) !== null ? resolveProtocolRelativeMediaUrl(href) : null;
    const reference = mediaUrlReference(href);
    const item = linkedAsset
      ? linkedMediaItem(JSON.parse(linkedAsset), href, registered.name)
      : linkedSource
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
