import { describe, expect, it } from "vite-plus/test";

import { editorLabelForPlatform, openInEditorMenuLabel } from "./editorLabels";

describe("editorLabelForPlatform", () => {
  it("uses the platform file-manager name on MacIntel", () => {
    expect(editorLabelForPlatform("file-manager", "MacIntel")).toBe("Finder");
  });
});

describe("openInEditorMenuLabel", () => {
  it("names the preferred editor", () => {
    expect(openInEditorMenuLabel("zed")).toBe("Open in Zed");
  });

  it("keeps the generic label for the default file handler and missing preferences", () => {
    expect(openInEditorMenuLabel("file-manager")).toBe("Open in editor");
    expect(openInEditorMenuLabel(null)).toBe("Open in editor");
  });
});
