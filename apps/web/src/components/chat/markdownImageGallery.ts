import { mediaKindFromPath } from "@t3tools/shared/mediaPreview";
import { mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import {
  resolveMarkdownMediaPreview,
  type ExpandedImageItem,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { pullRequestMediaResource } from "@t3tools/client-runtime/pull-request-markdown";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";

export const markdownImageItems = new WeakMap<Element, ExpandedImageItem>();

export async function resolveMarkdownImageGallery(
  gallery: ExpandedImagePreview,
  input: Omit<Parameters<typeof resolveMarkdownMediaPreview>[0], "source">,
): Promise<ExpandedImagePreview> {
  const images = await Promise.all(
    gallery.images.map(async (item) => {
      if (item.actionsSource?.asset || !item.originalUrl || !input.sourceControlMedia || !input.cwd)
        return item;
      if (!pullRequestMediaResource(item.originalUrl, input.cwd)) return item;
      try {
        const resolved = await resolveMarkdownMediaPreview({ ...input, source: item.originalUrl });
        return resolved?.images[0] ?? item;
      } catch {
        return item;
      }
    }),
  );
  return { ...gallery, images };
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
