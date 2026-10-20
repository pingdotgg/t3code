import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AssetAccessError,
  AssetWorkspaceAssetNotFoundError,
  AttachmentCreateUploadUrlInput,
} from "./assets.ts";
import { ThreadId } from "./baseSchemas.ts";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "./chatAttachment.ts";

const isUploadInput = Schema.is(AttachmentCreateUploadUrlInput);
const encodeAccessError = Schema.encodeUnknownSync(AssetAccessError);
const decodeAccessError = Schema.decodeUnknownSync(AssetAccessError);

const uploadInput = {
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 3,
} as const;

describe("AttachmentCreateUploadUrlInput", () => {
  it("accepts supported image attachments", () => {
    expect(isUploadInput(uploadInput)).toBe(true);
  });

  it("rejects image types that providers do not support", () => {
    expect(isUploadInput({ ...uploadInput, mimeType: "image/svg+xml" })).toBe(false);
  });

  it("accepts generic files without treating them as provider images", () => {
    expect(
      isUploadInput({
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
      }),
    ).toBe(true);
    expect(
      isUploadInput({
        type: "file",
        name: "diagram.svg",
        mimeType: "image/svg+xml",
        sizeBytes: 3,
      }),
    ).toBe(true);
  });

  it("rejects empty and oversized uploads", () => {
    expect(isUploadInput({ ...uploadInput, sizeBytes: 0 })).toBe(false);
    expect(
      isUploadInput({ ...uploadInput, sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1 }),
    ).toBe(false);
    expect(
      isUploadInput({
        type: "file",
        name: "archive.zip",
        mimeType: "application/zip",
        sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
      }),
    ).toBe(false);
  });
});

describe("AssetWorkspaceAssetNotFoundError", () => {
  const resource = {
    _tag: "media-file" as const,
    threadId: ThreadId.make("thread-1"),
    path: "~/Downloads/clip.mp4",
  };

  it("carries the checked path across the wire", () => {
    const encoded = encodeAccessError(
      new AssetWorkspaceAssetNotFoundError({
        resource,
        checkedPath: "/Users/graham/Downloads/clip.mp4",
      }),
    );
    const error = decodeAccessError(JSON.parse(JSON.stringify(encoded)));

    expect(error).toBeInstanceOf(AssetWorkspaceAssetNotFoundError);
    expect(error).toMatchObject({ checkedPath: "/Users/graham/Downloads/clip.mp4" });
  });

  it("decodes an error from a server that sends no checked path", () => {
    const error = decodeAccessError({ _tag: "AssetWorkspaceAssetNotFoundError", resource });

    expect(error).toBeInstanceOf(AssetWorkspaceAssetNotFoundError);
    expect(error).not.toHaveProperty("checkedPath");
  });
});
