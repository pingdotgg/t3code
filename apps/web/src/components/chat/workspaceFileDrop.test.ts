import { describe, expect, it } from "@effect/vitest";
import { splitTransferredFiles } from "./workspaceFileDrop";

describe("splitTransferredFiles", () => {
  it("separates copied folders from files before attachment validation", () => {
    const folder = new File([], "photos.png");
    const emptyFile = new File([], "empty.txt");
    const image = new File(["image"], "photo.png", { type: "image/png" });

    expect(
      splitTransferredFiles({
        files: [folder, emptyFile, image],
        items: [
          {
            kind: "string",
            getAsFile: () => null,
            webkitGetAsEntry: () => null,
          },
          {
            kind: "file",
            getAsFile: () => folder,
            webkitGetAsEntry: () => ({ isDirectory: true }),
          },
          {
            kind: "file",
            getAsFile: () => emptyFile,
            webkitGetAsEntry: () => ({ isDirectory: false }),
          },
          {
            kind: "file",
            getAsFile: () => image,
            webkitGetAsEntry: () => null,
          },
        ],
      }),
    ).toEqual({ files: [emptyFile, image], folders: [folder] });
  });

  it("ignores clipboard file items that cannot provide a file", () => {
    expect(
      splitTransferredFiles({
        files: [],
        items: [
          {
            kind: "file",
            getAsFile: () => null,
            webkitGetAsEntry: () => ({ isDirectory: true }),
          },
        ],
      }),
    ).toEqual({ files: [], folders: [] });
  });
});
