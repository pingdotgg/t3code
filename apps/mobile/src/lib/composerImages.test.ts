import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";

const files = new Map<string, { base64: string; deleted: boolean; text?: string }>();

const clipboard = vi.hoisted(() => ({
  hasImageAsync: vi.fn(),
  getImageAsync: vi.fn(),
  hasStringAsync: vi.fn(),
  getStringAsync: vi.fn(),
}));

vi.mock("expo-clipboard", () => clipboard);

vi.mock("expo-file-system", () => ({
  File: class {
    readonly uri: string;
    readonly name: string;
    readonly parentDirectory: { readonly uri: string };

    constructor(parent: string | { readonly uri: string }, name?: string) {
      const parentUri = typeof parent === "string" ? parent : parent.uri;
      this.uri = name ? `${parentUri}/${name}` : parentUri;
      this.name = name ?? this.uri.split("/").at(-1) ?? "file";
      this.parentDirectory = { uri: this.uri.slice(0, -(this.name.length + 1)) };
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

    create(): void {
      files.set(this.uri, { base64: "", deleted: false });
    }

    write(text: string): void {
      files.set(this.uri, { base64: "", deleted: false, text });
    }

    moveSync(destination: { readonly uri: string }): void {
      const entry = files.get(this.uri);
      if (!entry) throw new Error("missing staged file");
      files.set(destination.uri, entry);
      files.delete(this.uri);
    }
  },
  Directory: class {
    readonly uri: string;

    constructor(parent: string, name: string) {
      this.uri = `${parent}/${name}`;
    }

    create(): void {}
  },
  Paths: { document: "file:///documents" },
}));

vi.mock("./uuid", () => ({
  uuidv4: () => "attachment-id",
}));

import {
  convertPastedImagesToAttachments,
  createPastedTextComposerAttachment,
  isOwnedPastedImageUri,
  pasteComposerClipboard,
} from "./composerImages";

describe("composer clipboard paste", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboard.hasImageAsync.mockResolvedValue(false);
    clipboard.hasStringAsync.mockResolvedValue(true);
    clipboard.getStringAsync.mockResolvedValue("clipboard text");
    clipboard.getImageAsync.mockResolvedValue({ data: "data:image/png;base64,aGVsbG8=" });
  });

  it("returns only the image when the clipboard contains both image and text", async () => {
    clipboard.hasImageAsync.mockResolvedValue(true);
    const result = await pasteComposerClipboard({ existingCount: 0 });
    expect(result).toEqual({
      images: [expect.objectContaining({ type: "image", name: "pasted-image.png" })],
      text: null,
      error: null,
    });
    expect(clipboard.getStringAsync).not.toHaveBeenCalled();
  });

  it("does not paste alternate text when the image cannot fit", async () => {
    clipboard.hasImageAsync.mockResolvedValue(true);
    expect(
      await pasteComposerClipboard({ existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }),
    ).toEqual({ images: [], text: null, error: expect.stringContaining("up to") });
    expect(clipboard.getStringAsync).not.toHaveBeenCalled();
  });

  it("returns plain text without image chips", async () => {
    expect(await pasteComposerClipboard({ existingCount: 0 })).toEqual({
      images: [],
      text: "clipboard text",
      error: null,
    });
  });

  it("reports an empty text clipboard", async () => {
    clipboard.getStringAsync.mockResolvedValue("");
    expect(await pasteComposerClipboard({ existingCount: 0 })).toEqual({
      images: [],
      text: null,
      error: "Clipboard is empty.",
    });
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

  it("persists folded text unchanged in the app-owned attachment directory", async () => {
    const text = "first line\nUnicode: 🙂\n";
    const attachment = await createPastedTextComposerAttachment({
      text,
      name: "pasted-text.txt",
      maxBytes: 1024,
    });

    expect(attachment).toEqual({
      id: "attachment-id",
      type: "file",
      name: "pasted-text.txt",
      mimeType: "text/plain;charset=utf-8",
      sizeBytes: new TextEncoder().encode(text).byteLength,
      fileUri: "file:///documents/t3-composer-attachments/attachment-id-pasted-text.txt",
      source: { _tag: "pasted-text" },
    });
    expect(files.get(attachment.fileUri)?.text).toBe(text);
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

  it("keeps media, because a thumbnail is the only way to see it", async () => {
    const { composerStripAttachments } = await import("./composerImages");
    const kept = composerStripAttachments([image, video] as never);
    expect(kept.map((a) => a.id)).toEqual(["img-1", "vid-1"]);
  });

  it("never shows a non-media file above the composer", async () => {
    const { composerStripAttachments } = await import("./composerImages");
    // A document reads as its inline chip. A tile with a generic glyph says less than the
    // chip does, so it is not a fallback worth having, chip present or not.
    expect(composerStripAttachments([doc] as never)).toEqual([]);
  });

  it("keeps media beside a document rather than dropping the whole strip", async () => {
    const { composerStripAttachments } = await import("./composerImages");
    expect(composerStripAttachments([doc, image, video] as never).map((a) => a.id)).toEqual([
      "img-1",
      "vid-1",
    ]);
  });

  it("treats a picture picked through the document picker as media", async () => {
    const { composerStripAttachments } = await import("./composerImages");
    // The document picker types every pick as a plain file; what it *is* decides the strip.
    const pickedImage = {
      id: "pick-1",
      type: "file" as const,
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 30,
      fileUri: "file:///photo.png",
    };
    expect(composerStripAttachments([pickedImage] as never).map((a) => a.id)).toEqual(["pick-1"]);
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
