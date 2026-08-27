import { describe, expect, it } from "vite-plus/test";

import { extractGeneratedImage } from "./generatedImage.ts";

describe("extractGeneratedImage", () => {
  it("reads a Codex-shaped MCP item", () => {
    expect(
      extractGeneratedImage({
        item: {
          generatedImage: { imageId: "abc.jpg", filename: "abc.jpg", mimeType: "image/jpeg" },
        },
      }),
    ).toEqual({ imageId: "abc.jpg", filename: "abc.jpg", mimeType: "image/jpeg" });
  });

  it("reads a Claude-shaped result", () => {
    expect(
      extractGeneratedImage({
        result: { image: { imageId: "xyz.png", filename: "xyz.png" } },
      })?.imageId,
    ).toBe("xyz.png");
  });

  it("reads structuredContent from an MCP tool result", () => {
    expect(
      extractGeneratedImage({
        structuredContent: {
          image: { imageId: "abc.png", filename: "abc.png", mimeType: "image/png" },
          path: "/tmp/abc.png",
        },
      }),
    ).toEqual({ imageId: "abc.png", filename: "abc.png", mimeType: "image/png" });
  });
});
