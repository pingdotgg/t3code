import { describe, expect, it } from "vite-plus/test";

import {
  restoreMarkdownImageSourcesForClipboard,
  serializeMarkdownImageElement,
} from "./markdown-clipboard";
import { resolveMarkdownImageFileLinkMeta } from "./markdown-links";

function makeImageAttributes(initial: Record<string, string>) {
  const attributes = new Map(Object.entries(initial));
  return {
    attributes,
    element: {
      getAttribute(name: string) {
        return attributes.get(name) ?? null;
      },
      removeAttribute(name: string) {
        attributes.delete(name);
      },
      setAttribute(name: string, value: string) {
        attributes.set(name, value);
      },
    },
  };
}

describe("workspace image clipboard serialization", () => {
  it("uses the original Markdown source instead of the signed rendering URL", () => {
    const { element } = makeImageAttributes({
      alt: "Result",
      "data-markdown-src": "screenshots/result.png",
      src: "https://environment.example/api/assets/signed-token/result.png",
    });

    expect(serializeMarkdownImageElement(element)).toBe("![Result](screenshots/result.png)");
  });

  it("round-trips an encoded Windows path copied from a work-log image", () => {
    const imagePath = "C:\\Users\\mike\\dev-stuff\\t3code\\result.png";
    const encodedImagePath = encodeURIComponent(imagePath);
    const { element } = makeImageAttributes({
      alt: "Generated image",
      "data-markdown-src": encodedImagePath,
      src: "https://environment.example/api/assets/signed-token/result.png",
    });

    const copiedMarkdown = serializeMarkdownImageElement(element);
    const copiedSource = /^!\[[^\]]*\]\((.*)\)$/.exec(copiedMarkdown)?.[1];

    expect(copiedMarkdown).toBe(`![Generated image](${encodedImagePath})`);
    expect(resolveMarkdownImageFileLinkMeta(copiedSource)?.filePath).toBe(imagePath);
  });

  it("restores original sources and removes signed-URL metadata before rich copy", () => {
    const { attributes, element } = makeImageAttributes({
      alt: "Result",
      "data-markdown-src": "screenshots/result.png",
      src: "https://environment.example/api/assets/signed-token/result.png",
    });

    restoreMarkdownImageSourcesForClipboard([element]);

    expect(Object.fromEntries(attributes)).toEqual({
      alt: "Result",
      src: "screenshots/result.png",
    });
  });

  it("keeps ordinary remote image sources unchanged", () => {
    const { element } = makeImageAttributes({
      alt: "Remote",
      src: "https://example.com/result.png",
    });

    expect(serializeMarkdownImageElement(element)).toBe(
      "![Remote](https://example.com/result.png)",
    );
  });
});
