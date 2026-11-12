import { describe, expect, it } from "@effect/vitest";
import { makeWorkspaceFileDropHandlers, splitTransferredFiles } from "./workspaceFileDrop";

it("copies chat references without treating them as uploads or losing their source workspace", () => {
  const dropped: unknown[] = [];
  const handlers = makeWorkspaceFileDropHandlers({
    setDragActive: () => {},
    addFiles: (files) => dropped.push(files),
    addFolders: () => {},
    addChatItem: (item) => dropped.push(item),
  });
  handlers.onDrop({
    dataTransfer: {
      types: ["application/x-t3code-chat-item", "text/plain"],
      getData: () =>
        JSON.stringify({ kind: "mention", environmentId: "source", path: "/repo/docs/file.md" }),
      files: [],
      dropEffect: "none",
    },
    currentTarget: { contains: () => false },
    relatedTarget: null,
    preventDefault: () => {},
  });
  expect(dropped).toEqual([
    { kind: "mention", environmentId: "source", path: "/repo/docs/file.md" },
  ]);
});

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
