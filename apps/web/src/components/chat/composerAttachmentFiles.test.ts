import {
  EnvironmentId,
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isFileAttachment, isImageAttachment } from "../../types";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import {
  attachmentsToReleaseOnUploadCapabilityLoss,
  classifyComposerAttachmentFile,
  composerFileAttachmentMimeType,
  fileAttachmentCapabilityBlockReason,
  fileAttachmentStagingLimit,
  normalizeComposerImageFileMimeType,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";

describe("composer attachment files", () => {
  it("attaches SVG as a file and rejects other unsupported images", () => {
    expect(classifyComposerAttachmentFile({ name: "diagram.svg", type: "image/svg+xml" })).toBe(
      "file",
    );
    expect(classifyComposerAttachmentFile({ name: "diagram.SVG", type: "" })).toBe("file");
    expect(
      classifyComposerAttachmentFile({ name: "diagram.svg", type: "application/octet-stream" }),
    ).toBe("file");
    expect(classifyComposerAttachmentFile({ name: "photo.tiff", type: "image/tiff" })).toBe(
      "unsupported-image",
    );
    expect(classifyComposerAttachmentFile({ name: "report.pdf", type: "application/pdf" })).toBe(
      "file",
    );
  });

  it("keeps DNG originals on the file path without changing their bytes", async () => {
    const bytes = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0, 0xfe, 0xff, 0x00, 0x80]);
    const files = [
      new File([bytes], "photo.DNG", { type: "image/tiff" }),
      new File([bytes], "photo.dng", { type: "image/png" }),
      new File([bytes], "photo.dng", { type: "image/jpeg" }),
      new File([bytes], "clipboard", { type: "image/dng" }),
      new File([bytes], "clipboard", { type: "image/x-dng" }),
      new File([bytes], "clipboard", { type: "image/x-adobe-dng" }),
    ];

    const attachments = await Promise.all(
      files.map(async (file) => ({
        kind: classifyComposerAttachmentFile(file),
        bytes: new Uint8Array(await normalizeComposerImageFileMimeType(file).arrayBuffer()),
      })),
    );

    expect(attachments).toEqual(files.map(() => ({ kind: "file", bytes })));
  });

  it("keeps misleading DNG MIME labels out of downstream image detection and budgets", () => {
    for (const type of ["image/png", "image/jpeg", "image/tiff", "image/dng", ""]) {
      const attachment = {
        type: "file" as const,
        id: "raw",
        name: "photo.DNG",
        mimeType: composerFileAttachmentMimeType({ name: "photo.DNG", type }),
        sizeBytes: 81 * 1024 * 1024,
      };

      expect(isImageAttachment(attachment)).toBe(false);
      expect(isFileAttachment(attachment)).toBe(true);
      expect(getProviderAttachmentLimitError([attachment])).toBeUndefined();
    }
  });

  it("claims a captioned DNG paste even when its MIME is generic", () => {
    const file = new File(["raw"], "photo.dng", { type: "application/octet-stream" });

    expect(
      shouldHandleComposerAttachmentPaste({ files: [file], plainText: "Inspect this original" }),
    ).toBe(true);
  });

  it("keeps ordinary images on their existing paths", () => {
    const files = [
      { name: "photo.jpg", type: "image/jpeg" },
      { name: "export.dng.png", type: "image/png" },
      { name: "photo.webp", type: "image/webp" },
      { name: "photo.gif", type: "image/gif" },
      { name: "photo.heic", type: "" },
      { name: "scan.tif", type: "image/tiff" },
      { name: "photo.cr2", type: "image/x-canon-cr2" },
    ];

    expect(files.map(classifyComposerAttachmentFile)).toEqual([
      "image",
      "image",
      "image",
      "image",
      "image",
      "unsupported-image",
      "unsupported-image",
    ]);
  });

  it("preserves text paste when an application adds a synthetic generic file", () => {
    const file = new File(["clipboard"], "clipboard.rtf", { type: "application/rtf" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [file],
        plainText: "Copied text",
      }),
    ).toBe(false);
  });

  it("claims SVG and unsupported image pastes even when text is present", () => {
    const images = [
      new File(["svg"], "diagram.svg", { type: "image/svg+xml" }),
      new File(["tiff"], "photo.tiff", { type: "image/tiff" }),
    ];

    for (const image of images) {
      expect(
        shouldHandleComposerAttachmentPaste({
          files: [image],
          plainText: "Image caption",
        }),
      ).toBe(true);
    }
  });

  it("uses the hard local limit while server config is unknown", () => {
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: false,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: null,
      }),
    ).toBe(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [{ name: "pending.zip", sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES }],
        attachmentUploadsCapabilityKnown: false,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: null,
      }),
    ).toBe("Waiting for the server before file attachments can send");
  });

  it("keeps draft-persisted file uploads when the upload capability flips off", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const image: ComposerImageAttachment = {
      type: "image",
      id: "image-1",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      previewUrl: "blob:photo",
      file: new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" }),
    };
    const uploadingFile: ComposerFileAttachment = {
      type: "file",
      id: "file-uploading",
      name: "fresh.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      file: new File([new Uint8Array([1, 2, 3])], "fresh.pdf", { type: "application/pdf" }),
    };
    const hydratedFile: ComposerFileAttachment = {
      type: "file",
      id: "file-hydrated",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      file: null,
      uploadedAttachmentId: "pending-report-pdf",
      uploadEnvironmentId: environmentId,
    };
    const uploadedLocalFile: ComposerFileAttachment = {
      ...uploadingFile,
      id: "file-uploaded-local",
      uploadedAttachmentId: "pending-fresh-pdf",
      uploadEnvironmentId: environmentId,
    };

    const released = attachmentsToReleaseOnUploadCapabilityLoss([
      image,
      uploadingFile,
      hydratedFile,
      uploadedLocalFile,
    ]);

    expect(released.map((attachment) => attachment.id)).toEqual(["image-1", "file-uploading"]);
  });
});
