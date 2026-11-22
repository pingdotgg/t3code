import {
  ChatAttachmentId,
  ComposerContextId,
  type ChatFileAttachment,
  type ChatImageAttachment,
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
  return {
    files: new Map(),
    previewAnnotations: new Map(),
    restoredQueuedImageIds: new Set(),
  };
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

  it("reconciles chip-backed queued files on delete, restores removed queued images and files on undo, and re-removes restored images on redo", () => {
    const retained = retention();
    const chipFile: ChatFileAttachment = {
      type: "file",
      id: ChatAttachmentId.make("server-file-1"),
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    };
    const plainFile: ChatFileAttachment = {
      type: "file",
      id: ChatAttachmentId.make("server-file-2"),
      name: "legacy.pdf",
      mimeType: "application/pdf",
      sizeBytes: 40,
    };
    const rowRemovedImage: ChatImageAttachment = {
      type: "image",
      id: ChatAttachmentId.make("server-image-1"),
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 67,
    };
    const chipContextId = ComposerContextId.make("file_local-1");
    const imageContextId = ComposerContextId.make("image_local-1");

    // Deleting a chip-backed file removes it; deleting an image chip directly or editing around an
    // unreferenced file preserves both.
    const removed = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      files: [],
      queuedAttachments: [
        { attachment: chipFile, contextIds: [chipContextId] },
        { attachment: plainFile, contextIds: [] },
        { attachment: rowRemovedImage, contextIds: [imageContextId] },
      ],
      removedQueuedAttachments: [],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(removed.queuedAttachmentIdsToRemove).toEqual([chipFile.id]);
    expect(removed.queuedAttachmentsToRestore).toEqual([]);

    // Undoing restores both a keyboard-deleted file and a row-removed image when their chips return.
    const restored = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([chipContextId, imageContextId]),
      files: [],
      queuedAttachments: [{ attachment: plainFile, contextIds: [] }],
      removedQueuedAttachments: [
        { attachment: chipFile, contextIds: [chipContextId] },
        { attachment: rowRemovedImage, contextIds: [imageContextId] },
      ],
      isHistory: true,
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(restored.queuedAttachmentIdsToRemove).toEqual([]);
    expect(restored.queuedAttachmentsToRestore).toEqual([chipFile, rowRemovedImage]);

    // Typing around a restored image chip (non-history change while chip stays referenced)
    // does not lose history-undo tracking when a subsequent Undo removes the pasted/restored chip.
    const typed = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([chipContextId, imageContextId]),
      files: [],
      queuedAttachments: [
        { attachment: chipFile, contextIds: [chipContextId] },
        { attachment: plainFile, contextIds: [] },
        { attachment: rowRemovedImage, contextIds: [imageContextId] },
      ],
      removedQueuedAttachments: [],
      isHistory: false,
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(typed.queuedAttachmentIdsToRemove).toEqual([]);

    // Redoing or undoing past the restoration removes both the file and the restored image,
    // while keeping an unreferenced file intact.
    const redone = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      files: [],
      queuedAttachments: [
        { attachment: chipFile, contextIds: [chipContextId] },
        { attachment: plainFile, contextIds: [] },
        { attachment: rowRemovedImage, contextIds: [imageContextId] },
      ],
      removedQueuedAttachments: [],
      isHistory: true,
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(redone.queuedAttachmentIdsToRemove).toEqual([chipFile.id, rowRemovedImage.id]);
    expect(redone.queuedAttachmentsToRestore).toEqual([]);

    // Undoing again and then deleting the image chip directly via Backspace (non-history edit)
    // keeps the image on the thumbnail shelf and clears its history-removal flag.
    reconcileAttachmentContextReferences({
      referencedContextIds: new Set([imageContextId]),
      files: [],
      queuedAttachments: [{ attachment: plainFile, contextIds: [] }],
      removedQueuedAttachments: [{ attachment: rowRemovedImage, contextIds: [imageContextId] }],
      isHistory: true,
      images: [],
      previewAnnotations: [],
      retained,
    });
    const backspaced = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      files: [],
      queuedAttachments: [
        { attachment: plainFile, contextIds: [] },
        { attachment: rowRemovedImage, contextIds: [imageContextId] },
      ],
      removedQueuedAttachments: [],
      isHistory: false,
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(backspaced.queuedAttachmentIdsToRemove).toEqual([]);
    expect(backspaced.queuedAttachmentsToRestore).toEqual([]);
    expect(retained.restoredQueuedImageIds.size).toBe(0);
  });
});
