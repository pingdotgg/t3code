import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  documentUri: "file:///documents",
  pickFile: vi.fn(),
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

vi.mock("./uuid", () => ({ uuidv4: () => "attachment-id" }));

import {
  persistComposerAttachmentFile,
  pickComposerFiles,
  removePersistedComposerAttachmentFile,
} from "./composerImages";

describe("pickComposerFiles", () => {
  beforeEach(() => {
    mocks.documentUri = "file:///documents";
    mocks.pickFile.mockReset();
    mocks.copy.mockReset();
    mocks.delete.mockReset();
    mocks.open.mockReset();
    mocks.size.mockReset();
    mocks.size.mockImplementation((uri: string) => (uri.startsWith("content:") ? null : 42));
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
