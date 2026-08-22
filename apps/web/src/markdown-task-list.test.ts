import { describe, expect, it } from "vite-plus/test";

import { setMarkdownTaskChecked } from "./components/files/filePreviewMode";
import { normalizeWindowsMarkdownFileLinks } from "./markdown-links";
import { findTaskListMarkerOffset } from "./markdown-task-list";

describe("findTaskListMarkerOffset", () => {
  it("uses the original text when a windows rewrite shifts later offsets", () => {
    const original = "See D:\\tmp\\file.md\n- [ ] later";
    const parsed = normalizeWindowsMarkdownFileLinks(original);
    const parsedListItemStart = parsed.indexOf("- [ ]");
    expect(parsedListItemStart).toBeGreaterThan(original.indexOf("- [ ]"));

    const markerOffset = findTaskListMarkerOffset(original, parsedListItemStart, parsed);
    expect(markerOffset).toBe(original.indexOf("["));
    expect(setMarkdownTaskChecked(original, markerOffset!, true)).toBe(
      "See D:\\tmp\\file.md\n- [x] later",
    );
  });

  it("keeps the checkbox offset when the rewrite is after the marker", () => {
    const original = "- [ ] Open D:\\tmp\\file.md";
    const parsed = normalizeWindowsMarkdownFileLinks(original);
    const markerOffset = findTaskListMarkerOffset(original, 0, parsed);
    expect(markerOffset).toBe(2);
    expect(setMarkdownTaskChecked(original, markerOffset!, true)).toBe(
      "- [x] Open D:\\tmp\\file.md",
    );
  });
});
