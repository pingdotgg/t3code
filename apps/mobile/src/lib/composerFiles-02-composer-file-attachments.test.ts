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

    it.each([false, true])("fits a large PNG with oversized output: %s", async (oversized) => {
      const header = Buffer.alloc(24);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
      header.write("IHDR", 12);
      header.writeUInt32BE(4000, 16);
      header.writeUInt32BE(3000, 20);
      const original = header.toString("base64");
      mocks.readBase64.mockResolvedValue(original);
      const resize = vi.fn();
      const renderAsync = vi.fn(async () => ({
        width: 4000,
        height: 3000,
        release: vi.fn(),
        saveAsync: vi.fn(async () => ({
          uri: "file:///cache/fitted.png",
          base64: oversized
            ? Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1).toString("base64")
            : "YWJj",
        })),
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
            sizeBytes: oversized ? header.length : 3,
            dataUrl: `data:image/png;base64,${oversized ? original : "YWJj"}`,
            previewUri: oversized
              ? `data:image/png;base64,${original}`
              : "file:///cache/fitted.png",
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

