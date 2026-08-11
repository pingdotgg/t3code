import { describe, expect, it } from "vite-plus/test";

import { isSafeAssistantImagePreviewUrl } from "./AssistantMessageImages.tsx";

describe("isSafeAssistantImagePreviewUrl", () => {
  it.each([
    "data:image/png;base64,aGVsbG8=",
    "blob:https://app.t3.codes/generated-image-1",
    "/api/assets/signed-token/generated.png",
    "https://environment.test/api/assets/signed-token/generated.png",
  ])("accepts renderable image source %s", (url) => {
    expect(isSafeAssistantImagePreviewUrl(url)).toBe(true);
  });

  it.each([
    "file:///C:/Users/me/private.png",
    "C:\\Users\\me\\private.png",
    "https://example.com/untrusted.png",
    "javascript:alert(1)",
    "data:text/html;base64,aGVsbG8=",
  ])("rejects unsafe image source %s", (url) => {
    expect(isSafeAssistantImagePreviewUrl(url)).toBe(false);
  });
});
