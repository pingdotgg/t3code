import { describe, expect, it } from "vite-plus/test";
import {
  MAX_TOOL_OUTPUT_IMAGES,
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  toolOutputImages,
} from "@t3tools/shared/toolOutput";

import { openCodeToolOutput } from "./toolItems.ts";

describe("openCodeToolOutput", () => {
  it("preserves inline raster file content and leaves other files unserved", () => {
    const output = openCodeToolOutput("Preview complete", [
      { uri: "https://example.com/preview.png", mime: "image/png" },
      { uri: "file:///tmp/preview.png", mime: "image/png" },
      { uri: "data:image/svg+xml;base64,AAAA", mime: "image/svg+xml" },
      { uri: "data:image/png;base64,AAAA", mime: "image/jpeg" },
      { uri: "data:image/png;base64,", mime: "image/png" },
      { uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" },
    ]);
    expect(toolOutputImages(output)).toEqual([{ mimeType: "image/png", data: "iVBORw0KGgo=" }]);
    expect(output).toEqual({
      content: [
        { type: "text", text: "Preview complete" },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
    });
    expect(openCodeToolOutput("Text result")).toBe("Text result");
    const oversized = "A".repeat(MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH + 4);
    const bounded = openCodeToolOutput(
      "Preview complete",
      Array.from({ length: MAX_TOOL_OUTPUT_IMAGES + 2 }, (_, index) => ({
        uri: `data:image/png;base64,${index === 0 ? oversized : "AQ=="}`,
        mime: "image/png",
      })),
    );
    expect(typeof bounded === "object" ? bounded.content.length : 0).toBe(
      MAX_TOOL_OUTPUT_IMAGES + 1,
    );
    const images = toolOutputImages(bounded);
    expect(images[0]?.data?.length).toBe(oversized.length);
    expect(images[1]?.data).toBe("AQ==");
  });
});
