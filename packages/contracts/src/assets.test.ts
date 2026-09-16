import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AttachmentCreateUploadUrlInput, AssetResource } from "./assets.ts";
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

describe("source-control asset validation", () => {
  const reference = {
    _tag: "gitlab",
    origin: "https://git.example:3443",
    project: "123",
    secret: "e347d7ff85358d19b72222f1174b9a4b",
    fileName: "image one.svg",
  };
  const isAssetResource = Schema.is(AssetResource);
  const accepts = (input: unknown) =>
    isAssetResource({ _tag: "source-control-media", reference: input });
  it("accepts exact GitLab uploads and GitHub attachments", () => {
    expect(accepts(reference)).toBe(true);
    expect(accepts({ ...reference, project: "team/subgroup/repo" })).toBe(true);
    expect(
      accepts({ _tag: "github", url: "https://github.com/user-attachments/assets/1234-abcd" }),
    ).toBe(true);
  });
  it.each([
    { origin: "https://user:password@git.example" },
    { origin: "https://git.example/path" },
    { origin: "javascript:foo" },
    { project: "../repo" },
    { project: "team/../repo" },
    { fileName: ".." },
    { fileName: "a/b" },
    { fileName: "a\\b" },
    { secret: "../../secret" },
  ])("rejects locations outside an exact upload: %j", (invalid) => {
    expect(accepts({ ...reference, ...invalid })).toBe(false);
  });
  it.each([
    "http://github.com/user-attachments/assets/1234",
    "https://github.com.evil.test/user-attachments/assets/1234",
    "https://github.com/user-attachments/assets/1234?redirect=evil",
  ])("rejects unsupported GitHub URLs: %s", (url) => {
    expect(accepts({ _tag: "github", url })).toBe(false);
  });
});
