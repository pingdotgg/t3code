import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ImagePickerAsset } from "expo-image-picker";

const mocks = vi.hoisted(() => ({
  documentUri: "file:///documents",
  pickFile: vi.fn(),
  pickMedia: vi.fn(),
  copy: vi.fn(),
  delete: vi.fn(),
  open: vi.fn(),
  size: vi.fn(),
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
    static pickFileAsync = mocks.pickFile;

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
vi.mock("./uuid", () => ({ uuidv4: () => "attachment-id" }));

import {
  persistComposerAttachmentFile,
  pickComposerFiles,
  pickComposerImages,
  pickComposerMedia,
  removePersistedComposerAttachmentFile,
} from "./composerImages";
import { isForegroundHandoffActive } from "./foreground-handoff";

describe("composer file attachments", () => {
  beforeEach(() => {
    mocks.documentUri = "file:///documents";
    mocks.pickFile.mockReset();
    mocks.pickMedia.mockReset();
    mocks.copy.mockReset();
    mocks.delete.mockReset();
    mocks.open.mockReset();
    mocks.size.mockReset();
    mocks.size.mockImplementation((uri: string) => (uri.startsWith("content:") ? null : 42));
  });

  describe("photo library videos", () => {
    const image: ImagePickerAsset = {
      uri: "file:///picker/photo.png",
      type: "image",
      fileName: "photo.png",
      mimeType: "image/png",
      fileSize: 3,
      base64: "YWJj",
      width: 1,
      height: 1,
    };
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
      mocks.size.mockReturnValue(video.fileSize);

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

    it("keeps image-only destinations on the image picker path", async () => {
      mocks.pickMedia.mockResolvedValue({ canceled: false, assets: [image] });

      const result = await pickComposerImages({ existingCount: 0 });

      expect(mocks.pickMedia).toHaveBeenCalledWith(
        expect.objectContaining({ mediaTypes: ["images"] }),
      );
      expect(result.images).toEqual([
        expect.objectContaining({ type: "image", name: "photo.png" }),
      ]);
      expect(result.error).toBeNull();
      expect(mocks.copy).not.toHaveBeenCalled();
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
        reason: "picker size exceeds the server limit",
        reported: 2 * 1024 * 1024,
        stored: 42,
        limit: 1024 * 1024,
        error: "'clip.mov' exceeds the 1 MB attachment limit.",
      },
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
        mocks.size.mockReturnValue(stored);

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

      const result = await pickComposerMedia({ existingCount: 7, maxVideoBytes: 50 * 1024 * 1024 });

      expect(result.attachments).toEqual([expect.objectContaining({ type: "image" })]);
      expect(result.error).toBe("You can attach up to 8 attachments per message.");
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

  it("copies picked files into app-owned storage without loading their contents", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      result: [
        {
          uri: "file:///downloads/report.pdf",
          name: "report.pdf",
          type: "application/pdf",
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

  it("falls back to a usable name when the picker reports a blank one", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      result: [
        {
          uri: "file:///downloads/unnamed",
          name: "   ",
          type: "application/pdf",
          size: 42,
        },
      ],
    });

    const result = await pickComposerFiles({ existingCount: 0 });
    expect(result.error).toBeNull();
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.name).toBe("file");
  });

  it("rejects files that exceed the environment's advertised upload limit", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      result: [
        {
          uri: "file:///downloads/archive.zip",
          name: "archive.zip",
          type: "application/zip",
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

  it("never accepts files above the 50 MB contract limit", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      result: [
        {
          uri: "file:///downloads/archive.zip",
          name: "archive.zip",
          type: "application/zip",
          size: 51 * 1024 * 1024,
        },
      ],
    });

    await expect(
      pickComposerFiles({ existingCount: 0, maxBytes: 80 * 1024 * 1024 }),
    ).resolves.toEqual({
      files: [],
      error: "'archive.zip' exceeds the 50 MB attachment limit.",
    });
  });

  it("rejects a file that grew after the picker reported its size", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      result: [
        {
          uri: "file:///downloads/archive.zip",
          name: "archive.zip",
          type: "application/zip",
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
    // An Android content: stream can report a small size and still deliver
    // more bytes; the persisted copy is what must satisfy the limit.
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

  it("reports an empty file without calling it oversized", async () => {
    mocks.size.mockReturnValue(0);
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      result: [
        {
          uri: "file:///downloads/empty.txt",
          name: "empty.txt",
          type: "text/plain",
          size: 0,
        },
      ],
    });

    await expect(pickComposerFiles({ existingCount: 0 })).resolves.toEqual({
      files: [],
      error: "'empty.txt' is empty or could not be read.",
    });
  });

  it("copies an Android SAF file when the picker reports an unknown zero size", async () => {
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
      result: [
        {
          uri: "content://shared/report",
          name: "report.pdf",
          type: "application/pdf",
          size: 0,
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
      result: [
        {
          uri: "file:///downloads/huge.zip",
          name: "huge.zip",
          type: "application/zip",
          size: 2 * 1024 * 1024,
        },
        {
          uri: "file:///downloads/report.pdf",
          name: "report.pdf",
          type: "application/pdf",
          size: 42,
        },
      ],
    });

    const result = await pickComposerFiles({ existingCount: 7, maxBytes: 1024 * 1024 });

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
