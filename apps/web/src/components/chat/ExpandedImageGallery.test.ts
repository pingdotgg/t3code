import { describe, expect, it } from "vite-plus/test";

import {
  buildExpandedImagePreviewFromElements,
  registerExpandedImagePreviewItem,
  type ExpandedImageElement,
} from "./ExpandedImagePreview";

function image(src: string, alt: string, currentSrc = ""): ExpandedImageElement {
  return { src, currentSrc, alt };
}

describe("expanded image gallery", () => {
  it("builds a document-ordered gallery around the selected image", () => {
    const first = image("https://example.test/first.png", "First");
    const selected = image(
      "https://example.test/second-small.png",
      "  Second  ",
      "https://example.test/second-large.png",
    );
    const unnamed = image("https://example.test/third.png", "   ");

    expect(buildExpandedImagePreviewFromElements([first, selected, unnamed], selected)).toEqual({
      images: [
        { src: "https://example.test/first.png", name: "First" },
        { src: "https://example.test/second-large.png", name: "Second" },
        { src: "https://example.test/third.png", name: "image" },
      ],
      index: 1,
    });
  });

  it("uses element identity when two images have the same source", () => {
    const first = image("https://example.test/repeated.png", "Before");
    const second = image("https://example.test/repeated.png", "After");

    expect(buildExpandedImagePreviewFromElements([first, second], second)?.index).toBe(1);
  });

  it("keeps registered media actions while using the rendered source", () => {
    const selected = image(
      "https://example.test/preview.png",
      "Preview",
      "https://example.test/rendered.png",
    );
    registerExpandedImagePreviewItem(selected, {
      src: selected.src,
      name: "Preview",
      originalUrl: "https://github.com/example/repo/image.png",
      actionsSource: {
        kind: "image",
        name: "Preview",
        src: selected.src,
        reference: { kind: "url", url: "https://github.com/example/repo/image.png" },
      },
    });

    expect(buildExpandedImagePreviewFromElements([selected], selected)).toEqual({
      images: [
        {
          src: selected.currentSrc,
          name: "Preview",
          originalUrl: "https://github.com/example/repo/image.png",
          actionsSource: {
            kind: "image",
            name: "Preview",
            src: selected.currentSrc,
            reference: { kind: "url", url: "https://github.com/example/repo/image.png" },
          },
        },
      ],
      index: 0,
    });
  });

  it("rejects a selected element that cannot appear in the gallery", () => {
    const selected = image("  ", "Missing");

    expect(
      buildExpandedImagePreviewFromElements(
        [image("https://example.test/available.png", "Available"), selected],
        selected,
      ),
    ).toBeNull();
  });
});
