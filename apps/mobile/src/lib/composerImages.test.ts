import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

import {
  convertPastedImagesToAttachments,
  droppedAttachmentsWarning,
  isOwnedPastedImageUri,
} from "./composerImages";

describe("droppedAttachmentsWarning", () => {
  it("stays quiet when a message carries no legacy images", () => {
    expect(droppedAttachmentsWarning(0)).toBeNull();
  });

  it("names how many legacy images were left behind", () => {
    expect(droppedAttachmentsWarning(1)).toBe(
      "1 image was not sent. Image attach needs an app update.",
    );
    expect(droppedAttachmentsWarning(3)).toBe(
      "3 images were not sent. Image attach needs an app update.",
    );
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

  // Image attach is off until mobile implements upload-on-attach, so pasted
  // images produce no attachment. Temp-file cleanup must still happen.
  it("attaches nothing and deletes owned temp files, leaving user files alone", async () => {
    const owned =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png";
    const userOwned = "file:///private/var/mobile/photos/library.png";
    files.set(owned, { base64: "aGVsbG8=", deleted: false });
    files.set(userOwned, { base64: "aGVsbG8=", deleted: false });

    const pasted = await convertPastedImagesToAttachments({
      uris: [owned, userOwned],
      existingCount: 0,
    });

    expect(pasted.images).toEqual([]);
    // The drop is surfaced to callers, not just logged.
    expect(pasted.error).toContain("app update");
    expect(files.get(owned)?.deleted).toBe(true);
    expect(files.get(userOwned)?.deleted).toBe(false);
  });
});
