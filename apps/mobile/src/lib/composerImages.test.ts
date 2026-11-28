import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import type { ComposerAttachmentUploadState } from "./composerAttachmentUploadQueue";

const files = new Map<
  string,
  { base64: string; deleted: boolean; text?: string; mimeType?: string }
>();

const manipulator = vi.hoisted(() => {
  const state = {
    sourceSize: { width: 0, height: 0 },
    renderedBase64: "cmVuZGVyZWQ=",
  };

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

    get size(): number | null {
      const entry = files.get(this.uri);
      return entry && !entry.deleted
        ? Math.floor((entry.base64.replace(/=+$/, "").length * 3) / 4)
        : null;
    }

    async copy(destination: { readonly uri: string }): Promise<void> {
      const entry = files.get(this.uri);
      if (!entry) throw new Error("missing file");
      files.set(destination.uri, { ...entry });
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
  FileMode: { ReadOnly: "r", WriteOnly: "w" },
  Paths: { document: "file:///documents" },
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: string, data: string) => `sha256:${data}`,
}));

vi.mock("./uuid", () => ({
  uuidv4: () => "attachment-id",
}));

import { convertPastedImagesToAttachments, persistComposerAttachmentFile } from "./composerImages";

const STORED = "file:///documents/t3-composer-attachments/attachment-id";

function oversizedPng(): string {
  const png = Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.write("IHDR", 12);
  png.writeUInt32BE(2000, 16);
  png.writeUInt32BE(2000, 20);
  return png.toString("base64");
}

describe("native pasted image cleanup", () => {
  beforeEach(() => {
    files.clear();
    manipulator.state.sourceSize = { width: 0, height: 0 };
    manipulator.state.renderedBase64 = "cmVuZGVyZWQ=";
  });

  it.each([
    { format: "png", rejected: false },
    { format: "jpeg", rejected: false },
    { format: "png", rejected: true },
    { format: "jpeg", rejected: true },
  ])("cleans resized $format files when rejected: $rejected", async ({ format, rejected }) => {
    const owned = format === "png";
    const uri = owned ? "file:///cache/t3-composer-paste/source.png" : "file:///photos/source.jpeg";
    const header = Buffer.alloc(24);
    if (format === "png") {
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
      header.write("IHDR", 12);
      header.writeUInt32BE(3200, 16);
      header.writeUInt32BE(2400, 20);
    } else {
      Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 9, 96, 12, 128]).copy(header);
    }
    files.set(uri, { base64: header.toString("base64"), deleted: false });
    manipulator.state.sourceSize = { width: 3200, height: 2400 };
    if (rejected) {
      manipulator.state.renderedBase64 = Buffer.alloc(
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
      ).toString("base64");
    }

    const { attachments } = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(files.get(`file:///cache/rendered.${format}`)?.deleted).toBe(true);
    expect(files.get(uri)?.deleted).toBe(owned);
    if (rejected) {
      expect(attachments).toEqual([]);
    } else {
      const fileUri = `${STORED}-pasted-image.${format}`;
      expect(attachments).toEqual([
        expect.objectContaining({ fileUri, previewUri: fileUri, mimeType: `image/${format}` }),
      ]);
      expect(files.get(fileUri)?.base64).toBe(manipulator.state.renderedBase64);
    }
  });

  it("preserves the reported image type of extensionless Android content URIs", async () => {
    const uri = "content://media/external/images/media/42";
    files.set(uri, { base64: "aGVsbG8=", deleted: false, mimeType: "image/jpeg" });

    const { attachments } = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toEqual([
      expect.objectContaining({
        name: "pasted-image.jpeg",
        mimeType: "image/jpeg",
        fileUri: `${STORED}-pasted-image.jpeg`,
        previewUri: `${STORED}-pasted-image.jpeg`,
        contentDigest: "sha256:aGVsbG8=",
      }),
    ]);
    expect(attachments[0]).not.toHaveProperty("dataUrl");
    expect(files.get(`${STORED}-pasted-image.jpeg`)?.base64).toBe("aGVsbG8=");
    expect(files.get(uri)?.deleted).toBe(false);
  });

  it("renders unsupported images to JPEG and removes the cache file after attaching", async () => {
    const uri = "content://media/external/images/media/43";
    files.set(uri, { base64: "b3JpZ2luYWw=", deleted: false, mimeType: "image/heic" });
    manipulator.state.sourceSize = { width: 100, height: 100 };

    const { attachments } = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toEqual([
      expect.objectContaining({
        name: "pasted-image.jpeg",
        mimeType: "image/jpeg",
        fileUri: `${STORED}-pasted-image.jpeg`,
      }),
    ]);
    expect(files.get(`${STORED}-pasted-image.jpeg`)?.base64).toBe("cmVuZGVyZWQ=");
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

    const { attachments } = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toEqual([]);
    expect(files.get("file:///cache/rendered.jpeg")?.deleted).toBe(true);
    expect(files.get(uri)?.deleted).toBe(false);
  });

  it("stores owned pastes in an attachment file and deletes the source", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png";
    const gif =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/anim.gif";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });
    files.set(gif, { base64: "R0lGODlh", deleted: false });

    const { attachments } = await convertPastedImagesToAttachments({
      uris: [uri, gif],
      existingCount: 0,
    });

    expect(attachments).toEqual([
      expect.objectContaining({
        fileUri: `${STORED}-pasted-image.png`,
        previewUri: `${STORED}-pasted-image.png`,
      }),
      expect.objectContaining({ mimeType: "image/gif", fileUri: `${STORED}-pasted-image.gif` }),
    ]);
    expect(files.get(`${STORED}-pasted-image.png`)?.base64).toBe("aGVsbG8=");
    expect(files.get(`${STORED}-pasted-image.gif`)?.base64).toBe("R0lGODlh");
    expect(files.get(uri)?.deleted).toBe(true);
    expect(files.get(gif)?.deleted).toBe(true);
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

  it("re-renders an over-limit paste whose dimensions already fit, like the photo picker", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/photo.png";
    files.set(uri, { base64: oversizedPng(), deleted: false });
    manipulator.state.sourceSize = { width: 2000, height: 2000 };

    const { attachments } = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.sizeBytes).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    expect(files.get("file:///cache/rendered.jpeg")?.deleted).toBe(true);
  });

  it("keeps the readable images of a paste and still reports the one it dropped", async () => {
    const gone =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/gone.png";
    const kept =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/kept.png";
    files.set(kept, { base64: "aGVsbG8=", deleted: false });

    const result = await convertPastedImagesToAttachments({ uris: [gone, kept], existingCount: 0 });

    expect(result.attachments).toEqual([
      expect.objectContaining({ fileUri: `${STORED}-pasted-image.png` }),
    ]);
    expect(result.error).toBe("Could not read a pasted image.");
  });

  it("reports the size limit when even the JPEG re-render is too large", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/huge.png";
    files.set(uri, { base64: oversizedPng(), deleted: false });
    manipulator.state.sourceSize = { width: 2000, height: 2000 };
    manipulator.state.renderedBase64 = oversizedPng();

    const result = await convertPastedImagesToAttachments({ uris: [uri], existingCount: 0 });

    expect(result).toEqual({
      attachments: [],
      error: "A pasted image exceeds the 10 MB attachment limit.",
    });
    expect(files.get(uri)?.deleted).toBe(true);
  });
});

describe("persistComposerAttachmentFile", () => {
  beforeEach(() => {
    files.clear();
  });

  it("stores picked files under a name Android's java.net.URI accepts", async () => {
    const source = "file:///cache/DocumentPicker/Report [draft].pdf";
    files.set(source, { base64: "JVBERg==", deleted: false });

    const fileUri = await persistComposerAttachmentFile(source, "Report [draft].pdf");

    // expo-file-system encodes spaces and `%` but leaves `[`, `]`, `|` and `^` raw.
    expect(fileUri.split("/").at(-1)).toMatch(/^[\w\-.!~*'();:@&=+$, %]+\.pdf$/);
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
    expect(
      composerStripAttachments([doc, image, video] as never, () => ({
        status: "uploading",
        progress: 0.5,
      })).map((a) => a.id),
    ).toEqual(["img-1", "vid-1"]);
  });

  it("shows a document whose upload failed until its retry finishes", async () => {
    const { composerStripAttachments } = await import("./composerImages");
    const strip = (upload: ComposerAttachmentUploadState) =>
      composerStripAttachments([doc, image] as never, (a) =>
        a.id === "doc-1" ? upload : undefined,
      ).map((a) => a.id);
    expect(strip({ status: "failed", reason: "Service unavailable" })).toEqual(["doc-1", "img-1"]);
    expect(strip({ status: "uploading", progress: 0.4, retrying: true })).toEqual([
      "doc-1",
      "img-1",
    ]);
    expect(strip({ status: "ready" })).toEqual(["img-1"]);
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

    expect(composerStripAttachments([oversizedImage], () => undefined)).toEqual([oversizedImage]);
    expect(isComposerImageAttachment(oversizedImage)).toBe(false);
  });
});
