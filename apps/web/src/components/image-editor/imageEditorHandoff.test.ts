import type { SnapShotSource } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ChatComposerHandle } from "../chat/ChatComposer";
import type { ImageEditorResult } from "./ImageEditor";
import { createImageEditorDocument, setImageEditorCrop } from "./imageEditorDocument";
import { createImageEditorHandoff, imageEditorFileMetadata } from "./imageEditorHandoff";
import { editedImageSource } from "./imageEditorSource";

function result(): ImageEditorResult {
  return {
    mode: "replace",
    files: [new File([], "edited.png", { type: "image/png" })],
    prompt: "",
    originalFile: new File([], "original.png", { type: "image/png" }),
    document: createImageEditorDocument(1000, 500),
  };
}

describe("image editor handoff", () => {
  it("keeps a failed handoff retryable without mutating the files or choosing a replacement target for animation", async () => {
    const original = new File(["GIF"], "animation.gif", { type: "image/gif" });
    const edited = result();
    edited.options = {
      instructions: "Make frame two green",
      removeBackground: true,
      aspectRatio: "4:5",
    };
    const stageImageEdit = vi
      .fn<ChatComposerHandle["stageImageEdit"]>()
      .mockRejectedValueOnce(new Error("Attachment limit"))
      .mockResolvedValue(undefined);
    const apply = createImageEditorHandoff(
      "thread",
      { current: "thread" },
      { current: { stageImageEdit } },
      { original, context: "Frames: 1: 100, 2: 250" },
    );
    const item = { src: "blob:frames", name: "frames.png", attachmentId: "sheet" };
    await expect(apply(item, edited)).rejects.toThrow("Attachment limit");
    await apply(item, edited);
    expect(stageImageEdit).toHaveBeenCalledTimes(2);
    for (const call of stageImageEdit.mock.calls) {
      expect(call).toHaveLength(1);
      expect(call[0].mode).toBe("edit");
      expect(call[0].files).toEqual([original, ...edited.files]);
      expect(call[0].prompt).toContain("Frames: 1: 100, 2: 250");
      expect(call[0].prompt).toContain("Return the edited animation.");
      expect(call[0].options).toEqual(edited.options);
    }
    expect(edited.files).toHaveLength(1);
  });

  it("keeps a pending editor bound to its opening thread when route and composer refs change", async () => {
    const firstStage = vi.fn<ChatComposerHandle["stageImageEdit"]>().mockResolvedValue(undefined);
    const nextStage = vi.fn<ChatComposerHandle["stageImageEdit"]>().mockResolvedValue(undefined);
    const currentThread: { current: string | null } = { current: "thread-a" };
    const composer: { current: Pick<ChatComposerHandle, "stageImageEdit"> | null } = {
      current: { stageImageEdit: firstStage },
    };
    const apply = createImageEditorHandoff("thread-a", currentThread, composer);
    const image = { src: "blob:original", name: "original.png", attachmentId: "image-1" };
    await apply(image, result());
    expect(firstStage).toHaveBeenCalledOnce();

    currentThread.current = "thread-b";
    composer.current = { stageImageEdit: nextStage };
    await expect(apply(image, result())).rejects.toThrow(
      "The thread changed while preparing the image",
    );
    expect(firstStage).toHaveBeenCalledOnce();
    expect(nextStage).not.toHaveBeenCalled();

    currentThread.current = "thread-a";
    composer.current = null;
    await expect(apply(image, result())).rejects.toThrow("Open the thread composer");
    expect(nextStage).not.toHaveBeenCalled();
  });

  it("keeps editable layers on the guidance sheet when animation feedback prepends its original GIF", async () => {
    const original = new File(["GIF"], "animation.gif", { type: "image/gif" });
    const originalSheet = new File(["original"], "frames-original.png", { type: "image/png" });
    const guidanceSheet = new File(["guidance"], "frames-guidance.png", { type: "image/png" });
    const edited: ImageEditorResult = {
      ...result(),
      mode: "edit",
      files: [originalSheet, guidanceSheet],
      sessionFile: guidanceSheet,
      options: { instructions: "Edit frames", removeBackground: false, aspectRatio: "original" },
    };
    const stageImageEdit = vi
      .fn<ChatComposerHandle["stageImageEdit"]>()
      .mockResolvedValue(undefined);
    const apply = createImageEditorHandoff(
      "thread-a",
      { current: "thread-a" },
      { current: { stageImageEdit } },
      { original, context: "Frame feedback" },
    );
    await apply({ src: "blob:frames", name: "frames.png" }, edited);
    const [staged] = stageImageEdit.mock.calls[0]!;
    expect(staged.files).toEqual([original, originalSheet, guidanceSheet]);
    expect(staged.sessionFile).toBe(guidanceSheet);
    expect(imageEditorFileMetadata(staged, original)).toEqual({});
    expect(imageEditorFileMetadata(staged, originalSheet)).toEqual({});
    expect(imageEditorFileMetadata(staged, guidanceSheet)).toEqual({
      imageEditor: {
        document: edited.document,
        originalFile: edited.originalFile,
        options: edited.options,
      },
    });
  });

  it("passes the original screenshot metadata with a continued crop instead of cropping already rebased coordinates", async () => {
    const originalSource: SnapShotSource = {
      kind: "snap-shot",
      capturedAt: "2026-11-15T12:00:00.000Z",
      appName: "Design",
      windowTitle: "Canvas",
      accessibility: {
        format: "element-tree",
        coordinateSpace: "captured-image",
        imageSize: { width: 1000, height: 500 },
        truncated: false,
        root: {
          role: "image",
          name: "Design canvas",
          bounds: { x: 250, y: 150, width: 200, height: 100 },
          children: [],
        },
      },
    };
    const originalFile = new File([], "original.png", { type: "image/png" });
    const firstCrop = setImageEditorCrop(createImageEditorDocument(1000, 500), {
      x: 100,
      y: 50,
      width: 700,
      height: 400,
    });
    const croppedSource = editedImageSource(originalSource, firstCrop)!;
    const continuedCrop = setImageEditorCrop(firstCrop, {
      x: 200,
      y: 100,
      width: 500,
      height: 250,
    });
    const edited = { ...result(), originalFile, document: continuedCrop };
    const stageImageEdit = vi
      .fn<ChatComposerHandle["stageImageEdit"]>()
      .mockResolvedValue(undefined);
    const apply = createImageEditorHandoff(
      "thread-a",
      { current: "thread-a" },
      { current: { stageImageEdit } },
    );
    await apply(
      {
        src: "blob:cropped",
        name: "edited.png",
        attachmentId: "existing-image",
        source: croppedSource,
        editorSession: { originalFile, originalSource, document: firstCrop },
      },
      edited,
    );

    const [staged, attachmentId] = stageImageEdit.mock.calls[0]!;
    expect(attachmentId).toBe("existing-image");
    expect(staged.source).toBe(originalSource);
    expect(staged.source).not.toBe(croppedSource);
    expect(staged.document).toBe(continuedCrop);
    expect(staged.originalFile).toBe(originalFile);
    expect(staged.files).toBe(edited.files);
  });
});
