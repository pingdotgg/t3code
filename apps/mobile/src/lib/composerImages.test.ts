import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

const files = new Map<string, { base64: string; deleted: boolean; text?: string }>();

const clipboard = vi.hoisted(() => ({
  hasImageAsync: vi.fn(),
  getImageAsync: vi.fn(),
  hasStringAsync: vi.fn(),
  getStringAsync: vi.fn(),
}));

vi.mock("expo-clipboard", () => clipboard);

const manipulator = vi.hoisted(() => {
  const state = { sourceSize: { width: 0, height: 0 } };
  const manipulate = vi.fn((source: string | { width: number; height: number }) => {
    let size = typeof source === "string" ? state.sourceSize : source;
    const context = {
      resize: vi.fn((next: { width: number; height: number }) => {
        size = next;
        return context;
      }),
      renderAsync: vi.fn(async () => ({
        ...size,
        release: vi.fn(),
        saveAsync: vi.fn(async (options: { format: string }) => ({
          uri: `file:///cache/rendered.${options.format}`,
          base64: `cmVuZGVyZWQ=`,
        })),
      })),
    };
    return context;
  });
  return { state, manipulate };
});

vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate: manipulator.manipulate },
  SaveFormat: { JPEG: "jpeg", PNG: "png" },
}));

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

import { convertPastedImagesToAttachments, pasteComposerClipboard } from "./composerImages";

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
});

describe("oversized pasted images", () => {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const pngDataUrl = (width: number, height: number) =>
    `data:image/png;base64,${Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...u32(13),
      0x49,
      0x48,
      0x44,
      0x52,
      ...u32(width),
      ...u32(height),
      8,
      6,
      0,
      0,
      0,
    ]).toString("base64")}`;

  beforeEach(() => {
    vi.clearAllMocks();
    clipboard.hasImageAsync.mockResolvedValue(true);
  });

  it("scales a clipboard screenshot over 2000px to 2000px and keeps it a PNG", async () => {
    manipulator.state.sourceSize = { width: 3024, height: 1964 };
    const pasted = pngDataUrl(3024, 1964);
    clipboard.getImageAsync.mockResolvedValue({ data: pasted });

    const result = await pasteComposerClipboard({ existingCount: 0 });

    expect(manipulator.manipulate).toHaveBeenCalledWith(pasted);
    const resize = manipulator.manipulate.mock.results.at(-1)?.value.resize;
    expect(resize).toHaveBeenCalledWith({ width: 2000, height: 1299 });
    expect(result.images).toEqual([
      expect.objectContaining({
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,cmVuZGVyZWQ=",
        previewUri: "data:image/png;base64,cmVuZGVyZWQ=",
      }),
    ]);
  });
});

describe("native pasted image cleanup", () => {
  beforeEach(() => {
    files.clear();
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

  it("keeps media beside a document rather than dropping the whole strip", async () => {
    const { composerStripAttachments } = await import("./composerImages");
    expect(composerStripAttachments([doc, image, video] as never).map((a) => a.id)).toEqual([
      "img-1",
      "vid-1",
    ]);
  });

  it("keeps oversized document-picked images visible while sending them as files", async () => {
    const { composerStripAttachments, isComposerImageAttachment } =
      await import("./composerImages");
    const oversizedImage = {
      ...video,
      id: "large-image",
      name: "large.png",
      mimeType: "image/png",
      fileUri: "file:///large.png",
      sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
    };

    expect(composerStripAttachments([oversizedImage])).toEqual([oversizedImage]);
    expect(isComposerImageAttachment(oversizedImage)).toBe(false);
  });
});
