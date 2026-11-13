import { describe, expect, it } from "@effect/vitest";
import {
  makeWorkspaceFileDropHandlers,
  splitTransferredFiles,
  type WorkspaceFileDropMode,
} from "./workspaceFileDrop";

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
    ).toEqual({
      files: [emptyFile, image],
      folders: [folder],
      entries: [folder, emptyFile, image],
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
            webkitGetAsEntry: () => ({ isDirectory: true }),
          },
        ],
      }),
    ).toEqual({ files: [], folders: [], entries: [] });
  });
});

describe("makeWorkspaceFileDropHandlers", () => {
  const file = new File(["text"], "notes.txt");
  const folder = new File([], "photos");
  const dragEvent = (shiftKey: boolean) => ({
    shiftKey,
    relatedTarget: null,
    currentTarget: { contains: () => false },
    preventDefault: () => {},
    dataTransfer: {
      types: ["Files"],
      files: [folder, file],
      items: [
        { kind: "file", getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) },
        { kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false }) },
      ],
      dropEffect: "none",
    },
  });
  const names = (entries: File[]) => entries.map((entry) => entry.name);

  // Enters without Shift, then drags over and drops with the row's Shift state. Handlers are
  // rebuilt per event with the mode set so far, as a render between events does in the app.
  const run = (shiftKey: boolean, paths: "insertable" | "refused" | "unsupported") => {
    const calls: Array<[string, string[]]> = [];
    const modes: Array<WorkspaceFileDropMode | null> = [];
    let dragMode: WorkspaceFileDropMode | null = null;
    let canInsertCalls = 0;
    const handlers = () =>
      makeWorkspaceFileDropHandlers({
        setDragMode: (mode) => {
          dragMode = mode;
          modes.push(mode);
        },
        addFiles: (files) => calls.push(["addFiles", names(files)]),
        addFolders: (folders) => calls.push(["addFolders", names(folders)]),
        ...(paths === "unsupported"
          ? {}
          : {
              paths: {
                dragMode,
                canInsert: () => {
                  canInsertCalls += 1;
                  return paths === "insertable";
                },
                insert: (entries) => calls.push(["insertPaths", names(entries)]),
              },
            }),
      });
    const over = dragEvent(shiftKey);
    handlers().onDragEnter(dragEvent(false));
    handlers().onDragOver(over);
    handlers().onDrop(dragEvent(shiftKey));
    return { calls, modes, canInsertCalls, dropEffect: over.dataTransfer.dropEffect };
  };

  it.each([
    {
      name: "a plain drop attaches files and references folders",
      shiftKey: false,
      paths: "insertable" as const,
      modes: ["attach-or-paths", "attach-or-paths", null],
      calls: [
        ["addFiles", ["notes.txt"]],
        ["addFolders", ["photos"]],
      ],
      canInsertCalls: 1,
    },
    {
      name: "pressing Shift mid-drag inserts every entry as a path",
      shiftKey: true,
      paths: "insertable" as const,
      modes: ["attach-or-paths", "paths", null],
      calls: [["insertPaths", ["photos", "notes.txt"]]],
      canInsertCalls: 1,
    },
    {
      name: "a Shift drop attaches where paths cannot be inserted",
      shiftKey: true,
      paths: "refused" as const,
      modes: ["attach", "attach", null],
      calls: [
        ["addFiles", ["notes.txt"]],
        ["addFolders", ["photos"]],
      ],
      canInsertCalls: 1,
    },
    {
      name: "a Shift drop attaches on a host without path insertion",
      shiftKey: true,
      paths: "unsupported" as const,
      modes: ["attach", "attach", null],
      calls: [
        ["addFiles", ["notes.txt"]],
        ["addFolders", ["photos"]],
      ],
      canInsertCalls: 0,
    },
  ])("$name", ({ shiftKey, paths, modes, calls, canInsertCalls }) => {
    const result = run(shiftKey, paths);
    expect(result).toEqual({ calls, modes, canInsertCalls, dropEffect: "copy" });
  });
});
