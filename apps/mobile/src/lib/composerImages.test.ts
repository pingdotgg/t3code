import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";

const files = new Map<string, { base64: string; deleted: boolean }>();
const paths = { documentUri: "file:///documents" };

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
      return files.has(this.uri) && files.get(this.uri)?.deleted === false;
    }

    get size(): number | null {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) {
        return null;
      }
      return Buffer.from(entry.base64, "base64").byteLength;
    }

    create(): void {}

    async copy(destination: File): Promise<void> {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) {
        throw new Error("missing file");
      }
      files.set(destination.uri, { base64: entry.base64, deleted: false });
    }

    async base64(): Promise<string> {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) {
        throw new Error("missing file");
      }
      return entry.base64;
    }

    delete(): void {
      const entry = files.get(this.uri);
      if (entry) {
        entry.deleted = true;
      }
    }
  }

  return {
    Directory,
    File,
    FileMode: { ReadOnly: "r", WriteOnly: "w" },
    Paths: {
      get document() {
        return { uri: paths.documentUri };
      },
    },
  };
});

vi.mock("./uuid", () => ({
  uuidv4: () => "attachment-id",
}));

import {
  composerImageAttachmentDataUrl,
  convertPastedImagesToAttachments,
  isOwnedPastedImageUri,
  toUploadChatImageAttachments,
} from "./composerImages";

describe("toUploadChatImageAttachments", () => {
  beforeEach(() => {
    files.clear();
    paths.documentUri = "file:///documents";
  });

  it("strips client draft id and previewUri for the startTurn wire shape", async () => {
    await expect(
      toUploadChatImageAttachments([
        {
          id: "client-draft-id",
          type: "image",
          name: "pasted-image.png",
          mimeType: "image/png",
          sizeBytes: 12,
          dataUrl: "data:image/png;base64,AA==",
          previewUri: "file:///tmp/preview.png",
        },
      ]),
    ).resolves.toEqual([
      {
        type: "image",
        name: "pasted-image.png",
        mimeType: "image/png",
        sizeBytes: 12,
        dataUrl: "data:image/png;base64,AA==",
      },
    ]);
  });

  it("reads file-backed image bytes lazily from the owned copy", async () => {
    const fileUri = "file:///documents/t3-composer-attachments/attachment-id-photo.png";
    files.set(fileUri, { base64: "aGVsbG8=", deleted: false });
    const attachment = {
      id: "client-draft-id",
      type: "image" as const,
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 5,
      fileUri,
      previewUri: fileUri,
    };

    await expect(toUploadChatImageAttachments([attachment])).resolves.toEqual([
      {
        type: "image",
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 5,
        dataUrl: "data:image/png;base64,aGVsbG8=",
      },
    ]);
  });

  it("resolves a restored image from the current iOS document container", async () => {
    const fileName = "33333333-3333-4333-8333-333333333333-photo.png";
    paths.documentUri =
      "file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents";
    const currentUri = `${paths.documentUri}/t3-composer-attachments/${fileName}`;
    files.set(currentUri, { base64: "aGVsbG8=", deleted: false });

    await expect(
      composerImageAttachmentDataUrl({
        id: "client-draft-id",
        type: "image",
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 5,
        fileUri: `file:///var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/t3-composer-attachments/${fileName}`,
        previewUri: currentUri,
      }),
    ).resolves.toBe("data:image/png;base64,aGVsbG8=");
  });

  it("rejects an attachment that lost both its bytes and its file", async () => {
    await expect(
      composerImageAttachmentDataUrl({
        id: "client-draft-id",
        type: "image",
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 5,
        previewUri: "file:///tmp/preview.png",
      }),
    ).rejects.toThrow("'photo.png' is no longer available. Attach the image again.");
  });
});

describe("native pasted image cleanup", () => {
  beforeEach(() => {
    files.clear();
  });

  it("recognizes only files created in the native composer paste directory", () => {
    expect(
      isOwnedPastedImageUri(
        "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png",
      ),
    ).toBe(true);
    expect(isOwnedPastedImageUri("file:///private/var/mobile/photos/id.png")).toBe(false);
    expect(isOwnedPastedImageUri("https://example.com/t3-composer-paste/id.png")).toBe(false);
  });

  it("copies owned files into durable storage without inlining bytes, deleting the source", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });

    const attachments = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    const fileUri = "file:///documents/t3-composer-attachments/attachment-id-pasted-image.png";
    expect(attachments).toEqual([
      {
        id: "attachment-id",
        type: "image",
        name: "pasted-image.png",
        mimeType: "image/png",
        sizeBytes: 5,
        fileUri,
        previewUri: fileUri,
      },
    ]);
    expect(files.get(uri)?.deleted).toBe(true);
    expect(files.get(fileUri)?.deleted).toBe(false);
  });

  it("deletes rejected and overflow owned files without deleting user-owned files", async () => {
    const rejected =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/bad.png";
    const overflow =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/overflow.png";
    const userOwned = "file:///private/var/mobile/photos/library.png";
    files.set(rejected, { base64: "", deleted: false });
    files.set(overflow, { base64: "aGVsbG8=", deleted: false });
    files.set(userOwned, { base64: "aGVsbG8=", deleted: false });

    await convertPastedImagesToAttachments({
      uris: [rejected, overflow, userOwned],
      existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
    });

    expect(files.get(rejected)?.deleted).toBe(true);
    expect(files.get(overflow)?.deleted).toBe(true);
    expect(files.get(userOwned)?.deleted).toBe(false);
    // The rejected paste's partial durable copy must not leak either.
    expect(
      files.get("file:///documents/t3-composer-attachments/attachment-id-pasted-image.png")
        ?.deleted,
    ).toBe(true);
  });
});
