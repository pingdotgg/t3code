import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import type { ImagePickerAsset } from "expo-image-picker";

const mocks = vi.hoisted(() => ({
  documentUri: "file:///documents",
  pickFile: vi.fn(),
  pickMedia: vi.fn(),
  copy: vi.fn(),
  delete: vi.fn(),
  open: vi.fn(),
  size: vi.fn(),
  readBase64: vi.fn(),
  manipulate: vi.fn(),
  release: vi.fn(),
}));

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;

    constructor(root: string | { readonly uri: string }, name: string) {
      this.uri = `${typeof root === "string" ? root : root.uri}/${name}`;
    }

    create(): void {}
  }

  class File {
    readonly uri: string;

    constructor(source: string | Directory, name?: string) {
      this.uri = source instanceof Directory ? `${source.uri}/${name}` : source;
    }

    get exists(): boolean {
      return true;
    }

    get size(): number | null {
      return mocks.size(this.uri) ?? null;
    }

    get name(): string {
      return this.uri.split("/").at(-1) ?? "";
    }

    get type(): string {
      return "video/quicktime";
    }

    create(): void {}

    open(mode: string) {
      return mocks.open(this.uri, mode);
    }

    async copy(destination: File): Promise<void> {
      mocks.copy(this.uri, destination.uri);
    }

    async base64(): Promise<string> {
      return mocks.readBase64(this.uri);
    }

    delete(): void {
      mocks.delete(this.uri);
    }
  }

  return {
    Directory,
    File,
    FileMode: { ReadOnly: "r", WriteOnly: "w" },
    Paths: {
      get document() {
        return { uri: mocks.documentUri };
      },
    },
  };
});

vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: mocks.pickMedia }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: mocks.pickFile }));
vi.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg", PNG: "png", WEBP: "webp" },
  ImageManipulator: { manipulate: mocks.manipulate },
}));
vi.mock("./uuid", () => ({ uuidv4: () => "attachment-id" }));

import {
  persistComposerAttachmentFile,
  isComposerImageAttachment,
  pickComposerFiles,
  pickComposerImages,
  pickComposerMedia,
  removePersistedComposerAttachmentFile,
} from "./composerImages";
import { isForegroundHandoffActive } from "./foreground-handoff";
import { retainComposerAttachmentFile } from "./composerAttachmentFiles";



describe("composer file attachments", () => {
  beforeEach(() => {
    mocks.documentUri = "file:///documents";
    mocks.pickFile.mockReset();
    mocks.pickMedia.mockReset();
    mocks.copy.mockReset();
    mocks.delete.mockReset();
    mocks.open.mockReset();
    mocks.size.mockReset();
    mocks.readBase64.mockReset();
    mocks.manipulate.mockReset();
    mocks.size.mockImplementation((uri: string) => (uri.startsWith("content:") ? null : 42));
  });

  describe("photo library image conversion", () => {
    const rendered = { uri: "file:///cache/ImageManipulator/photo.jpg", base64: "/9j/2Q==" };
    const photo: ImagePickerAsset = {
      uri: "file:///picker/photo.heic",
      type: "image",
      fileName: "photo.HEIC",
      mimeType: "image/heic",
      fileSize: 4 * 1024 * 1024,
      width: 4032,
      height: 3024,
    };
    type Size = { width: number; height: number };
    const native = {
      size: { width: 1, height: 1 } as Size,
      resizes: [] as Size[],
      saved: rendered as { uri: string; base64?: string },
      encode: null as ((size: Size, format: string) => { uri: string; base64?: string }) | null,
    };

    beforeEach(() => {
      native.size = { width: 1, height: 1 };
      native.resizes = [];
      native.saved = rendered;
      native.encode = null;
      mocks.manipulate.mockReset();
      mocks.release.mockReset();
      mocks.manipulate.mockImplementation((source: string | Size) => {
        let size = typeof source === "string" ? native.size : source;
        const context = {
          resize(next: Size) {
            native.resizes.push(next);
            size = next;
            return context;
          },
          renderAsync: async () => ({
            width: size.width,
            height: size.height,
            release: mocks.release,
            saveAsync: async (options: { format: string }) =>
              native.encode?.(size, options.format) ?? native.saved,
          }),
        };
        return context;
      });
    });

    it.each(["image/heic", "image/heif", undefined])(
      "renders a %s photo to JPEG natively and previews the rendered file",
      async (mimeType) => {
        mocks.pickMedia.mockResolvedValue({
          canceled: false,
          assets: [{ ...photo, mimeType }],
        });

        const result = await pickComposerImages({ existingCount: 0 });

        expect(mocks.pickMedia).toHaveBeenCalledWith(expect.objectContaining({ base64: false }));
        expect(mocks.manipulate).toHaveBeenCalledWith(photo.uri);
        expect(mocks.readBase64).not.toHaveBeenCalled();
        expect(result).toEqual({
          images: [
            {
              id: "attachment-id",
              type: "image",
              name: "photo.jpg",
              mimeType: "image/jpeg",
              sizeBytes: 4,
              dataUrl: `data:image/jpeg;base64,${rendered.base64}`,
              previewUri: rendered.uri,
            },
          ],
          error: null,
        });
      },
    );

    it.each([
      { extension: "png", mimeType: "image/png", base64: "iVBORw0KGgo=" },
      { extension: "gif", mimeType: "image/gif", base64: "R0lGODlh" },
      { extension: "webp", mimeType: "image/webp", base64: "UklGRgQAAABXRUJQ" },
    ])("keeps original $extension bytes from the picker file", async (original) => {
      const name = `photo.${original.extension}`;
      mocks.pickMedia.mockResolvedValue({
        canceled: false,
        assets: [{ ...photo, fileName: name, mimeType: original.mimeType }],
      });
      mocks.readBase64.mockResolvedValue(original.base64);

      const result = await pickComposerImages({ existingCount: 0 });

      expect(mocks.manipulate).not.toHaveBeenCalled();
      expect(mocks.readBase64).toHaveBeenCalledWith(photo.uri);
      expect(result.error).toBeNull();
      expect(result.images).toEqual([
        expect.objectContaining({
          name,
          mimeType: original.mimeType,
          dataUrl: `data:${original.mimeType};base64,${original.base64}`,
          sizeBytes: Buffer.from(original.base64, "base64").byteLength,
          previewUri: photo.uri,
        }),
      ]);
    });

    it("shrinks a fitted PNG further when re-encoding it exceeds the image limit", async () => {
      const header = Buffer.alloc(24);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
      header.write("IHDR", 12);
      header.writeUInt32BE(1668, 16);
      header.writeUInt32BE(2388, 20);
      native.size = { width: 1668, height: 2388 };
      // Native PNG encoding of the 2000px resample is larger than the 7 MB original.
      native.encode = (size, format) => ({
        uri: `file:///cache/fitted-${size.width}x${size.height}.${format}`,
        base64: Buffer.alloc(size.width * size.height * 4).toString("base64"),
      });
      mocks.size.mockReturnValue(7 * 1024 * 1024);
      mocks.readBase64.mockResolvedValue(header.toString("base64"));
      mocks.pickMedia.mockResolvedValue({
        canceled: false,
        assets: [{ ...photo, fileName: "IMG_9280.png", mimeType: "image/png" }],
      });

      const result = await pickComposerImages({ existingCount: 0 });

      expect(result.error).toBeNull();
      const [image] = result.images;
      const last = native.resizes.at(-1)!;
      expect(native.resizes[0]).toEqual({ width: 1397, height: 2000 });
      expect(Math.max(last.width, last.height)).toBeLessThan(2000);
      expect(image).toEqual(
        expect.objectContaining({
          name: "IMG_9280.png",
          mimeType: "image/png",
          sizeBytes: last.width * last.height * 4,
          previewUri: `file:///cache/fitted-${last.width}x${last.height}.png`,
        }),
      );
      expect(image!.sizeBytes).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
      expect(mocks.delete).toHaveBeenCalledWith("file:///cache/fitted-1397x2000.png");
      expect(mocks.delete).not.toHaveBeenCalledWith(image!.previewUri);
    });

    it("measures the picker file instead of trusting the reported size", async () => {
      mocks.pickMedia.mockResolvedValue({
        canceled: false,
        assets: [{ ...photo, fileName: "photo.png", mimeType: "image/png", fileSize: 42 }],
      });
      mocks.size.mockReturnValue(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);

      const result = await pickComposerImages({ existingCount: 0 });

      expect(mocks.readBase64).not.toHaveBeenCalled();
      expect(mocks.manipulate).toHaveBeenCalledWith(photo.uri);
      expect(result.images).toEqual([expect.objectContaining({ mimeType: "image/jpeg" })]);
    });

    // regression: #11440 render photo library picks to a bounded JPEG off the JS thread
    it("renders a supported original whose size cannot be measured", async () => {
      mocks.pickMedia.mockResolvedValue({
        canceled: false,
        assets: [
          { ...photo, uri: "content://media/1", fileName: "photo.png", mimeType: "image/png" },
        ],
      });

      const result = await pickComposerImages({ existingCount: 0 });

      expect(mocks.readBase64).not.toHaveBeenCalled();
      expect(mocks.manipulate).toHaveBeenCalledWith("content://media/1");
      expect(result.images).toEqual([expect.objectContaining({ mimeType: "image/jpeg" })]);
    });

    it("checks the rendered JPEG against the image limit", async () => {
      native.saved = {
        uri: rendered.uri,
        base64:
          rendered.base64.slice(0, 4) +
          "A".repeat(Math.ceil(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 3) * 4),
      };
      mocks.pickMedia.mockResolvedValue({ canceled: false, assets: [photo] });

      await expect(pickComposerImages({ existingCount: 0 })).resolves.toEqual({
        images: [],
        error: "'photo.HEIC' exceeds the 10 MB attachment limit.",
      });
    });

    it("retains a rendered photo when another original cannot be read", async () => {
      mocks.pickMedia.mockResolvedValue({
        canceled: false,
        assets: [{ ...photo, fileName: "missing.gif", mimeType: "image/gif" }, photo],
      });
      mocks.readBase64.mockRejectedValue(new Error("missing file"));

      const result = await pickComposerImages({ existingCount: 0 });

      expect(result.images).toEqual([expect.objectContaining({ name: "photo.jpg" })]);
      expect(result.error).toBe("Failed to read 'missing.gif'.");
    });

    // regression: #11440 render photo library picks to a bounded JPEG off the JS thread
    it("reports a photo the native renderer cannot decode", async () => {
      mocks.manipulate.mockImplementation(() => ({
        resize: () => {
          throw new Error("unreachable");
        },
        renderAsync: () => Promise.reject(new Error("corrupt")),
      }));
      mocks.pickMedia.mockResolvedValue({ canceled: false, assets: [photo] });

      await expect(pickComposerImages({ existingCount: 0 })).resolves.toEqual({
        images: [],
        error: "Failed to read 'photo.HEIC'.",
      });
    });
  });
  describe("photo library videos", () => {
    const image: ImagePickerAsset = {
      uri: "file:///picker/photo.png",
      type: "image",
      fileName: "photo.png",
      mimeType: "image/png",
      fileSize: 3,
      width: 1,
      height: 1,
    };

    beforeEach(() => {
      mocks.readBase64.mockResolvedValue("YWJj");
    });
    const video: ImagePickerAsset = {
      uri: "file:///picker/clip.mov",
      type: "video",
      fileName: "clip.mov",
      mimeType: "video/quicktime",
      fileSize: 20 * 1024 * 1024,
      base64: null,
      width: 1920,
      height: 1080,
    };

    it("retains mixed photos and videos, keeping video bytes in durable file storage", async () => {
      mocks.pickMedia.mockResolvedValue({ canceled: false, assets: [image, video] });
      mocks.size.mockImplementation((uri: string) =>
        uri.endsWith("clip.mov") ? video.fileSize : 3,
      );

      const result = await pickComposerMedia({ existingCount: 0, maxVideoBytes: 50 * 1024 * 1024 });

      expect(mocks.pickMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaTypes: ["images", "videos"],
          shouldDownloadFromNetwork: true,
        }),
      );
      expect(result).toEqual({
        attachments: [
          expect.objectContaining({ type: "image", dataUrl: "data:image/png;base64,YWJj" }),
          {
            id: "attachment-id",
            type: "file",
            name: "clip.mov",
            mimeType: "video/quicktime",
            sizeBytes: video.fileSize,
            fileUri: "file:///documents/t3-composer-attachments/attachment-id-clip.mov",
          },
        ],
        error: null,
      });
      expect(mocks.copy).toHaveBeenCalledWith(
        video.uri,
        "file:///documents/t3-composer-attachments/attachment-id-clip.mov",
      );
      expect(mocks.delete).not.toHaveBeenCalled();
    });

    it("does not persist videos when the destination lacks file support", async () => {
      mocks.pickMedia.mockResolvedValue({ canceled: false, assets: [video, image] });

      const result = await pickComposerMedia({ existingCount: 0 });

      expect(result.attachments).toEqual([expect.objectContaining({ type: "image" })]);
      expect(result.error).toBe("Video attachments are unavailable here.");
      expect(mocks.copy).not.toHaveBeenCalled();
    });

    it("uses local video metadata when the picker omits its name, MIME type, or size", async () => {
      mocks.pickMedia.mockResolvedValue({
        canceled: false,
        assets: [{ ...video, fileName: null, mimeType: undefined, fileSize: undefined }],
      });

      const result = await pickComposerMedia({ existingCount: 0, maxVideoBytes: 1024 });

      expect(result.error).toBeNull();
      expect(result.attachments).toEqual([
        expect.objectContaining({
          type: "file",
          name: "clip.mov",
          mimeType: "video/quicktime",
          sizeBytes: 42,
        }),
      ]);
    });

    it.each([
      {
        reason: "actual size exceeds the server limit",
        reported: 42,
        stored: 2 * 1024 * 1024,
        limit: 1024 * 1024,
        error: "'clip.mov' exceeds the 1 MB attachment limit.",
      },
      {
        reason: "stored copy is empty",
        reported: 42,
        stored: 0,
        limit: 1024 * 1024,
        error: "'clip.mov' is empty or could not be read.",
      },
      {
        reason: "server advertises more than the contract limit",
        reported: 51 * 1024 * 1024,
        stored: 42,
        limit: 80 * 1024 * 1024,
        error: "'clip.mov' exceeds the 50 MB attachment limit.",
      },
    ])(
      "rejects a video when $reason while retaining the selected photo",
      async ({ reported, stored, limit, error }) => {
        mocks.pickMedia.mockResolvedValue({
          canceled: false,
          assets: [{ ...video, fileSize: reported }, image],
        });
        mocks.size.mockImplementation((uri: string) => (uri.endsWith("clip.mov") ? stored : 3));

        const result = await pickComposerMedia({ existingCount: 0, maxVideoBytes: limit });

        expect(result).toEqual({
          attachments: [expect.objectContaining({ type: "image" })],
          error,
        });
        if (stored === 0) {
          expect(mocks.delete).toHaveBeenCalledWith(
            "file:///documents/t3-composer-attachments/attachment-id-clip.mov",
          );
        }
      },
    );

    it("applies the remaining attachment slots to photos and videos together", async () => {
      mocks.pickMedia.mockResolvedValue({ canceled: false, assets: [image, video] });

      const result = await pickComposerMedia({
        existingCount: 99,
        maxVideoBytes: 50 * 1024 * 1024,
      });

      expect(result.attachments).toEqual([expect.objectContaining({ type: "image" })]);
      expect(result.error).toBe("You can attach up to 100 attachments per message.");
      expect(mocks.pickMedia).toHaveBeenCalledWith(expect.objectContaining({ selectionLimit: 1 }));
      expect(mocks.copy).not.toHaveBeenCalled();
    });

    it("reports a native video retrieval error and ends the foreground handoff", async () => {
      mocks.pickMedia.mockRejectedValue(new Error("Could not download video from iCloud."));

      await expect(pickComposerMedia({ existingCount: 0, maxVideoBytes: 1024 })).resolves.toEqual({
        attachments: [],
        error: "Could not download video from iCloud.",
      });
      expect(isForegroundHandoffActive()).toBe(false);
    });
  });
});

