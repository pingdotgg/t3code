import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { readFileAsDataUrl } from "../../lib/imageCompression";
import { serializeComposerImages } from "./composerImagePersistence";

vi.mock("../../lib/imageCompression", () => ({ readFileAsDataUrl: vi.fn() }));

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
