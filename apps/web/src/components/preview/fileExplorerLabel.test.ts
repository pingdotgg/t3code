import { describe, expect, it } from "vite-plus/test";

import {
  fileManagerOpenNameForOs,
  fileManagerRevealNameForKind,
  fileManagerRevealNameForOs,
  revealInFileExplorerLabel,
  revealInFileExplorerLabelForManager,
} from "./fileExplorerLabel";

describe("file manager names", () => {
  it.each([
    ["darwin", "Finder", "Finder"],
    ["windows", "File Explorer", "File Explorer"],
    ["linux", "File Manager", "Files"],
  ] as const)("maps %s", (os, openName, revealName) => {
    expect(fileManagerOpenNameForOs(os)).toBe(openName);
    expect(fileManagerRevealNameForOs(os)).toBe(revealName);
  });

  it.each([
    ["finder", "Finder", "Reveal in Finder"],
    ["file-explorer", "File Explorer", "Reveal in File Explorer"],
    ["files", "Files", "Open Containing Folder"],
  ] as const)("maps %s kind", (kind, revealName, label) => {
    expect(fileManagerRevealNameForKind(kind)).toBe(revealName);
    expect(revealInFileExplorerLabelForManager(revealName)).toBe(label);
  });
});

describe("revealInFileExplorerLabel", () => {
  it.each([
    ["MacIntel", "Reveal in Finder"],
    ["Win32", "Reveal in File Explorer"],
    ["Linux x86_64", "Reveal in Files"],
  ])("maps %s to %s", (platform, expected) => {
    expect(revealInFileExplorerLabel(platform)).toBe(expected);
  });
});
