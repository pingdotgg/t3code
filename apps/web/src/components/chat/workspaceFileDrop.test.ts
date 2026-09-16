import { describe, expect, it, vi } from "@effect/vitest";
import {
  makeWorkspaceFileDropHandlers,
  type WorkspaceFileDragEvent,
  type WorkspaceFileDropHost,
} from "./workspaceFileDrop";

function makeDragEvent(options?: {
  types?: string[];
  files?: File[];
  items?: NonNullable<WorkspaceFileDragEvent["dataTransfer"]["items"]>;
  movedWithinTarget?: boolean;
}) {
  const preventDefault = vi.fn();
  const event = {
    dataTransfer: {
      types: options?.types ?? ["Files"],
      files: options?.files ?? [],
      dropEffect: "none",
      ...(options?.items === undefined ? {} : { items: options.items }),
    },
    relatedTarget: options?.movedWithinTarget ? ({} as EventTarget) : null,
    currentTarget: {
      contains: () => options?.movedWithinTarget ?? false,
    },
    preventDefault,
  } satisfies WorkspaceFileDragEvent;
  return { event, preventDefault };
}

function makeHost() {
  const setDragActive = vi.fn();
  const addFiles = vi.fn();
  const addFolders = vi.fn();
  const host = { setDragActive, addFiles, addFolders } satisfies WorkspaceFileDropHost;
  return { host, setDragActive, addFiles, addFolders };
}

describe("makeWorkspaceFileDropHandlers", () => {
  it("activates the target for an external file drag", () => {
    const { host, setDragActive } = makeHost();
    const { event, preventDefault } = makeDragEvent();

    makeWorkspaceFileDropHandlers(host).onDragEnter(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(setDragActive).toHaveBeenCalledWith(true);
  });

  it("ignores non-file drags", () => {
    const { host, setDragActive } = makeHost();
    const { event, preventDefault } = makeDragEvent({ types: ["text/plain"] });

    makeWorkspaceFileDropHandlers(host).onDragOver(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(setDragActive).not.toHaveBeenCalled();
  });

  it("does not flicker when the drag moves between children", () => {
    const { host, setDragActive } = makeHost();
    const { event } = makeDragEvent({ movedWithinTarget: true });

    const handlers = makeWorkspaceFileDropHandlers(host);
    handlers.onDragEnter(event);
    handlers.onDragLeave(event);

    expect(setDragActive).not.toHaveBeenCalled();
  });

  it("forwards dropped files and clears the active state", () => {
    const file = new File(["contents"], "example.txt", { type: "text/plain" });
    const { host, setDragActive, addFiles } = makeHost();
    const { event } = makeDragEvent({ files: [file] });

    makeWorkspaceFileDropHandlers(host).onDrop(event);

    expect(setDragActive).toHaveBeenCalledWith(false);
    expect(addFiles).toHaveBeenCalledWith([file]);
  });

  it("routes mixed drops to files and folders", () => {
    const file = new File(["contents"], "example.txt", { type: "text/plain" });
    const folder = new File([], "project", { type: "" });
    const directory = {
      kind: "file",
      getAsFile: () => folder,
      webkitGetAsEntry: () => ({ isDirectory: true }),
    };
    const { host, addFiles, addFolders } = makeHost();
    const { event } = makeDragEvent({
      items: [
        directory,
        {
          kind: "file",
          getAsFile: () => file,
          webkitGetAsEntry: () => ({ isDirectory: false }),
        },
      ],
    });

    makeWorkspaceFileDropHandlers(host).onDrop(event);

    expect(addFiles).toHaveBeenCalledWith([file]);
    expect(addFolders).toHaveBeenCalledWith([folder]);
  });

  it("routes a folder-only drop without attaching files", () => {
    const folder = new File([], "project", { type: "" });
    const directory = {
      kind: "file",
      getAsFile: () => folder,
      webkitGetAsEntry: () => ({ isDirectory: true }),
    };
    const { host, addFiles, addFolders } = makeHost();
    const { event } = makeDragEvent({ items: [directory] });

    makeWorkspaceFileDropHandlers(host).onDrop(event);

    expect(addFiles).not.toHaveBeenCalled();
    expect(addFolders).toHaveBeenCalledWith([folder]);
  });

  it("uses files when the browser does not expose drag items", () => {
    const file = new File(["contents"], "example.txt", { type: "text/plain" });
    const { host, addFiles, addFolders } = makeHost();
    const { event } = makeDragEvent({ files: [file] });

    makeWorkspaceFileDropHandlers(host).onDrop(event);

    expect(addFiles).toHaveBeenCalledWith([file]);
    expect(addFolders).not.toHaveBeenCalled();
  });
});
