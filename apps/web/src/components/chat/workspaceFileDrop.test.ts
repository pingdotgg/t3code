import { describe, expect, it } from "@effect/vitest";
import { splitTransferredFiles } from "./workspaceFileDrop";

const entry = (isDirectory: boolean) => ({ isDirectory }) as FileSystemEntry;

describe("splitTransferredFiles", () => {
  it("separates copied folders from files and keeps their entries aligned", () => {
    const folder = new File([], "photos.png");
    const folderEntry = entry(true);
    const secondFolder = new File([], "src");
    const secondFolderEntry = entry(true);
    const emptyFile = new File([], "empty.txt");
    const image = new File(["image"], "photo.png", { type: "image/png" });

    expect(
      splitTransferredFiles({
        files: [folder, emptyFile, image, secondFolder],
        items: [
          {
            kind: "string",
            getAsFile: () => null,
            webkitGetAsEntry: () => null,
          },
          {
            kind: "file",
            getAsFile: () => folder,
            webkitGetAsEntry: () => folderEntry,
          },
          {
            kind: "file",
            getAsFile: () => emptyFile,
            webkitGetAsEntry: () => entry(false),
          },
          {
            kind: "file",
            getAsFile: () => image,
            webkitGetAsEntry: () => null,
          },
          {
            kind: "file",
            getAsFile: () => secondFolder,
            webkitGetAsEntry: () => secondFolderEntry,
          },
        ],
      }),
    ).toEqual({
      files: [emptyFile, image],
      folders: [folder, secondFolder],
      folderEntries: [folderEntry, secondFolderEntry],
    });
  });

  it("ignores clipboard file items that cannot provide a file", () => {
    expect(
      splitTransferredFiles({
        files: [],
        items: [
          {
            kind: "file",
            getAsFile: () => null,
            webkitGetAsEntry: () => entry(true),
          },
        ],
      }),
    ).toEqual({ files: [], folders: [], folderEntries: [] });
  });
});
