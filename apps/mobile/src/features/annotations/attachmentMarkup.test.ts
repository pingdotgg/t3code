import { PreviewAnnotationPayloadSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAnnotatedImageAttachment,
  markupDocumentFromAttachment,
  originalImageFromAttachment,
} from "./attachmentMarkup";
import { EMPTY_MARKUP_DOCUMENT, addElementCallout, addPointCallout } from "./model";

const decodeAnnotation = Schema.decodeUnknownSync(PreviewAnnotationPayloadSchema);

const originalAttachment: DraftComposerImageAttachment = {
  id: "image-1",
  type: "image",
  name: "screen.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 123,
  dataUrl: "data:image/jpeg;base64,b3JpZ2luYWw=",
  previewUri: "file:///screen.jpg",
};

describe("mobile image annotation attachment adapter", () => {
  it("creates a flattened PNG while preserving the durable original", () => {
    const document = addPointCallout(EMPTY_MARKUP_DOCUMENT, {
      id: "callout-1",
      point: { x: 0.25, y: 0.75 },
      comment: "Move this",
    });
    const attachment = buildAnnotatedImageAttachment({
      attachment: originalAttachment,
      document,
      sourceSize: { width: 1_200, height: 800 },
      exportSize: { width: 1_024, height: 683 },
      annotationId: "annotation-1",
      createdAt: "2026-07-30T12:00:00.000Z",
      flattenedDataUrl: "data:image/png;base64,ZmxhdHRlbmVk",
      flattenedSizeBytes: 222,
    });

    expect(attachment).toMatchObject({
      id: "image-1",
      name: "preview-annotation-annotation-1.png",
      mimeType: "image/png",
      sizeBytes: 222,
      previewUri: "data:image/png;base64,ZmxhdHRlbmVk",
      markup: {
        original: {
          name: "screen.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 123,
          dataUrl: "data:image/jpeg;base64,b3JpZ2luYWw=",
          previewUri: "file:///screen.jpg",
        },
        annotation: {
          schemaVersion: 1,
          source: { kind: "image", name: "screen.jpg" },
          callouts: document.callouts,
          editable: {
            version: 1,
            coordinateSpace: "normalized",
            strokes: [],
          },
          elements: [],
          regions: [],
          strokes: [],
          styleChanges: [],
          screenshot: {
            dataUrl: "",
            width: 1_024,
            height: 683,
            cropRect: { x: 0, y: 0, width: 1_200, height: 800 },
          },
        },
      },
    });
    expect(decodeAnnotation(attachment.markup?.annotation)).toEqual(attachment.markup?.annotation);
  });

  it("reopens editable vectors and does not replace the original with a prior flatten", () => {
    const first = buildAnnotatedImageAttachment({
      attachment: originalAttachment,
      document: EMPTY_MARKUP_DOCUMENT,
      sourceSize: { width: 100, height: 100 },
      exportSize: { width: 100, height: 100 },
      annotationId: "annotation-1",
      createdAt: "2026-07-30T12:00:00.000Z",
      flattenedDataUrl: "data:image/png;base64,Zmlyc3Q=",
      flattenedSizeBytes: 50,
    });
    const reopenedDocument = addPointCallout(markupDocumentFromAttachment(first), {
      id: "callout-2",
      point: { x: 0.5, y: 0.5 },
    });
    const second = buildAnnotatedImageAttachment({
      attachment: first,
      document: reopenedDocument,
      sourceSize: { width: 100, height: 100 },
      exportSize: { width: 100, height: 100 },
      annotationId: "ignored-new-id",
      createdAt: "2026-07-30T13:00:00.000Z",
      flattenedDataUrl: "data:image/png;base64,c2Vjb25k",
      flattenedSizeBytes: 60,
    });

    expect(second.markup?.annotation.id).toBe("annotation-1");
    expect(second.markup?.annotation.createdAt).toBe("2026-07-30T12:00:00.000Z");
    expect(originalImageFromAttachment(second).dataUrl).toBe(originalAttachment.dataUrl);
    expect(markupDocumentFromAttachment(second).callouts).toEqual(reopenedDocument.callouts);
    expect(second.markup?.annotation.screenshot?.scale).toBe(1);
  });

  it("derives a generic image re-edit scale from the previous flatten", () => {
    const first = buildAnnotatedImageAttachment({
      attachment: originalAttachment,
      document: EMPTY_MARKUP_DOCUMENT,
      sourceSize: { width: 1_200, height: 800 },
      exportSize: { width: 600, height: 400 },
      annotationId: "annotation-1",
      createdAt: "2026-07-30T12:00:00.000Z",
      flattenedDataUrl: "data:image/png;base64,Zmlyc3Q=",
      flattenedSizeBytes: 50,
    });
    const second = buildAnnotatedImageAttachment({
      attachment: first,
      document: EMPTY_MARKUP_DOCUMENT,
      sourceSize: { width: 1_200, height: 800 },
      exportSize: { width: 300, height: 200 },
      annotationId: "ignored-new-id",
      createdAt: "2026-07-30T13:00:00.000Z",
      flattenedDataUrl: "data:image/png;base64,c2Vjb25k",
      flattenedSizeBytes: 60,
    });

    expect(first.markup?.annotation.screenshot?.scale).toBe(0.5);
    expect(second.markup?.annotation.screenshot?.scale).toBe(0.25);
  });

  it("preserves preview identity and includes only selected semantic elements", () => {
    const candidate = {
      id: "element-submit",
      rect: { x: 420, y: 180, width: 160, height: 64 },
      element: {
        pageUrl: "http://localhost:5173/checkout",
        pageTitle: "Checkout",
        tagName: "button",
        selector: "button.submit",
        htmlPreview: '<button role="button" aria-label="Pay now">',
        componentName: null,
        source: null,
        stack: [],
        styles: "",
        pickedAt: "2026-07-30T12:00:00.000Z",
      },
    } as const;
    const previewAttachment: DraftComposerImageAttachment = {
      ...originalAttachment,
      markup: {
        original: {
          name: originalAttachment.name,
          mimeType: originalAttachment.mimeType,
          sizeBytes: originalAttachment.sizeBytes,
          dataUrl: originalAttachment.dataUrl,
          previewUri: originalAttachment.previewUri,
        },
        annotation: {
          id: "preview-annotation",
          pageUrl: "http://localhost:5173/checkout",
          pageTitle: "Checkout",
          comment: "",
          elements: [],
          regions: [],
          strokes: [],
          styleChanges: [],
          screenshot: {
            dataUrl: "",
            width: 1_280,
            height: 1_024,
            cropRect: { x: 0, y: 0, width: 1_000, height: 800 },
            scale: 1.28,
            pageRevision: "page-7",
          },
          createdAt: "2026-07-30T12:00:00.000Z",
          schemaVersion: 1,
          source: {
            kind: "preview",
            url: "http://localhost:5173/checkout",
            title: "Checkout",
          },
          callouts: [],
          editable: { version: 1, coordinateSpace: "normalized", strokes: [] },
        },
      },
    };
    const document = addElementCallout(EMPTY_MARKUP_DOCUMENT, {
      id: "callout-submit",
      targetId: candidate.id,
      rect: { x: 0.42, y: 0.225, width: 0.16, height: 0.08 },
      comment: "Make this primary",
    });
    const attachment = buildAnnotatedImageAttachment({
      attachment: previewAttachment,
      document,
      semanticElements: [candidate],
      sourceSize: { width: 1_280, height: 1_024 },
      exportSize: { width: 640, height: 512 },
      annotationId: "ignored",
      createdAt: "2026-07-30T13:00:00.000Z",
      flattenedDataUrl: "data:image/png;base64,ZmxhdHRlbmVk",
      flattenedSizeBytes: 222,
    });

    expect(attachment.markup?.annotation).toMatchObject({
      pageUrl: "http://localhost:5173/checkout",
      pageTitle: "Checkout",
      source: {
        kind: "preview",
        url: "http://localhost:5173/checkout",
        title: "Checkout",
      },
      elements: [candidate],
      screenshot: {
        cropRect: { x: 0, y: 0, width: 1_000, height: 800 },
        pageRevision: "page-7",
        scale: 0.64,
      },
    });

    const reedited = buildAnnotatedImageAttachment({
      attachment,
      document,
      semanticElements: [candidate],
      sourceSize: { width: 1_280, height: 1_024 },
      exportSize: { width: 320, height: 256 },
      annotationId: "ignored-again",
      createdAt: "2026-07-30T14:00:00.000Z",
      flattenedDataUrl: "data:image/png;base64,cmVlZGl0ZWQ=",
      flattenedSizeBytes: 111,
    });
    expect(reedited.markup?.annotation.screenshot?.scale).toBe(0.32);
  });
});
