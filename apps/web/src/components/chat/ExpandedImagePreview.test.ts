import { describe, expect, it } from "vite-plus/test";

import { buildExpandedImagePreview } from "./ExpandedImagePreview";

describe("buildExpandedImagePreview", () => {
  it("excludes unsafe URLs from the expanded gallery", () => {
    expect(
      buildExpandedImagePreview(
        [
          { id: "safe", name: "safe.png", previewUrl: "blob:https://app.t3.codes/safe" },
          {
            id: "unsafe",
            name: "unsafe.png",
            previewUrl: "https://example.com/api/assets/stolen.png",
          },
        ],
        "safe",
      ),
    ).toEqual({
      images: [{ src: "blob:https://app.t3.codes/safe", name: "safe.png" }],
      index: 0,
    });
  });
});
