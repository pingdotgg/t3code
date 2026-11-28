import {
  ChatAttachmentId,
  ComposerContextId,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { buildMessageContext, previewAnnotationContextId } from "../../lib/composerContextRecords";
import {
  reconcileAttachmentContextReferences,
  type RetainedAttachmentContextPayloads,
} from "./composerContextUndo";

const binary = new File(["binary"], "context.png", { type: "image/png" });
const image = {
  type: "image",
  id: "annotation-1",
  name: "annotation.png",
  mimeType: "image/png",
  sizeBytes: binary.size,
  previewUrl: "blob:annotation",
  file: binary,
} satisfies ComposerImageAttachment;
const annotation = {
  id: "annotation-1",
  pageUrl: "https://example.com",
  pageTitle: "Example",
  comment: "Fix this",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: {
    dataUrl: "data:image/png;base64,YmluYXJ5",
    width: 1,
    height: 1,
    cropRect: { x: 0, y: 0, width: 1, height: 1 },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies PreviewAnnotationPayload;

function retention(): RetainedAttachmentContextPayloads {
  return { files: new Map(), previewAnnotations: new Map(), restoredQueuedImageIds: new Set() };
}

describe("reconcileAttachmentContextReferences", () => {
  it("restores an annotation and its screenshot attachment after undo", () => {
    const retained = retention();
    const removed = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      files: [],
      images: [image],
      previewAnnotations: [annotation],
      retained,
    });
    expect(removed.annotationIdsToRemove).toEqual(["annotation-1"]);

    const restored = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([previewAnnotationContextId(annotation.id)]),
      files: [],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(restored.annotationsToRestore).toEqual([{ annotation, image }]);
    expect(restored.annotationsToRestore[0]?.annotation.screenshot?.dataUrl).toBe(
      "data:image/png;base64,YmluYXJ5",
    );
    expect(restored.annotationsToRestore[0]?.image?.file).toBe(binary);
    expect(
      buildMessageContext({
        terminalContexts: [],
        reviewComments: [],
        previewAnnotations: restored.annotationsToRestore.map((entry) => entry.annotation),
        attachments: [
          {
            attachment: restored.annotationsToRestore[0]!.image!,
            attachmentId: "uploaded-screenshot",
          },
        ],
      })?.records,
    ).toEqual([
      expect.objectContaining({
        kind: "preview-annotation",
        screenshotContextId: "image_annotation-1",
      }),
      expect.objectContaining({
        kind: "image",
        contextId: "image_annotation-1",
        attachmentId: "uploaded-screenshot",
      }),
    ]);
  });

  it("drops a queued file with its chip, keeps a queued image, and lets undo and redo restore and remove either", () => {
    const file = {
      attachment: {
        type: "file" as const,
        id: ChatAttachmentId.make("server-file"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
      },
      contextIds: [ComposerContextId.make("file_local")],
    };
    const queuedImage = {
      attachment: {
        type: "image" as const,
        id: ChatAttachmentId.make("server-image"),
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 67,
      },
      contextIds: [ComposerContextId.make("image_local")],
    };
    const base = { files: [], images: [], previewAnnotations: [], retained: retention() };

    const deleted = reconcileAttachmentContextReferences({
      ...base,
      referencedContextIds: new Set(),
      queuedAttachments: [file, queuedImage],
    });
    expect(deleted.queuedAttachmentIdsToRemove).toEqual([file.attachment.id]);

    const undone = reconcileAttachmentContextReferences({
      ...base,
      referencedContextIds: new Set(["file_local", "image_local"]),
      removedQueuedAttachments: [file, queuedImage],
    });
    expect(undone.queuedAttachmentsToRestore).toEqual([file.attachment, queuedImage.attachment]);

    const redone = reconcileAttachmentContextReferences({
      ...base,
      referencedContextIds: new Set(),
      queuedAttachments: [file, queuedImage],
      fromHistory: true,
    });
    expect(redone.queuedAttachmentIdsToRemove).toEqual([
      file.attachment.id,
      queuedImage.attachment.id,
    ]);

    reconcileAttachmentContextReferences({
      ...base,
      referencedContextIds: new Set(["image_local"]),
      removedQueuedAttachments: [queuedImage],
    });
    const backspaced = reconcileAttachmentContextReferences({
      ...base,
      referencedContextIds: new Set(),
      queuedAttachments: [queuedImage],
    });
    expect(backspaced.queuedAttachmentIdsToRemove).toEqual([]);
  });
});
