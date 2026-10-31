import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import {
  buildMessageContext,
  fileContextReference,
  previewAnnotationContextId,
} from "../../lib/composerContextRecords";
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
  return { files: new Map(), previewAnnotations: new Map() };
}

describe("reconcileAttachmentContextReferences", () => {
  it("restores an annotation and its screenshot attachment after undo", () => {
    const retained = retention();
    const file = {
      type: "file",
      id: "picked-file",
      name: "question.pdf",
      mimeType: "application/pdf",
      sizeBytes: binary.size,
      file: binary,
    } satisfies ComposerFileAttachment;
    const contextId = fileContextReference(file).contextId;
    const standalone = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      previousReferencedContextIds: new Set(),
      files: [file],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(standalone.filesToRemove).toEqual([]);
    const removed = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      previousReferencedContextIds: new Set([contextId]),
      files: [file],
      images: [image],
      previewAnnotations: [annotation],
      retained,
    });
    expect(removed.annotationIdsToRemove).toEqual(["annotation-1"]);
    expect(removed.filesToRemove).toEqual([file.id]);

    const restored = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([previewAnnotationContextId(annotation.id), contextId]),
      previousReferencedContextIds: new Set(),
      files: [],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(restored.annotationsToRestore).toEqual([{ annotation, image }]);
    expect(restored.filesToRestore).toEqual([file]);
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
});
