import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attachmentUploadBlockReason,
  formatAttachmentUploadProgress,
  isAttachmentInWrongEnvironment,
  readyAttachmentRefs,
  resolveAttachmentEnvironmentAction,
  summarizeAttachmentUploads,
  type ComposerAttachmentUpload,
} from "./attachmentUploadState";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("env-2");

function image(
  name: string,
  upload: ComposerAttachmentUpload,
  file: File | null = new File([], name),
) {
  return { name, mimeType: "image/png", sizeBytes: 10, upload, file };
}

const ready = (attachmentId: string, environmentId = ENVIRONMENT_ID): ComposerAttachmentUpload => ({
  status: "ready",
  attachmentId,
  environmentId,
});

describe("attachment upload gating", () => {
  it("blocks the send while any attachment is uploading", () => {
    const summary = summarizeAttachmentUploads(
      [image("a.png", ready("pending-a")), image("b.png", { status: "uploading", progress: 0.4 })],
      ENVIRONMENT_ID,
    );
    expect(summary).toEqual({ ready: 1, uploading: 1, failed: 0, wrongEnvironment: 0 });
    expect(attachmentUploadBlockReason(summary)).toBe("Image still uploading");
  });

  it("blocks the send on a failed attachment so it cannot be silently dropped", () => {
    const summary = summarizeAttachmentUploads(
      [image("a.png", { status: "failed", reason: "Upload failed" })],
      ENVIRONMENT_ID,
    );
    expect(attachmentUploadBlockReason(summary)).toBe("Retry or remove the failed image");
  });

  it("does not block once every attachment is ready", () => {
    const summary = summarizeAttachmentUploads(
      [image("a.png", ready("pending-a"))],
      ENVIRONMENT_ID,
    );
    expect(attachmentUploadBlockReason(summary)).toBeNull();
  });

  it("blocks the send on a ready attachment whose bytes live elsewhere", () => {
    const summary = summarizeAttachmentUploads(
      [image("a.png", ready("pending-a", OTHER_ENVIRONMENT_ID))],
      ENVIRONMENT_ID,
    );
    expect(summary).toEqual({ ready: 0, uploading: 0, failed: 0, wrongEnvironment: 1 });
    expect(attachmentUploadBlockReason(summary)).toBe("Remove the image from another environment");
  });

  it("derives the wrong-environment condition without mutating upload state", () => {
    const wrongEnvironmentImage = image("a.png", ready("pending-a", OTHER_ENVIRONMENT_ID));
    expect(isAttachmentInWrongEnvironment(wrongEnvironmentImage, ENVIRONMENT_ID)).toBe(true);
    // Pointing the composer back at the bytes' environment recovers it.
    expect(isAttachmentInWrongEnvironment(wrongEnvironmentImage, OTHER_ENVIRONMENT_ID)).toBe(false);
  });
});

describe("readyAttachmentRefs", () => {
  it("emits id references for uploaded attachments only", () => {
    expect(
      readyAttachmentRefs(
        [
          image("a.png", ready("pending-a")),
          image("b.png", { status: "uploading", progress: 0.9 }),
          // Uploaded, but to a different environment: not sendable here.
          image("c.png", ready("pending-c", OTHER_ENVIRONMENT_ID)),
        ],
        ENVIRONMENT_ID,
      ),
    ).toEqual([
      { type: "image", id: "pending-a", name: "a.png", mimeType: "image/png", sizeBytes: 10 },
    ]);
  });
});

describe("formatAttachmentUploadProgress", () => {
  it("floors so a chip never reads 100% before the bytes land", () => {
    expect(formatAttachmentUploadProgress(0)).toBe("0%");
    expect(formatAttachmentUploadProgress(0.999)).toBe("99%");
    expect(formatAttachmentUploadProgress(1)).toBe("100%");
  });

  it("clamps values outside 0..1", () => {
    expect(formatAttachmentUploadProgress(-1)).toBe("0%");
    expect(formatAttachmentUploadProgress(Number.NaN)).toBe("0%");
  });
});

describe("resolveAttachmentEnvironmentAction", () => {
  it("keeps an attachment already uploaded to the target environment", () => {
    expect(
      resolveAttachmentEnvironmentAction(image("a.png", ready("pending-a")), ENVIRONMENT_ID),
    ).toBe("keep");
  });

  it("re-uploads when the File is still in memory", () => {
    expect(
      resolveAttachmentEnvironmentAction(
        image("a.png", ready("pending-a", OTHER_ENVIRONMENT_ID)),
        ENVIRONMENT_ID,
      ),
    ).toBe("reupload");
  });

  it("keeps (does not destroy) a File-less attachment from another environment", () => {
    // No File means no re-upload is possible; the ready state survives so
    // switching back to the bytes' environment restores the attachment.
    expect(
      resolveAttachmentEnvironmentAction(
        image("a.png", ready("pending-a", OTHER_ENVIRONMENT_ID), null),
        ENVIRONMENT_ID,
      ),
    ).toBe("keep");
  });

  it("leaves an in-flight upload alone", () => {
    expect(
      resolveAttachmentEnvironmentAction(
        image("a.png", { status: "uploading", progress: 0.1 }),
        ENVIRONMENT_ID,
      ),
    ).toBe("keep");
  });
});
