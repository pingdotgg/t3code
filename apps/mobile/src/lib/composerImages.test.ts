import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

const files = new Map<
  string,
  {
    base64: string;
    deleted: boolean;
    text?: string;
    readChunkBytes?: number;
    openError?: boolean;
    readError?: boolean;
  }
>();
const fileReads = {
  base64: vi.fn(),
  readBytes: vi.fn(),
  close: vi.fn(),
};

const picker = vi.hoisted(() => ({ launchImageLibraryAsync: vi.fn() }));
vi.mock("expo-image-picker", () => picker);

const manipulator = vi.hoisted(() => {
  const state = {
    sourceSize: { width: 0, height: 0 },
    failure: null as "render" | "resize" | "save" | null,
  };
  const release = vi.fn();
  const saveAsync = vi.fn(async (options: { format: string }) => {
    if (state.failure === "save") throw new Error("could not save image");
    return { uri: `file:///cache/rendered.${options.format}`, base64: "cmVuZGVyZWQ=" };
  });
  const manipulate = vi.fn((source: string | { width: number; height: number }) => {
    let size = typeof source === "string" ? state.sourceSize : source;
    const context = {
      resize: vi.fn((next: { width: number; height: number }) => {
        size = next;
        return context;
      }),
      renderAsync: vi.fn(async () => {
        if (state.failure === (typeof source === "string" ? "render" : "resize")) {
          throw new Error("could not render image");
        }
        return { ...size, release, saveAsync };
      }),
    };
    return context;
  });
  return { state, manipulate, release, saveAsync };
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

    get size(): number | null {
      const entry = files.get(this.uri);
      return entry ? Buffer.from(entry.base64, "base64").byteLength : null;
    }

    open() {
      const uri = this.uri;
      if (files.get(uri)?.openError) throw new Error("unsupported file handle");
      let offset = 0;
      return {
        readBytes: async (count: number) => {
          const bytes = Buffer.from(files.get(uri)?.base64 ?? "", "base64");
          if (files.get(uri)?.readError) throw new Error("could not read header");
          const chunk = bytes.subarray(
            offset,
            offset + Math.min(count, files.get(uri)?.readChunkBytes ?? count),
          );
          offset += chunk.byteLength;
          fileReads.readBytes(uri, count, chunk.byteLength);
          return chunk;
        },
        close: () => fileReads.close(uri),
      };
    }

    async base64(): Promise<string> {
      fileReads.base64(this.uri);
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
  FileMode: { ReadOnly: "r" },
  Paths: { document: "file:///documents" },
}));

vi.mock("./uuid", () => ({
  uuidv4: () => "attachment-id",
}));

import { convertPastedImagesToAttachments, pickComposerMedia } from "./composerImages";
import { IMAGE_DIMENSIONS_HEADER_BYTES } from "@t3tools/shared/imageDimensions";
import { fitComposerImage, fitComposerImageFile } from "./composerImageFit";

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

describe("file image header fitting", () => {
  function imageBytes(format = "png", width = 3024, height = 1964, length = 1024 * 1024) {
    const bytes = Buffer.alloc(length);
    if (format === "png") {
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      bytes.writeUInt32BE(13, 8);
      bytes.write("IHDR", 12);
      bytes.writeUInt32BE(width, 16);
      bytes.writeUInt32BE(height, 20);
    } else {
      bytes.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8]);
      bytes.writeUInt16BE(height, 7);
      bytes.writeUInt16BE(width, 9);
    }
    return bytes.toString("base64");
  }

  async function importImage(entryPoint: string, uri: string, mimeType = "image/png") {
    if (entryPoint === "native paste") {
      return convertPastedImagesToAttachments({ uris: [uri], existingCount: 0 });
    }
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri, type: "image", mimeType, fileName: "photo" }],
    });
    const result = await pickComposerMedia({ existingCount: 0 });
    expect(result.error).toBeNull();
    return result.attachments;
  }

  beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
    manipulator.state.sourceSize = { width: 3024, height: 1964 };
    manipulator.state.failure = null;
  });

  it.each([
    ["picker", "png"],
    ["native paste", "png"],
    ["picker", "jpeg"],
    ["native paste", "jpeg"],
  ])(
    "%s resizes from the URI without reading full original base64 (%s)",
    async (entryPoint, format) => {
      const uri = `file:///photos/photo.${format}`;
      const mimeType = `image/${format}`;
      const base64 = imageBytes(format);
      files.set(uri, { base64, deleted: false });

      const attachments = await importImage(entryPoint, uri, mimeType);

      expect(attachments).toEqual([
        expect.objectContaining({
          mimeType,
          sizeBytes: 8,
          dataUrl: `data:${mimeType};base64,cmVuZGVyZWQ=`,
          previewUri: `file:///cache/rendered.${format}`,
        }),
      ]);
      expect(fileReads.base64).not.toHaveBeenCalled();
      expect(fileReads.readBytes).toHaveBeenCalledExactlyOnceWith(
        uri,
        IMAGE_DIMENSIONS_HEADER_BYTES,
        IMAGE_DIMENSIONS_HEADER_BYTES,
      );
      expect(fileReads.close).toHaveBeenCalledExactlyOnceWith(uri);
      expect(manipulator.manipulate).toHaveBeenCalledWith(uri);
      expect(
        manipulator.manipulate.mock.results.at(-1)?.value.resize,
      ).toHaveBeenCalledExactlyOnceWith({
        width: 2000,
        height: 1299,
      });
      expect(manipulator.saveAsync).toHaveBeenCalledExactlyOnceWith({
        format,
        compress: 0.85,
        base64: true,
      });
      expect(manipulator.release).toHaveBeenCalledTimes(2);
      expect(await fitComposerImage({ uri, mimeType, base64 })).toEqual({
        base64: "cmVuZGVyZWQ=",
        uri: `file:///cache/rendered.${format}`,
      });
    },
  );

  it("fills partial header reads without exceeding the bound and closes before rendering", async () => {
    const uri = "file:///photos/partial.png";
    files.set(uri, { base64: imageBytes(), deleted: false, readChunkBytes: 64 * 1024 });

    await importImage("native paste", uri);

    expect(fileReads.readBytes.mock.calls.map((call) => call[2])).toEqual(Array(4).fill(64 * 1024));
    expect(fileReads.readBytes.mock.calls.map((call) => call[1])).toEqual([
      256 * 1024,
      192 * 1024,
      128 * 1024,
      64 * 1024,
    ]);
    expect(fileReads.close).toHaveBeenCalledExactlyOnceWith(uri);
    expect(fileReads.close.mock.invocationCallOrder[0]).toBeLessThan(
      manipulator.manipulate.mock.invocationCallOrder[0]!,
    );
    expect(fileReads.base64).not.toHaveBeenCalled();
  });

  it.each(["picker", "native paste"])(
    "%s keeps small and corrupt originals byte-identical",
    async (entryPoint) => {
      for (const base64 of [
        imageBytes("png", 2000, 1200, 24),
        "aGVsbG8=",
        imageBytes("png", 0, 0, 24),
      ]) {
        const uri = "file:///photos/original.png";
        files.set(uri, { base64, deleted: false });
        const readsBefore = fileReads.base64.mock.calls.length;
        const closesBefore = fileReads.close.mock.calls.length;

        const attachments = await importImage(entryPoint, uri);

        expect(attachments).toEqual([
          expect.objectContaining({
            dataUrl: `data:image/png;base64,${base64}`,
            previewUri: uri,
          }),
        ]);
        expect(fileReads.base64).toHaveBeenCalledTimes(readsBefore + 1);
        expect(fileReads.close).toHaveBeenCalledTimes(closesBefore + 1);
      }
      expect(manipulator.manipulate).not.toHaveBeenCalled();
    },
  );

  it.each(["openError", "readError"] as const)(
    "falls back for content URI %s and preserves fitting",
    async (failure) => {
      const uri = "content://photos/oversized.png";
      files.set(uri, { base64: imageBytes(), deleted: false, [failure]: true });

      const attachments = await importImage("native paste", uri);

      expect(attachments).toEqual([
        expect.objectContaining({
          dataUrl: "data:image/png;base64,cmVuZGVyZWQ=",
        }),
      ]);
      expect(fileReads.base64).toHaveBeenCalledExactlyOnceWith(uri);
      expect(fileReads.close).toHaveBeenCalledTimes(failure === "readError" ? 1 : 0);
      expect(manipulator.saveAsync).toHaveBeenCalledExactlyOnceWith({
        format: "png",
        compress: 0.85,
        base64: true,
      });
    },
  );

  it.each(["render", "resize", "save"] as const)(
    "retains original bytes after native %s failure and releases images",
    async (failure) => {
      using _warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const uri = "file:///photos/failure.png";
      const base64 = imageBytes();
      files.set(uri, { base64, deleted: false });
      manipulator.state.failure = failure;

      const attachments = await importImage("native paste", uri);

      expect(attachments).toEqual([
        expect.objectContaining({
          dataUrl: `data:image/png;base64,${base64}`,
          previewUri: uri,
        }),
      ]);
      expect(fileReads.base64).toHaveBeenCalledExactlyOnceWith(uri);
      expect(fileReads.close).toHaveBeenCalledExactlyOnceWith(uri);
      expect(manipulator.manipulate).toHaveBeenCalledTimes(failure === "render" ? 1 : 2);
      expect(manipulator.release).toHaveBeenCalledTimes(
        failure === "render" ? 0 : failure === "resize" ? 1 : 2,
      );
    },
  );

  it.each(["gif", "webp"])(
    "keeps animated %s bytes without reading a header or rendering",
    async (format) => {
      const uri = `file:///photos/animated.${format}`;
      const base64 = "YW5pbWF0aW9u";
      files.set(uri, { base64, deleted: false });

      for (const entryPoint of ["picker", "native paste"]) {
        const attachments = await importImage(entryPoint, uri, `image/${format}`);
        expect(attachments).toEqual([
          expect.objectContaining({ dataUrl: `data:image/${format};base64,${base64}` }),
        ]);
      }

      expect(fileReads.base64).toHaveBeenCalledTimes(2);
      expect(fileReads.readBytes).not.toHaveBeenCalled();
      expect(manipulator.manipulate).not.toHaveBeenCalled();
    },
  );

  it("leaves unsupported formats to the existing picker conversion and file pass-through", async () => {
    const uri = "file:///photos/photo.heic";
    const base64 = "aGVsbG8=";
    files.set(uri, { base64, deleted: false });

    expect(await fitComposerImageFile({ uri, mimeType: "image/heic" })).toEqual({
      base64,
      uri,
      fitted: false,
    });
    expect(fileReads.readBytes).not.toHaveBeenCalled();
    expect(manipulator.manipulate).not.toHaveBeenCalled();
    expect(await importImage("picker", uri, "image/heic")).toEqual([
      expect.objectContaining({
        mimeType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,cmVuZGVyZWQ=",
      }),
    ]);
    expect(fileReads.base64).toHaveBeenCalledExactlyOnceWith(uri);
    expect(fileReads.readBytes).not.toHaveBeenCalled();
  });

  it("retains the owned paste cleanup and data-backed preview after fitting", async () => {
    const uri = "file:///tmp/t3-composer-paste/id.png";
    files.set(uri, { base64: imageBytes(), deleted: false });

    expect(await importImage("native paste", uri)).toEqual([
      expect.objectContaining({
        dataUrl: "data:image/png;base64,cmVuZGVyZWQ=",
        previewUri: "data:image/png;base64,cmVuZGVyZWQ=",
      }),
    ]);
    expect(files.get(uri)?.deleted).toBe(true);
    expect(fileReads.base64).not.toHaveBeenCalled();
    expect(fileReads.close).toHaveBeenCalledExactlyOnceWith(uri);
  });
});
