import { describe, expect, it } from "vite-plus/test";

import { isBrowserPreviewFile } from "./openFileInPreview";

describe("isBrowserPreviewFile", () => {
  it.each(["index.html", "docs/guide.htm?cache=1", "report.PDF#page=2"])(
    "uses shared workspace browser-preview classification for %s",
    (path) => {
      expect(isBrowserPreviewFile(path)).toBe(true);
    },
  );

  it.each(["src/index.ts", "assets/logo.png", "README.md"])(
    "does not classify non-browser workspace previews as browser files for %s",
    (path) => {
      expect(isBrowserPreviewFile(path)).toBe(false);
    },
  );
});
