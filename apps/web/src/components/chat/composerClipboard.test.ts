import { describe, expect, it, vi } from "vitest";

import { getClipboardFiles, handleComposerPaste } from "./composerClipboard";

function createClipboardData({
  files = [],
  items = [],
}: {
  files?: File[];
  items?: Array<{ kind: string; getAsFile: () => File | null }>;
} = {}): DataTransfer {
  return {
    files: files as unknown as FileList,
    items: items as unknown as DataTransferItemList,
  } as DataTransfer;
}

describe("getClipboardFiles", () => {
  it("reads pasted files from clipboard items when the files list is empty", () => {
    const image = new File(["image"], "pasted.png", { type: "image/png" });
    const textFile = new File(["text"], "notes.txt", { type: "text/plain" });
    const clipboardData = createClipboardData({
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => image },
        { kind: "file", getAsFile: () => null },
        { kind: "file", getAsFile: () => textFile },
      ],
    });

    expect(getClipboardFiles(clipboardData)).toEqual([image, textFile]);
  });

  it("prefers the files list when it is available", () => {
    const image = new File(["image"], "pasted.png", { type: "image/png" });
    const clipboardData = createClipboardData({
      files: [image],
      items: [{ kind: "file", getAsFile: () => image }],
    });

    expect(getClipboardFiles(clipboardData)).toEqual([image]);
  });
});

describe("handleComposerPaste", () => {
  it("attaches image items when the clipboard files list is empty", () => {
    const image = new File(["image"], "pasted.png", { type: "image/png" });
    const event = {
      defaultPrevented: false,
      clipboardData: createClipboardData({
        items: [{ kind: "file", getAsFile: () => image }],
      }),
      preventDefault: vi.fn(),
    };
    const addImages = vi.fn();

    handleComposerPaste(event, { editingQueuedTurn: false, addImages });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(addImages).toHaveBeenCalledWith([image]);
  });

  it("leaves text-only paste to the editor", () => {
    const event = {
      defaultPrevented: false,
      clipboardData: createClipboardData({
        items: [{ kind: "string", getAsFile: () => null }],
      }),
      preventDefault: vi.fn(),
    };
    const addImages = vi.fn();

    handleComposerPaste(event, { editingQueuedTurn: false, addImages });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(addImages).not.toHaveBeenCalled();
  });

  it("does not attach files while editing a queued turn", () => {
    const image = new File(["image"], "pasted.png", { type: "image/png" });
    const event = {
      defaultPrevented: false,
      clipboardData: createClipboardData({ files: [image] }),
      preventDefault: vi.fn(),
    };
    const addImages = vi.fn();

    handleComposerPaste(event, { editingQueuedTurn: true, addImages });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(addImages).not.toHaveBeenCalled();
  });
});
