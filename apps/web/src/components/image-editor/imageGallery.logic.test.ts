import { ChatAttachmentId } from "@t3tools/contracts";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  conversationImageSources,
  createImageArchive,
  readImageArchive,
} from "./imageGallery.logic";

describe("createImageArchive", () => {
  it("preserves image bytes with valid checksums and safe unique UTF-8 filenames", async () => {
    const bytes = new TextEncoder().encode("123456789");
    const blob = await createImageArchive([
      { name: "../../café.png", bytes },
      { name: "CAFÉ.png", bytes: new Uint8Array([0, 255]) },
      { name: "..", bytes: new Uint8Array([42]) },
    ]);
    const archive = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
    expect(Object.keys(archive.files)).toEqual(["café.png", "CAFÉ (2).png", "image-3"]);
    expect(await archive.file("café.png")?.async("uint8array")).toEqual(bytes);
    expect(await archive.file("CAFÉ (2).png")?.async("uint8array")).toEqual(
      new Uint8Array([0, 255]),
    );
    expect(await archive.file("image-3")?.async("uint8array")).toEqual(new Uint8Array([42]));
  });

  it("rejects an empty archive instead of generating a misleading download", async () => {
    await expect(createImageArchive([])).rejects.toThrow("Select at least one image");
  });

  it("rejects too many archive entries before encoding their bytes", async () => {
    const entry = { name: "empty.png", bytes: new Uint8Array() };
    await expect(createImageArchive(Array.from({ length: 65_536 }, () => entry))).rejects.toThrow(
      "There are too many images for one download.",
    );
  });
});

describe("readImageArchive", () => {
  it("reads images sequentially while retaining input order and exact GIF bytes", async () => {
    let finishFirstRead!: (value: Blob) => void;
    const firstRead = new Promise<Blob>((resolve) => {
      finishFirstRead = resolve;
    });
    const readImage = vi.fn((name: string) =>
      name === "first.gif" ? firstRead : Promise.resolve(new Blob([new Uint8Array([0, 255])])),
    );
    const pending = readImageArchive(["first.gif", "second.png"], readImage, (name) => name);
    expect(readImage.mock.calls).toEqual([["first.gif"]]);
    const gif = new Uint8Array([71, 73, 70, 56, 57, 97]);
    finishFirstRead(new Blob([gif], { type: "image/gif" }));
    const archive = await JSZip.loadAsync(await (await pending).arrayBuffer(), {
      checkCRC32: true,
    });
    expect(readImage.mock.calls).toEqual([["first.gif"], ["second.png"]]);
    expect(Object.keys(archive.files)).toEqual(["first.gif", "second.png"]);
    expect(await archive.file("first.gif")?.async("uint8array")).toEqual(gif);
    expect(await archive.file("second.png")?.async("uint8array")).toEqual(new Uint8Array([0, 255]));
  });

  it("stops at a failed read rather than downloading a partial archive", async () => {
    const readImage = vi.fn(async () => {
      throw new Error("Image unavailable");
    });
    await expect(readImageArchive(["missing", "later"], readImage, (name) => name)).rejects.toThrow(
      "Image unavailable",
    );
    expect(readImage).toHaveBeenCalledOnce();
  });

  it("rejects over-budget blobs before allocating their byte arrays or reading later images", async () => {
    const oversized = new Blob();
    Object.defineProperty(oversized, "size", { value: 256 * 1024 * 1024 + 1 });
    using bytes = vi.spyOn(oversized, "arrayBuffer");
    const readImage = vi.fn(async () => oversized);
    await expect(readImageArchive(["large", "later"], readImage, (name) => name)).rejects.toThrow(
      "This download exceeds 256 MB. Select fewer images and try again.",
    );
    expect(readImage).toHaveBeenCalledOnce();
    expect(bytes).not.toHaveBeenCalled();
  });
});

describe("conversationImageSources", () => {
  it("collects rendered images and attachments across messages while excluding local previews, code and unsafe paths", () => {
    const attachment = {
      id: ChatAttachmentId.make("image-1"),
      type: "image" as const,
      name: "reference.png",
      mimeType: "image/png",
      sizeBytes: 10,
    };
    const sources = conversationImageSources(
      [
        {
          text: "",
          attachments: [
            { ...attachment, previewUrl: "blob:pending-committed-copy" },
            {
              ...attachment,
              id: ChatAttachmentId.make("local-blob"),
              previewUrl: "blob:pending-upload",
            },
            {
              ...attachment,
              id: ChatAttachmentId.make("local-data"),
              previewUrl: "data:image/png;base64,pending",
            },
          ],
        },
        {
          text: "![Local](./art/first.png) ![External](https://example.com/photo)\n\n```md\n![Code](ignored.png)\n```\n\n<!-- ![Comment](hidden.png) -->\n\n![Denied](file://untrusted/share/image.png)",
          attachments: [attachment],
        },
        {
          text: '![Again](/repo/art/first.png)\n\n![Referenced][ref]\n\n[ref]: /repo/second.png\n\n<img src="https://example.com/html.png">',
          attachments: [attachment],
        },
      ],
      "/repo",
    );
    expect(sources).toEqual([
      { kind: "attachment", attachment },
      { kind: "markdown", source: "./art/first.png" },
      { kind: "markdown", source: "https://example.com/photo" },
      { kind: "markdown", source: "/repo/second.png" },
      { kind: "markdown", source: "https://example.com/html.png" },
    ]);
  });
});
