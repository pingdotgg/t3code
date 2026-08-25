import { describe, expect, it } from "vite-plus/test";

import { editorLabelForPlatform, openInEditorMenuLabel } from "./editorLabels";

describe("editorLabelForPlatform", () => {
  it("uses the editor name from the shared editor definitions", () => {
    expect(editorLabelForPlatform("cursor", "MacIntel")).toBe("Cursor");
    expect(editorLabelForPlatform("vscode-insiders", "Win32")).toBe("VS Code Insiders");
  });

  it.each([
    ["MacIntel", "Finder"],
    ["Win32", "Explorer"],
    ["Linux x86_64", "Files"],
  ])("uses the platform file-manager name on %s", (platform, label) => {
    expect(editorLabelForPlatform("file-manager", platform)).toBe(label);
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
