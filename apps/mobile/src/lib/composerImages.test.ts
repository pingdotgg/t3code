import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";

const files = new Map<string, { base64: string; deleted: boolean }>();

vi.mock("expo-file-system", () => ({
  File: class {
    readonly uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists(): boolean {
      return files.has(this.uri) && files.get(this.uri)?.deleted === false;
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
  },
}));

vi.mock("./uuid", () => ({
  uuidv4: () => "attachment-id",
}));

import { convertPastedImagesToAttachments, isOwnedPastedImageUri } from "./composerImages";

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

  it("converts owned files to data-backed previews and deletes the source", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });

    const attachments = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toEqual([
      expect.objectContaining({
        dataUrl: "data:image/png;base64,aGVsbG8=",
        previewUri: "data:image/png;base64,aGVsbG8=",
      }),
    ]);
    expect(files.get(uri)?.deleted).toBe(true);
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
  });
});

describe("composerStripAttachments", () => {
  const image = {
    id: "img-1",
    type: "image" as const,
    name: "shot.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 10,
    dataUrl: "",
  };
  const video = {
    id: "vid-1",
    type: "file" as const,
    name: "clip.mp4",
    mimeType: "video/mp4",
    sizeBytes: 20,
    fileUri: "file:///clip.mp4",
  };
  const doc = {
    id: "doc-1",
    type: "file" as const,
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    fileUri: "file:///notes.txt",
  };

  it("keeps media even when it already has an inline chip", async () => {
    const { composerStripAttachments } = await import("./composerImages");
    const kept = composerStripAttachments([image, video] as never, new Set(["img-1", "vid-1"]));
    // A thumbnail is the only way to see media, so it stays regardless of the chip.
    expect(kept.map((a) => a.id)).toEqual(["img-1", "vid-1"]);
  });

  it("drops a plain file once its inline chip represents it", async () => {
    const { composerStripAttachments } = await import("./composerImages");
    expect(composerStripAttachments([doc] as never, new Set(["doc-1"]))).toEqual([]);
  });

  it("keeps a plain file that has no inline chip", async () => {
    const { composerStripAttachments } = await import("./composerImages");
    expect(composerStripAttachments([doc] as never, new Set()).map((a) => a.id)).toEqual(["doc-1"]);
  });
});

describe("composerAttachmentInlineUri", () => {
  it("offers the inline bytes of a picture that owns no file", async () => {
    const { composerAttachmentInlineUri } = await import("./composerImages");
    // The photo library and the clipboard both produce this shape. Its `attachmentId` is a
    // local draft id, so a remote asset lookup for it can only fail.
    expect(
      composerAttachmentInlineUri({
        id: "img-1",
        type: "image",
        name: "IMG_0111.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 9_100_000,
        dataUrl: "data:image/jpeg;base64,AAAA",
        previewUri: "ph://asset",
      } as never),
    ).toBe("data:image/jpeg;base64,AAAA");
  });

  it("falls back to the preview when a picture kept only its asset uri", async () => {
    const { composerAttachmentInlineUri } = await import("./composerImages");
    expect(
      composerAttachmentInlineUri({
        id: "img-2",
        type: "image",
        name: "IMG_0112.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 10,
        previewUri: "ph://asset",
      } as never),
    ).toBe("ph://asset");
  });

  it("leaves a file-backed attachment to the retain-lease path", async () => {
    const { composerAttachmentInlineUri } = await import("./composerImages");
    expect(
      composerAttachmentInlineUri({
        id: "img-3",
        type: "image",
        name: "IMG_0113.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 10,
        fileUri: "file:///owned.jpg",
        previewUri: "file:///owned.jpg",
      } as never),
    ).toBeUndefined();
  });

  it("has nothing to offer for a plain file or a missing attachment", async () => {
    const { composerAttachmentInlineUri } = await import("./composerImages");
    expect(composerAttachmentInlineUri(undefined)).toBeUndefined();
    expect(
      composerAttachmentInlineUri({
        id: "doc-1",
        type: "file",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        fileUri: "file:///notes.txt",
      } as never),
    ).toBeUndefined();
  });
});
