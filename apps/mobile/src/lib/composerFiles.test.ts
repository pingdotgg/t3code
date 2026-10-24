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
    const native = {
      size: { width: 1, height: 1 },
      resizes: [] as Array<{ width?: number | null; height?: number | null }>,
      saved: rendered as { uri: string; base64?: string },
    };

    beforeEach(() => {
      native.size = { width: 1, height: 1 };
      native.resizes = [];
      native.saved = rendered;
      mocks.manipulate.mockReset();
      mocks.release.mockReset();
      mocks.manipulate.mockImplementation(() => {
        const context = {
          resize(size: { width?: number | null; height?: number | null }) {
            native.resizes.push(size);
            return context;
          },
          renderAsync: async () => ({
            ...native.size,
            release: mocks.release,
            saveAsync: async () => native.saved,
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

  describe("images chosen through the file picker", () => {
    it.each([
      { name: "photo.bin", mimeType: "image/jpeg", expected: "image/jpeg" },
      { name: "photo.png", mimeType: "image/png", expected: "image/png" },
      { name: "photo.gif", mimeType: "image/gif", expected: "image/gif" },
      { name: "photo.webp", mimeType: "image/webp", expected: "image/webp" },
      { name: "photo.JPG", mimeType: undefined, expected: "image/jpeg" },
      { name: "photo.PNG", mimeType: "application/octet-stream", expected: "image/png" },
      { name: "photo.gif", mimeType: "binary/octet-stream", expected: "image/gif" },
      { name: "photo.webp", mimeType: "application/unknown", expected: "image/webp" },
      { name: "photo.jpg", mimeType: "IMAGE/PNG; charset=binary", expected: "image/png" },
    ])("prepares $name ($mimeType) as $expected", async ({ name, mimeType, expected }) => {
      mocks.pickFile.mockResolvedValue({
        canceled: false,
        assets: [{ uri: `file:///picker/${name}`, name, mimeType, size: 3 }],
      });
      mocks.size.mockReturnValue(3);
      mocks.readBase64.mockResolvedValue("YWJj");

      const result = await pickComposerFiles({ existingCount: 0 });

      expect(result).toEqual({
        files: [
          {
            id: "attachment-id",
            type: "image",
            name,
            mimeType: expected,
            sizeBytes: 3,
            dataUrl: `data:${expected};base64,YWJj`,
            previewUri: `data:${expected};base64,YWJj`,
          },
        ],
        error: null,
      });
      expect(mocks.manipulate).not.toHaveBeenCalled();
      expect(mocks.delete).toHaveBeenCalledWith(
        `file:///documents/t3-composer-attachments/attachment-id-${name}`,
      );
    });

    it.each([
      { name: "diagram.svg", mimeType: "image/svg+xml" },
      { name: "photo.heic", mimeType: "image/heic" },
      { name: "photo.tiff", mimeType: "image/tiff" },
      { name: "photo.png", mimeType: "application/pdf" },
      { name: "unknown.bin", mimeType: "application/octet-stream" },
    ])("keeps $name ($mimeType) as a file", async ({ name, mimeType }) => {
      mocks.pickFile.mockResolvedValue({
        canceled: false,
        assets: [{ uri: `file:///picker/${name}`, name, mimeType, size: 42 }],
      });

      const result = await pickComposerFiles({ existingCount: 0 });

      expect(result.error).toBeNull();
      expect(result.files).toEqual([expect.objectContaining({ type: "file", name, mimeType })]);
      expect(mocks.readBase64).not.toHaveBeenCalled();
      expect(mocks.manipulate).not.toHaveBeenCalled();
      expect(mocks.delete).not.toHaveBeenCalled();
    });

    it.each([PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1])(
      "classifies a measured %s byte PNG independently of picker metadata and file limit",
      async (size) => {
        mocks.pickFile.mockResolvedValue({
          canceled: false,
          assets: [
            { uri: "file:///picker/photo.png", name: "photo.png", mimeType: "image/png", size: 1 },
          ],
        });
        mocks.size.mockReturnValue(size);
        mocks.readBase64.mockResolvedValue("YWJj");

        const result = await pickComposerFiles({
          existingCount: 0,
          maxBytes: size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES ? size : 1024,
        });

        expect(result.error).toBeNull();
        expect(result.files[0]?.type).toBe(
          size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES ? "file" : "image",
        );
        expect(isComposerImageAttachment(result.files[0]!)).toBe(
          size <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
        );
        expect(mocks.readBase64).toHaveBeenCalledTimes(
          size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES ? 0 : 1,
        );
      },
    );

    it("fits a large PNG with the photo picker renderer and sends the fitted bytes", async () => {
      const header = Buffer.alloc(24);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
      header.write("IHDR", 12);
      header.writeUInt32BE(4000, 16);
      header.writeUInt32BE(3000, 20);
      mocks.readBase64.mockResolvedValue(header.toString("base64"));
      const resize = vi.fn();
      const renderAsync = vi.fn(async () => ({
        width: 4000,
        height: 3000,
        release: vi.fn(),
        saveAsync: vi.fn(async () => ({ uri: "file:///cache/fitted.png", base64: "YWJj" })),
      }));
      mocks.manipulate.mockImplementation(() => {
        const context = {
          resize: (size: unknown) => {
            resize(size);
            return context;
          },
          renderAsync,
        };
        return context;
      });
      mocks.pickFile.mockResolvedValue({
        canceled: false,
        assets: [{ uri: "file:///picker/photo.png", name: "photo.png", mimeType: "image/png" }],
      });

      const result = await pickComposerFiles({ existingCount: 0 });

      expect(resize).toHaveBeenCalledWith({ width: 2000, height: 1500 });
      expect(result).toEqual({
        files: [
          expect.objectContaining({
            type: "image",
            mimeType: "image/png",
            sizeBytes: 3,
            dataUrl: "data:image/png;base64,YWJj",
            previewUri: "file:///cache/fitted.png",
          }),
        ],
        error: null,
      });
    });

    it("releases the owned copy when reading an image fails", async () => {
      mocks.pickFile.mockResolvedValue({
        canceled: false,
        assets: [{ uri: "file:///picker/photo.png", name: "photo.png", mimeType: "image/png" }],
      });
      mocks.readBase64.mockRejectedValue(new Error("unreadable image"));

      expect(await pickComposerFiles({ existingCount: 0 })).toEqual({
        files: [],
        error: "unreadable image",
      });
      expect(mocks.delete).toHaveBeenCalledWith(
        "file:///documents/t3-composer-attachments/attachment-id-photo.png",
      );
    });
  });

  it("copies picked files into app-owned storage without loading their contents", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///downloads/report.pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
          size: 42,
        },
      ],
    });

    await expect(pickComposerFiles({ existingCount: 0 })).resolves.toEqual({
      files: [
        {
          id: "attachment-id",
          type: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
          fileUri: "file:///documents/t3-composer-attachments/attachment-id-report.pdf",
        },
      ],
      error: null,
    });
    expect(mocks.copy).toHaveBeenCalledWith(
      "file:///downloads/report.pdf",
      "file:///documents/t3-composer-attachments/attachment-id-report.pdf",
    );
  });

  it("preserves Android picker metadata instead of using the content URI document id", async () => {
    const uri = "content://com.android.providers.media.documents/document/video%3A18";
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri,
          name: "preview-h264.mp4",
          mimeType: "video/mp4",
          size: 620_992,
          lastModified: 0,
        },
      ],
    });
    mocks.size.mockReturnValue(620_992);

    await expect(pickComposerFiles({ existingCount: 0 })).resolves.toEqual({
      files: [
        {
          id: "attachment-id",
          type: "file",
          name: "preview-h264.mp4",
          mimeType: "video/mp4",
          sizeBytes: 620_992,
          fileUri: "file:///documents/t3-composer-attachments/attachment-id-preview-h264.mp4",
        },
      ],
      error: null,
    });
    expect(mocks.pickFile).toHaveBeenCalledWith({ multiple: true, copyToCacheDirectory: true });
    expect(mocks.copy).toHaveBeenCalledWith(
      uri,
      "file:///documents/t3-composer-attachments/attachment-id-preview-h264.mp4",
    );
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("persists provider selections that require a readable cache copy", async () => {
    const providerUri = "content://cloud-provider/documents/clip";
    const cachedUri = "file:///cache/DocumentPicker/clip.mp4";
    mocks.pickFile.mockImplementation(async (options) => ({
      canceled: false,
      assets: [
        {
          uri: options.copyToCacheDirectory ? cachedUri : providerUri,
          name: "Cloud recording.mp4",
          mimeType: "video/mp4",
          size: 42,
          lastModified: 0,
        },
      ],
    }));
    mocks.copy.mockImplementation((uri: string) => {
      if (uri === providerUri) throw new Error("The provider URI is not directly readable.");
    });

    const result = await pickComposerFiles({ existingCount: 0 });

    expect(result.error).toBeNull();
    expect(result.files).toEqual([
      expect.objectContaining({
        name: "Cloud recording.mp4",
        fileUri: "file:///documents/t3-composer-attachments/attachment-id-Cloud recording.mp4",
      }),
    ]);
    expect(mocks.copy).toHaveBeenCalledWith(cachedUri, result.files[0]!.fileUri);
  });

  it("ends the foreground handoff when the picker is canceled without copying files", async () => {
    mocks.pickFile.mockImplementation(async () => {
      expect(isForegroundHandoffActive()).toBe(true);
      return { canceled: true, assets: null };
    });

    await expect(pickComposerFiles({ existingCount: 0 })).resolves.toEqual({
      files: [],
      error: null,
    });

    expect(isForegroundHandoffActive()).toBe(false);
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("does not open the picker when the draft has no remaining attachment slots", async () => {
    await expect(pickComposerFiles({ existingCount: 100 })).resolves.toEqual({
      files: [],
      error: "You can attach up to 100 files per message.",
    });

    expect(mocks.pickFile).not.toHaveBeenCalled();
    expect(isForegroundHandoffActive()).toBe(false);
  });

  it("rejects files that exceed the environment's advertised upload limit", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///downloads/archive.zip",
          name: "archive.zip",
          mimeType: "application/zip",
          size: 2 * 1024 * 1024,
        },
      ],
    });

    await expect(pickComposerFiles({ existingCount: 0, maxBytes: 1024 * 1024 })).resolves.toEqual({
      files: [],
      error: "'archive.zip' exceeds the 1 MB attachment limit.",
    });
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("rejects a file that grew after the picker reported its size", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///downloads/archive.zip",
          name: "archive.zip",
          mimeType: "application/zip",
          size: 42,
        },
      ],
    });
    mocks.size.mockReturnValue(2 * 1024 * 1024);

    await expect(pickComposerFiles({ existingCount: 0, maxBytes: 1024 * 1024 })).resolves.toEqual({
      files: [],
      error: "'archive.zip' exceeds the 1 MB attachment limit.",
    });
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("stops copying an unknown-size content URI when it exceeds the attachment limit", async () => {
    const maxBytes = 1024 * 1024;
    let remainingBytes = maxBytes + 1;
    const source = {
      readBytes: vi.fn((length: number) => {
        const size = Math.min(length, remainingBytes);
        remainingBytes -= size;
        return new Uint8Array(size);
      }),
      close: vi.fn(),
    };
    const destination = { writeBytes: vi.fn(), close: vi.fn() };
    mocks.open.mockImplementation((uri: string) =>
      uri.startsWith("content:") ? source : destination,
    );

    await expect(
      persistComposerAttachmentFile("content://shared/large", "large.bin", maxBytes),
    ).rejects.toThrow("'large.bin' exceeds the 1 MB attachment limit.");

    expect(source.close).toHaveBeenCalledOnce();
    expect(destination.close).toHaveBeenCalledOnce();
    expect(mocks.delete).toHaveBeenCalledWith(
      "file:///documents/t3-composer-attachments/attachment-id-large.bin",
    );
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("rejects a copy that delivered more bytes than the source reported", async () => {
    const maxBytes = 1024 * 1024;
    mocks.size.mockImplementation((uri: string) =>
      uri.startsWith("content:") ? 42 : 2 * 1024 * 1024,
    );

    await expect(
      persistComposerAttachmentFile("content://shared/liar", "liar.bin", maxBytes),
    ).rejects.toThrow("'liar.bin' exceeds the 1 MB attachment limit.");

    expect(mocks.copy).toHaveBeenCalledOnce();
    expect(mocks.delete).toHaveBeenCalledWith(
      "file:///documents/t3-composer-attachments/attachment-id-liar.bin",
    );
  });

  it.each([0, undefined])("copies an Android SAF file when the picker size is %s", async (size) => {
    const reader = {
      readBytes: vi
        .fn()
        .mockReturnValueOnce(new Uint8Array(42))
        .mockReturnValueOnce(new Uint8Array()),
      close: vi.fn(),
    };
    const writer = { writeBytes: vi.fn(), close: vi.fn() };
    mocks.size.mockImplementation((uri: string) => (uri.startsWith("content:") ? 0 : 42));
    mocks.open.mockImplementation((uri: string) => (uri.startsWith("content:") ? reader : writer));
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "content://shared/report",
          name: "report.pdf",
          mimeType: "application/pdf",
          size,
        },
      ],
    });

    await expect(pickComposerFiles({ existingCount: 0 })).resolves.toEqual({
      files: [
        {
          id: "attachment-id",
          type: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
          fileUri: "file:///documents/t3-composer-attachments/attachment-id-report.pdf",
        },
      ],
      error: null,
    });
  });

  it("uses the remaining slot for the first valid file after an oversized selection", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///downloads/huge.zip",
          name: "huge.zip",
          mimeType: "application/zip",
          size: 2 * 1024 * 1024,
        },
        {
          uri: "file:///downloads/report.pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
          size: 42,
        },
      ],
    });

    const result = await pickComposerFiles({ existingCount: 99, maxBytes: 1024 * 1024 });

    expect(result.files.map((file) => file.name)).toEqual(["report.pdf"]);
  });

  it("removes the partial destination file when a copy fails midway", async () => {
    mocks.copy.mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(
      persistComposerAttachmentFile("file:///downloads/report.pdf", "report.pdf"),
    ).rejects.toThrow("disk full");

    expect(mocks.delete).toHaveBeenCalledWith(
      "file:///documents/t3-composer-attachments/attachment-id-report.pdf",
    );
  });

  it("deletes app-owned attachments without touching user-owned files", async () => {
    await removePersistedComposerAttachmentFile(
      "file:///documents/t3-composer-attachments/report.pdf",
    );
    await removePersistedComposerAttachmentFile("file:///downloads/report.pdf");

    expect(mocks.delete).toHaveBeenCalledOnce();
    expect(mocks.delete).toHaveBeenCalledWith(
      "file:///documents/t3-composer-attachments/report.pdf",
    );
  });

  it("removes a restored attachment from the current iOS document container", async () => {
    const fileName = "33333333-3333-4333-8333-333333333333-report%20%23.pdf";
    const oldUri = `file:///private/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/t3-composer-attachments/${fileName}`;
    mocks.documentUri =
      "file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents";

    await removePersistedComposerAttachmentFile(oldUri);
    await removePersistedComposerAttachmentFile(
      `file:///var/mobile/Containers/Shared/FileProvider/other/Documents/t3-composer-attachments/${fileName}`,
    );
    await removePersistedComposerAttachmentFile(
      `${mocks.documentUri}/t3-composer-attachments/..%2F..%2Fsender.pdf`,
    );

    expect(mocks.delete.mock.calls).toEqual([
      [`${mocks.documentUri}/t3-composer-attachments/${fileName}`],
    ]);
  });

  it("rechecks preview ownership after loading the native filesystem", async () => {
    const fileName = "33333333-3333-4333-8333-333333333333-recording.mp4";
    const oldUri = `file:///private/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/t3-composer-attachments/${fileName}`;
    mocks.documentUri =
      "file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents";
    const currentUri = `${mocks.documentUri}/t3-composer-attachments/${fileName}`;

    const deleting = removePersistedComposerAttachmentFile(oldUri);
    const release = retainComposerAttachmentFile(currentUri, () => {});
    try {
      await deleting;
      expect(mocks.delete).not.toHaveBeenCalled();
    } finally {
      release();
    }

    await removePersistedComposerAttachmentFile(oldUri);
    expect(mocks.delete.mock.calls).toEqual([[currentUri]]);
  });

  it("copies an open-in-place source from its actual container without rebasing it", async () => {
    const sourceUri =
      "file:///var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/t3-composer-attachments/33333333-3333-4333-8333-333333333333-report.pdf";
    mocks.documentUri =
      "file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents";

    await persistComposerAttachmentFile(sourceUri, "report.pdf");

    expect(mocks.copy).toHaveBeenCalledWith(
      sourceUri,
      `${mocks.documentUri}/t3-composer-attachments/attachment-id-report.pdf`,
    );
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});
