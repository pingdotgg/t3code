import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ExpandedImageDialog } from "./ExpandedImageDialog";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

describe("ExpandedImageDialog", () => {
  it("renders video previews with native controls", () => {
    const preview: ExpandedImagePreview = {
      images: [
        {
          src: "https://environment.test/api/assets/demo.mp4",
          name: "demo.mp4",
          type: "video",
        },
      ],
      index: 0,
    };

    const markup = renderToStaticMarkup(
      <ExpandedImageDialog preview={preview} onClose={() => {}} />,
    );

    expect(markup).toContain("<video");
    expect(markup).toContain('controls=""');
    expect(markup).toContain('aria-label="demo.mp4"');
  });
});
