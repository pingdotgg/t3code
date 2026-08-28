import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";

const files = new Map<string, { base64: string; deleted: boolean }>();
const launchImageLibraryAsync = vi.fn();
const saveAsync = vi.fn();
const renderedRelease = vi.fn();
const contextRelease = vi.fn();
const renderAsync = vi.fn(async () => ({ release: renderedRelease, saveAsync }));
const manipulate = vi.fn(() => ({ release: contextRelease, renderAsync }));

vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync,
}));

vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate },
  SaveFormat: { JPEG: "jpeg" },
}));

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

import {
  convertPastedImagesToAttachments,
  isOwnedPastedImageUri,
  pickComposerImages,
  toUploadChatImageAttachments,
} from "./composerImages";

describe("toUploadChatImageAttachments", () => {
  it("strips client draft id and previewUri for the startTurn wire shape", () => {
    expect(
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
    ).toEqual([
      {
        type: "image",
        name: "pasted-image.png",
        mimeType: "image/png",
        sizeBytes: 12,
        dataUrl: "data:image/png;base64,AA==",
      },
    ]);
  });
});

describe("native pasted image cleanup", () => {
  beforeEach(() => {
    files.clear();
    launchImageLibraryAsync.mockReset();
    saveAsync.mockReset();
    renderedRelease.mockClear();
    contextRelease.mockClear();
    renderAsync.mockClear();
    manipulate.mockClear();
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

  it("reads a selected image URI when Android omits picker base64", async () => {
    const uri = "file:///data/user/0/app/cache/selected.png";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ fileName: "selected.png", fileSize: 5, mimeType: "image/png", uri }],
    });

    await expect(pickComposerImages({ existingCount: 0 })).resolves.toEqual({
      error: null,
      images: [
        expect.objectContaining({
          dataUrl: "data:image/png;base64,aGVsbG8=",
          previewUri: uri,
        }),
      ],
    });
  });

  it("converts selected HEIF images to provider-supported JPEG data", async () => {
    const uri = "file:///data/user/0/app/cache/selected.heif";
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ fileName: "selected.heif", fileSize: 2, mimeType: "image/heif", uri }],
    });
    saveAsync.mockResolvedValue({ base64: "aGVsbG8=", uri: `${uri}.jpg` });

    await expect(pickComposerImages({ existingCount: 0 })).resolves.toEqual({
      error: null,
      images: [
        expect.objectContaining({
          dataUrl: "data:image/jpeg;base64,aGVsbG8=",
          mimeType: "image/jpeg",
          name: "selected.jpg",
          previewUri: `${uri}.jpg`,
          sizeBytes: 5,
        }),
      ],
    });
    expect(manipulate).toHaveBeenCalledWith(uri);
    expect(saveAsync).toHaveBeenCalledWith({ base64: true, compress: 0.9, format: "jpeg" });
    expect(renderedRelease).toHaveBeenCalledOnce();
    expect(contextRelease).toHaveBeenCalledOnce();
  });

  it("reports failed HEIF conversion and releases native image resources", async () => {
    const uri = "file:///data/user/0/app/cache/selected.heic";
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ fileName: "selected.heic", mimeType: "image/heic", uri }],
    });
    saveAsync.mockRejectedValue(new Error("conversion failed"));

    await expect(pickComposerImages({ existingCount: 0 })).resolves.toEqual({
      error: "Failed to convert 'selected.heic' to JPEG.",
      images: [],
    });
    expect(renderedRelease).toHaveBeenCalledOnce();
    expect(contextRelease).toHaveBeenCalledOnce();
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
