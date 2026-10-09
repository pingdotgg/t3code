// @vitest-environment jsdom

import { describe, expect, it } from "vite-plus/test";

import type { ExpandedImageItem } from "./ExpandedImagePreview";
import { markdownImageGallery, markdownImageItems } from "./markdownImageGallery";

function reply(...media: Array<["img" | "video", string]>) {
  const scope = document.createElement("div");
  scope.className = "chat-markdown";
  const elements = media.map(([tag, name]) => {
    const element = document.createElement(tag);
    const item: ExpandedImageItem = {
      src: `https://example.com/${name}`,
      name,
      ...(tag === "video" ? { type: "video" as const } : {}),
    };
    markdownImageItems.set(element, item);
    scope.append(element);
    return { element, item };
  });
  return elements;
}

describe("markdownImageGallery", () => {
  it("steps through a reply's images and videos in document order", () => {
    const [, clip] = reply(["img", "before.png"], ["video", "clip.mp4"], ["img", "after.png"]);

    const gallery = markdownImageGallery(clip!.element, clip!.item);

    expect(gallery.images.map((item) => item.name)).toEqual([
      "before.png",
      "clip.mp4",
      "after.png",
    ]);
    expect(gallery.index).toBe(1);
  });
});
