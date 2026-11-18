import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { readFileAsDataUrl } from "../../lib/imageCompression";
import { serializeComposerImages } from "./composerImagePersistence";
import { createImageEditorDocument } from "../image-editor/imageEditorDocument";

vi.mock("../../lib/imageCompression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/imageCompression")>()),
  readFileAsDataUrl: vi.fn(),
}));

function image(id: string): ComposerImageAttachment {
  const file = new File([id], `${id}.png`, { type: "image/png" });
  return {
    type: "image",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
}

describe("serializeComposerImages", () => {
  beforeEach(() => {
    vi.mocked(readFileAsDataUrl).mockReset();
  });

  it("reads only new images and drops removed images without rereading retained bytes", async () => {
    const a = image("a");
    const b = image("b");
    vi.mocked(readFileAsDataUrl).mockImplementation(async (file) =>
      file === a.file ? "data:image/png;base64,YQ==" : "data:image/png;base64,Yg==",
    );

    const first = await serializeComposerImages([a], []);
    expect(first).toEqual([
      {
        id: "a",
        name: "a.png",
        mimeType: "image/png",
        sizeBytes: 1,
        dataUrl: "data:image/png;base64,YQ==",
      },
    ]);
    expect(readFileAsDataUrl).toHaveBeenCalledTimes(1);

    const second = await serializeComposerImages([a, b], first);
    expect(second).toEqual([
      first[0],
      {
        id: "b",
        name: "b.png",
        mimeType: "image/png",
        sizeBytes: 1,
        dataUrl: "data:image/png;base64,Yg==",
      },
    ]);
    expect(readFileAsDataUrl).toHaveBeenCalledTimes(2);
    expect(readFileAsDataUrl).toHaveBeenNthCalledWith(2, b.file);

    expect(await serializeComposerImages([a], second)).toEqual(first);
    expect(await serializeComposerImages([], second)).toEqual([]);
    expect(readFileAsDataUrl).toHaveBeenCalledTimes(2);
  });

  it("preserves cached bytes without trying to read an unavailable file", async () => {
    const a = image("a");
    const persisted = {
      id: a.id,
      name: a.name,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      dataUrl: "data:image/png;base64,YQ==",
    };
    vi.mocked(readFileAsDataUrl).mockRejectedValue(new Error("File is unavailable"));

    expect(await serializeComposerImages([a], [persisted])).toEqual([persisted]);
    expect(readFileAsDataUrl).not.toHaveBeenCalled();
  });

  it("persists the editable original and layers with edited bytes and reuses their cached serialization", async () => {
    const edited = {
      ...image("edited"),
      imageEditor: {
        originalFile: new File(["original"], "original.png", { type: "image/png" }),
        document: createImageEditorDocument(400, 300),
      },
    };
    vi.mocked(readFileAsDataUrl).mockImplementation(
      async (file) =>
        `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`,
    );
    const first = await serializeComposerImages([edited], []);
    expect(first[0]?.imageEditor).toEqual({
      originalName: "original.png",
      originalDataUrl: "data:image/png;base64,b3JpZ2luYWw=",
      document: edited.imageEditor.document,
    });
    expect(readFileAsDataUrl).toHaveBeenCalledTimes(2);
    expect(await serializeComposerImages([edited], first)).toEqual(first);
    expect(readFileAsDataUrl).toHaveBeenCalledTimes(2);
  });

  it("keeps the edited PNG when its optional editable original cannot be serialized", async () => {
    const edited = {
      ...image("edited"),
      imageEditor: {
        originalFile: new File(["original"], "original.png", { type: "image/png" }),
        document: createImageEditorDocument(400, 300),
      },
    };
    vi.mocked(readFileAsDataUrl).mockImplementation(async (file) => {
      if (file === edited.imageEditor.originalFile) throw new Error("Original is unavailable");
      return "data:image/png;base64,ZWRpdGVk";
    });
    const serialized = await serializeComposerImages([edited], []);
    expect(serialized).toEqual([
      {
        id: "edited",
        name: "edited.png",
        mimeType: "image/png",
        sizeBytes: 6,
        dataUrl: "data:image/png;base64,ZWRpdGVk",
      },
    ]);
  });

  it("keeps composer order when a later image finishes reading first", async () => {
    const large = image("large");
    const small = image("small");
    let finishLargeRead = (_dataUrl: string) => {};
    const largeRead = new Promise<string>((resolve) => {
      finishLargeRead = resolve;
    });
    vi.mocked(readFileAsDataUrl).mockImplementation(async (file) =>
      file === large.file ? largeRead : "data:image/png;base64,c21hbGw=",
    );

    const serialized = serializeComposerImages([large, small], []);
    finishLargeRead("data:image/png;base64,bGFyZ2U=");
    expect((await serialized).map(({ id }) => id)).toEqual(["large", "small"]);
  });

  it("does not encode oversized optional originals again when the attachment list changes", async () => {
    const imageEditRequest = {
      imageIds: ["original", "edited", "mask"],
      prompt: "Remove the marked area",
      options: {
        instructions: "Remove the marked area",
        removeBackground: true,
        aspectRatio: "4:5",
      },
      animation: { originalId: "gif", context: "Frame 1: 100ms" },
    };
    const edited = {
      ...image("edited"),
      imageEditRequest,
      imageEditor: {
        originalFile: new File([new Uint8Array(1_300_000)], "large.png", { type: "image/png" }),
        document: createImageEditorDocument(1536, 1024),
      },
    };
    vi.mocked(readFileAsDataUrl).mockResolvedValue("data:image/png;base64,YQ==");
    const first = await serializeComposerImages([edited], []);
    const second = await serializeComposerImages([edited, image("added")], first);
    expect(first[0]?.imageEditor).toBeUndefined();
    expect(second[0]?.imageEditor).toBeUndefined();
    expect(first[0]).toHaveProperty("imageEditRequest", imageEditRequest);
    expect(second[0]).toHaveProperty("imageEditRequest", imageEditRequest);
    expect(readFileAsDataUrl).not.toHaveBeenCalledWith(edited.imageEditor.originalFile);
    expect(readFileAsDataUrl).toHaveBeenCalledTimes(2);
  });

  it("omits failed uncached reads while keeping successfully serialized images", async () => {
    const a = image("a");
    const b = image("b");
    vi.mocked(readFileAsDataUrl)
      .mockRejectedValueOnce(new Error("File is unavailable"))
      .mockResolvedValueOnce("data:image/png;base64,Yg==");

    expect(await serializeComposerImages([a, b], [])).toEqual([
      {
        id: "b",
        name: "b.png",
        mimeType: "image/png",
        sizeBytes: 1,
        dataUrl: "data:image/png;base64,Yg==",
      },
    ]);
    expect(readFileAsDataUrl).toHaveBeenCalledTimes(2);
  });
});
