import {
  EnvironmentId,
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@t3tools/contracts";
import { imageMimeType } from "@t3tools/shared/image";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { isFileAttachment, isImageAttachment, isVideoAttachment, videoMimeType } from "../../types";
import {
  attachmentsToReleaseOnUploadCapabilityLoss,
  classifyComposerAttachmentFile,
  composerFileAttachmentMimeType,
  composerOtherFilesForPresentation,
  DNG_FILE_MIME_TYPE,
  fileAttachmentCapabilityBlockReason,
  fileAttachmentStagingLimit,
  inferImageMimeTypeFromName,
  isPreviewableComposerVideo,
  normalizeComposerImageFileMimeType,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";

describe("composer attachment files", () => {
  it("keeps inline non-media files out of the legacy attachment row", () => {
    const environmentId = EnvironmentId.make("env-1");
    const files = [
      {
        type: "file" as const,
        id: "inline-file",
        name: "inline.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        file: new File(["inline"], "inline.txt", { type: "text/plain" }),
      },
      {
        type: "file" as const,
        id: "legacy-file",
        name: "legacy.zip",
        mimeType: "application/zip",
        sizeBytes: 24,
        file: new File(["legacy"], "legacy.zip", { type: "application/zip" }),
      },
    ];

    expect(
      composerOtherFilesForPresentation(files, environmentId, new Set(["inline-file"])),
    ).toEqual([files[1]]);
  });

  describe("DNG originals (#16023)", () => {
    const dngBytes = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0, 0xfe, 0xff, 0x00, 0x80]);
    // What pickers, drags and pastes actually report for a .dng across browsers and platforms.
    const browserLabels = [
      "image/tiff",
      "image/x-adobe-dng",
      "image/dng",
      "image/x-dng",
      "",
      "application/octet-stream",
      "image/png",
      "image/jpeg",
      "image/heic",
    ];

    it.each(browserLabels)("routes .dng labelled %j as a generic file", (type) => {
      for (const name of ["IMG_3921_7-50-59.DNG", "original.dng"]) {
        expect(classifyComposerAttachmentFile({ name, type })).toBe("file");
      }
    });

    it("recognizes DNG MIME types without a DNG extension", () => {
      for (const type of ["image/dng", "image/x-dng", "IMAGE/X-DNG", "image/x-adobe-dng"]) {
        expect(classifyComposerAttachmentFile({ name: "clipboard", type })).toBe("file");
        expect(classifyComposerAttachmentFile({ name: "photo.jpg", type })).toBe("file");
      }
    });

    it("claims captioned DNG pastes instead of falling through to text", () => {
      const dng = new File([dngBytes], "photo.DNG", { type: "image/tiff" });
      const document = new File(["doc"], "notes.rtf", { type: "application/rtf" });
      expect(shouldHandleComposerAttachmentPaste({ files: [dng], plainText: "Caption" })).toBe(true);
      expect(
        shouldHandleComposerAttachmentPaste({ files: [document, dng], plainText: "Caption" }),
      ).toBe(true);
      expect(shouldHandleComposerAttachmentPaste({ files: [dng], plainText: "" })).toBe(true);
      // Ordinary document pastes with clipboard text still fall through to the text paste.
      expect(shouldHandleComposerAttachmentPaste({ files: [document], plainText: "Caption" })).toBe(
        false,
      );
    });

    it("keeps the original bytes and never routes a DNG through image normalization", async () => {
      for (const type of browserLabels) {
        const file = new File([dngBytes], "original.dng", { type, lastModified: 42 });
        expect(normalizeComposerImageFileMimeType(file)).toBe(file);
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(dngBytes);
      }
    });

    it.each(browserLabels)(
      "records a DNG labelled %j with a MIME downstream readers treat as a file",
      (type) => {
        const file = new File([dngBytes], "IMG.DNG", { type });
        const mimeType = composerFileAttachmentMimeType(file);
        expect(mimeType).toBe(DNG_FILE_MIME_TYPE);
        const attachment = {
          type: "file" as const,
          id: "dng",
          name: file.name,
          mimeType,
          sizeBytes: 81 * 1024 * 1024,
        };
        expect(imageMimeType(attachment)).toBeNull();
        expect(isImageAttachment(attachment)).toBe(false);
        expect(isFileAttachment(attachment)).toBe(true);
        // The provider image budget must not count a raw file it will never send as a picture.
        expect(getProviderAttachmentLimitError([attachment])).toBeUndefined();
      },
    );

    it("keeps original bytes and metadata when staging rewrites a misleading DNG MIME", async () => {
      // Mirrors ChatComposer's generic-file staging: the File is re-wrapped only to carry the
      // derived MIME, which must not touch the payload.
      for (const type of ["image/png", "image/jpeg", "image/tiff", "", "image/dng"]) {
        for (const name of ["IMG_0001.DNG", "clipboard"]) {
          if (name === "clipboard" && type !== "image/dng") continue;
          const file = new File([dngBytes], name, { type, lastModified: 4242 });
          const mimeType = composerFileAttachmentMimeType(file);
          const staged =
            file.type === mimeType
              ? file
              : new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
          expect(staged.type).toBe(DNG_FILE_MIME_TYPE);
          expect(staged.name).toBe(name);
          expect(staged.lastModified).toBe(4242);
          expect(staged.size).toBe(dngBytes.byteLength);
          expect(new Uint8Array(await staged.arrayBuffer())).toEqual(dngBytes);
        }
      }
    });

    it("leaves other generic files' wire MIME unchanged", () => {
      expect(
        composerFileAttachmentMimeType(new File(["pdf"], "report.pdf", { type: "application/pdf" })),
      ).toBe("application/pdf");
      expect(composerFileAttachmentMimeType(new File(["zip"], "archive.zip", { type: "" }))).toBe(
        "application/octet-stream",
      );
      expect(
        composerFileAttachmentMimeType(
          new File(["mov"], "clip.mov", { type: "application/octet-stream" }),
        ),
      ).toBe("video/quicktime");
    });

    it("does not broaden the exception to other RAW formats or DNG-looking names", () => {
      expect(classifyComposerAttachmentFile({ name: "photo.cr2", type: "image/x-canon-cr2" })).toBe(
        "unsupported-image",
      );
      expect(classifyComposerAttachmentFile({ name: "photo.nef", type: "image/x-nikon-nef" })).toBe(
        "unsupported-image",
      );
      expect(classifyComposerAttachmentFile({ name: "export.dng.png", type: "image/png" })).toBe(
        "image",
      );
      expect(classifyComposerAttachmentFile({ name: "scan.dng.tif", type: "image/tiff" })).toBe(
        "unsupported-image",
      );
    });
  });

  it("keeps supported images and HEIC photos on the image path", () => {
    expect(classifyComposerAttachmentFile({ name: "photo.png", type: "image/png" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "photo.heic", type: "" })).toBe("image");
  });

  it("rejects unsupported image types instead of attaching them as generic files", () => {
    expect(classifyComposerAttachmentFile({ name: "diagram.svg", type: "image/svg+xml" })).toBe(
      "unsupported-image",
    );
    expect(classifyComposerAttachmentFile({ name: "photo.tiff", type: "image/tiff" })).toBe(
      "unsupported-image",
    );
    expect(classifyComposerAttachmentFile({ name: "report.pdf", type: "application/pdf" })).toBe(
      "file",
    );
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

  it("claims unsupported image pastes so the composer can report them", () => {
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

  it("claims generic file-only pastes so the composer can report validation errors", () => {
    const file = new File(["report"], "report.pdf", { type: "application/pdf" });

    expect(shouldHandleComposerAttachmentPaste({ files: [file], plainText: "" })).toBe(true);
  });

  it("routes empty and oversized generic files to composer feedback", () => {
    const empty = new File([], "empty.txt", { type: "text/plain" });
    const oversized = new File([new Uint8Array(1024)], "large.zip", {
      type: "application/zip",
    });

    expect(shouldHandleComposerAttachmentPaste({ files: [empty], plainText: "" })).toBe(true);
    expect(shouldHandleComposerAttachmentPaste({ files: [oversized], plainText: "" })).toBe(true);
  });

  it("ignores an empty clipboard", () => {
    expect(shouldHandleComposerAttachmentPaste({ files: [], plainText: "" })).toBe(false);
  });

  it("falls back to the extension when an image arrives without a MIME type", () => {
    expect(classifyComposerAttachmentFile({ name: "photo.jpg", type: "" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "shot.PNG", type: "" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "archive.zip", type: "" })).toBe("file");
    expect(classifyComposerAttachmentFile({ name: "no-extension", type: "" })).toBe("file");
    expect(inferImageMimeTypeFromName("photo.jpg")).toBe("image/jpeg");
    expect(inferImageMimeTypeFromName("archive.zip")).toBeNull();
  });

  it("infers supported image types from octet-stream files", () => {
    const jpeg = new File(["jpeg"], "photo.jpg", { type: "application/octet-stream" });
    const png = new File(["png"], "shot.PNG", { type: "application/octet-stream" });

    expect(classifyComposerAttachmentFile(jpeg)).toBe("image");
    expect(classifyComposerAttachmentFile(png)).toBe("image");
    expect(normalizeComposerImageFileMimeType(jpeg).type).toBe("image/jpeg");
    expect(normalizeComposerImageFileMimeType(png).type).toBe("image/png");
  });

  it("does not infer images for unknown extensions or specific conflicting MIME types", () => {
    const binary = new File(["binary"], "archive.bin", { type: "application/octet-stream" });
    const unknownDocument = new File(["pdf"], "report.pdf", {
      type: "application/octet-stream",
    });
    const document = new File(["pdf"], "photo.jpg", { type: "application/pdf" });
    const explicitImage = new File(["png"], "photo.jpg", { type: "image/png" });

    expect(classifyComposerAttachmentFile(binary)).toBe("file");
    expect(classifyComposerAttachmentFile(unknownDocument)).toBe("file");
    expect(classifyComposerAttachmentFile(document)).toBe("file");
    expect(classifyComposerAttachmentFile(explicitImage)).toBe("image");
    expect(normalizeComposerImageFileMimeType(binary)).toBe(binary);
    expect(normalizeComposerImageFileMimeType(document)).toBe(document);
    expect(normalizeComposerImageFileMimeType(explicitImage)).toBe(explicitImage);
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

  it("rejects local staging and send when known config has no file support", () => {
    const unsupportedReason =
      "This server does not accept file attachments right now. Remove the files to send.";
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: null,
      }),
    ).toBeNull();
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: 50 * 1024 * 1024,
      }),
    ).toBeNull();
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [{ name: "report.pdf", sizeBytes: 1024 }],
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: null,
      }),
    ).toBe(unsupportedReason);
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [{ name: "report.pdf", sizeBytes: 1024 }],
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: 50 * 1024 * 1024,
      }),
    ).toBe(unsupportedReason);
  });

  it("blocks retained files that exceed a newly lower server limit", () => {
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [{ name: "large.zip", sizeBytes: 2 * 1024 * 1024 }],
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: 1024 * 1024,
      }),
    ).toBe("'large.zip' exceeds the 1 MB attachment limit.");
  });

  it("uses the confirmed server limit without exceeding the hard cap", () => {
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: 1024 * 1024,
      }),
    ).toBe(1024 * 1024);
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES * 2,
      }),
    ).toBe(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [{ name: "report.pdf", sizeBytes: 1024 }],
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: 50 * 1024 * 1024,
      }),
    ).toBeNull();
  });

  it("does not block empty or image-only composers on legacy servers", () => {
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [],
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: null,
      }),
    ).toBeNull();
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [],
        attachmentUploadsCapabilityKnown: false,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: null,
      }),
    ).toBeNull();
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

  it("keeps restored videos on the preview path in their upload environment", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const video: ComposerFileAttachment = {
      type: "file",
      id: "video-1",
      name: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 3,
      file: null,
      uploadedAttachmentId: "uploaded-video-1",
      uploadEnvironmentId: environmentId,
    };

    expect(isPreviewableComposerVideo(video, environmentId)).toBe(true);
    expect(isPreviewableComposerVideo(video, EnvironmentId.make("environment-2"))).toBe(false);
  });

  it("recognizes common video extensions when the browser omits the MIME type", () => {
    const formats = [
      ["clip.mp4", "video/mp4"],
      ["clip.mov", "video/quicktime"],
      ["clip.webm", "video/webm"],
      ["clip.m4v", "video/mp4"],
      ["clip.mkv", "video/x-matroska"],
      ["clip.avi", "video/x-msvideo"],
      ["clip.ogv", "video/ogg"],
    ] as const;

    for (const [name, expectedMimeType] of formats) {
      expect(
        isVideoAttachment({
          type: "file",
          id: name,
          name,
          mimeType: "application/octet-stream",
          sizeBytes: 1,
        }),
      ).toBe(true);
      expect(videoMimeType({ name, mimeType: "application/octet-stream" })).toBe(expectedMimeType);
    }
  });

  it("claims image pastes even when clipboard text is present", () => {
    const image = new File(["image"], "photo.heic", { type: "image/heic" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [image],
        plainText: "Image caption",
      }),
    ).toBe(true);
  });
});
