import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

const files = new Map<
  string,
  { base64: string; deleted: boolean; text?: string; mimeType?: string }
>();

const manipulator = vi.hoisted(() => {
  const state = { sourceSize: { width: 0, height: 0 }, renderedBase64: "cmVuZGVyZWQ=" };
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
        saveAsync: vi.fn(async (options: { format: string }) => {
          const uri = `file:///cache/rendered.${options.format}`;
          files.set(uri, { base64: state.renderedBase64, deleted: false });
          return { uri, base64: state.renderedBase64 };
        }),
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

    get type(): string {
      return files.get(this.uri)?.mimeType ?? "";
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

import { convertPastedImagesToAttachments } from "./composerImages";

describe("native pasted image cleanup", () => {
  beforeEach(() => {
    files.clear();
    manipulator.state.renderedBase64 = "cmVuZGVyZWQ=";
  });

  it("preserves the reported image type of extensionless Android content URIs", async () => {
    const uri = "content://media/external/images/media/42";
    files.set(uri, { base64: "aGVsbG8=", deleted: false, mimeType: "image/jpeg" });

    const attachments = await convertPastedImagesToAttachments({ uris: [uri], existingCount: 0 });

    expect(attachments).toEqual([
      expect.objectContaining({
        name: "pasted-image.jpeg",
        mimeType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,aGVsbG8=",
        previewUri: "data:image/jpeg;base64,aGVsbG8=",
      }),
    ]);
    expect(files.get(uri)?.deleted).toBe(false);
  });

  it("renders unsupported images to JPEG and removes the cache file after attaching", async () => {
    const uri = "content://media/external/images/media/43";
    files.set(uri, { base64: "b3JpZ2luYWw=", deleted: false, mimeType: "image/heic" });
    manipulator.state.sourceSize = { width: 100, height: 100 };

    const attachments = await convertPastedImagesToAttachments({ uris: [uri], existingCount: 0 });

    expect(attachments).toEqual([
      expect.objectContaining({
        name: "pasted-image.jpeg",
        mimeType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,cmVuZGVyZWQ=",
        previewUri: "data:image/jpeg;base64,cmVuZGVyZWQ=",
      }),
    ]);
    expect(files.get("file:///cache/rendered.jpeg")?.deleted).toBe(true);
    expect(files.get(uri)?.deleted).toBe(false);
  });

  it("removes the rendered JPEG when its bytes exceed the image limit", async () => {
    const uri = "content://media/external/images/media/43";
    files.set(uri, { base64: "b3JpZ2luYWw=", deleted: false, mimeType: "image/heic" });
    manipulator.state.sourceSize = { width: 100, height: 100 };
    manipulator.state.renderedBase64 = "A".repeat(
      Math.ceil((PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1) / 3) * 4,
    );

    const attachments = await convertPastedImagesToAttachments({ uris: [uri], existingCount: 0 });

    expect(attachments).toEqual([]);
    expect(files.get("file:///cache/rendered.jpeg")?.deleted).toBe(true);
    expect(files.get(uri)?.deleted).toBe(false);
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
