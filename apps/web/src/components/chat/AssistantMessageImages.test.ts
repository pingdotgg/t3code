import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AssistantMessageImages,
  isSafeAssistantImagePreviewUrl,
} from "./AssistantMessageImages.tsx";

describe("isSafeAssistantImagePreviewUrl", () => {
  it.each([
    "data:image/png;base64,aGVsbG8=",
    "blob:https://app.t3.codes/generated-image-1",
    "/api/assets/signed-token/generated.png",
  ])("accepts renderable image source %s", (url) => {
    expect(isSafeAssistantImagePreviewUrl(url)).toBe(true);
  });

  it.each([
    "file:///C:/Users/me/private.png",
    "C:\\Users\\me\\private.png",
    "https://example.com/untrusted.png",
    "https://environment.test/api/assets/signed-token/generated.png",
    "javascript:alert(1)",
    "data:text/html;base64,aGVsbG8=",
  ])("rejects unsafe image source %s", (url) => {
    expect(isSafeAssistantImagePreviewUrl(url)).toBe(false);
  });

  it("accepts a remote environment asset only with trusted asset provenance", () => {
    const url = "https://environment.test/api/assets/signed-token/generated.png";
    expect(isSafeAssistantImagePreviewUrl(url)).toBe(false);
    expect(isSafeAssistantImagePreviewUrl(url, { trustedAsset: true })).toBe(true);
  });

  it("renders a terminal unavailable state when asset URL creation fails", () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantMessageImages, {
        images: [
          {
            id: "generated-image-1",
            name: "generated.png",
            previewError: true,
          },
        ],
        onExpand: () => {},
      }),
    );

    expect(markup).toContain("Image unavailable");
    expect(markup).not.toContain("Loading image");
  });

  it("renders downloads as real links so fallback navigation keeps the click gesture", () => {
    const markup = renderToStaticMarkup(
      createElement(AssistantMessageImages, {
        images: [
          {
            id: "generated-image-1",
            name: "generated.png",
            previewUrl: "/api/assets/signed-token/generated.png",
          },
        ],
        onExpand: () => {},
      }),
    );

    expect(markup).toContain('href="/api/assets/signed-token/generated.png"');
    expect(markup).toContain('download="generated.png"');
    expect(markup).toContain('target="_blank"');
  });
});
