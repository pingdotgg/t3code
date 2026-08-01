import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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
  appendComposerImageAnnotationPrompts,
  convertPastedImagesToAttachments,
  isOwnedPastedImageUri,
  restoreComposerImageOriginal,
  toUploadChatImageAttachments,
} from "./composerImages";
import { DraftComposerImageAttachmentSchema } from "./composer-image-schema";

const annotation = (id: string, comment: string): PreviewAnnotationPayload => ({
  id,
  pageUrl: "",
  pageTitle: "Attached screenshot",
  comment,
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: null,
  createdAt: "2026-07-30T10:00:00.000Z",
});

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

  it("strips editable markup metadata from the startTurn wire shape", () => {
    expect(
      toUploadChatImageAttachments([
        {
          id: "client-draft-id",
          type: "image",
          name: "annotated.png",
          mimeType: "image/png",
          sizeBytes: 16,
          dataUrl: "data:image/png;base64,YW5ub3RhdGVk",
          previewUri: "data:image/png;base64,YW5ub3RhdGVk",
          markup: {
            annotation: annotation("annotation-1", "Move this button"),
            original: {
              name: "original.png",
              mimeType: "image/png",
              sizeBytes: 8,
              dataUrl: "data:image/png;base64,b3JpZ2luYWw=",
              previewUri: "file:///tmp/original.png",
            },
          },
        },
      ]),
    ).toEqual([
      {
        type: "image",
        name: "annotated.png",
        mimeType: "image/png",
        sizeBytes: 16,
        dataUrl: "data:image/png;base64,YW5ub3RhdGVk",
      },
    ]);
  });
});

describe("composer image markup", () => {
  const markedAttachment = {
    id: "attachment-1",
    type: "image" as const,
    name: "annotated.png",
    mimeType: "image/png",
    sizeBytes: 16,
    dataUrl: "data:image/png;base64,YW5ub3RhdGVk",
    previewUri: "data:image/png;base64,YW5ub3RhdGVk",
    markup: {
      annotation: annotation("annotation-1", "Move this button"),
      original: {
        name: "original.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 8,
        dataUrl: "data:image/jpeg;base64,b3JpZ2luYWw=",
        previewUri: "file:///tmp/original.jpg",
      },
    },
  };

  it("persists annotation metadata and its restorable original image", () => {
    const decode = Schema.decodeUnknownSync(DraftComposerImageAttachmentSchema);
    expect(decode(markedAttachment)).toEqual(markedAttachment);
  });

  it("omits duplicate data-backed preview URIs when persisted and restores them on decode", () => {
    const encode = Schema.encodeUnknownSync(DraftComposerImageAttachmentSchema);
    const decode = Schema.decodeUnknownSync(DraftComposerImageAttachmentSchema);
    const dataBackedOriginal = {
      ...markedAttachment,
      markup: {
        ...markedAttachment.markup,
        original: {
          ...markedAttachment.markup.original,
          previewUri: markedAttachment.markup.original.dataUrl,
        },
      },
    };

    const encoded = encode(dataBackedOriginal);
    const persisted = JSON.parse(JSON.stringify(encoded)) as unknown;
    expect(persisted).not.toHaveProperty("previewUri");
    expect(persisted).not.toHaveProperty("markup.original.previewUri");
    expect(decode(persisted)).toEqual(dataBackedOriginal);
  });

  it("appends attachment annotations in attachment order", () => {
    const text = appendComposerImageAnnotationPrompts("Fix this screen", [
      markedAttachment,
      {
        ...markedAttachment,
        id: "attachment-2",
        markup: {
          ...markedAttachment.markup,
          annotation: annotation("annotation-2", "Reduce this gap"),
        },
      },
    ]);

    expect(text).toContain("Fix this screen");
    expect(text).not.toContain("<preview_annotation>\n<preview_annotation>");
    expect(text.indexOf("Id: annotation-1")).toBeLessThan(text.indexOf("Id: annotation-2"));
    expect(text.match(/<preview_annotation>/g)).toHaveLength(2);
  });

  it("restores the original image and removes markup metadata", () => {
    expect(restoreComposerImageOriginal(markedAttachment)).toEqual({
      id: "attachment-1",
      type: "image",
      ...markedAttachment.markup.original,
    });
  });

  it("returns unmarked images unchanged", () => {
    const plain = restoreComposerImageOriginal({
      id: "attachment-plain",
      type: "image",
      name: "plain.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,YWJj",
      previewUri: "file:///tmp/plain.png",
    });
    expect(restoreComposerImageOriginal(plain)).toBe(plain);
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
});
