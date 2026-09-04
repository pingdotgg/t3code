import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AttachmentCreateUploadUrlInput, isGitHubUserAttachmentUrl } from "./assets.ts";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "./orchestration.ts";

const isUploadInput = Schema.is(AttachmentCreateUploadUrlInput);

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

describe("isGitHubUserAttachmentUrl", () => {
  it("accepts exactly GitHub user-attachment asset URLs", () => {
    expect(
      isGitHubUserAttachmentUrl(
        "https://github.com/user-attachments/assets/4dcab2ba-0674-4d3b-a3a7-3546601b1550",
      ),
    ).toBe(true);
    for (const url of [
      "https://github.com.evil.example.com/user-attachments/assets/a",
      "https://github.com/user-attachments/assets/a/../../login",
      "https://github.com/user-attachments/assets/a?next=b",
      "https://github.com/owner/repo/blob/main/a.png",
    ]) {
      expect(isGitHubUserAttachmentUrl(url)).toBe(false);
    }
  });
});
