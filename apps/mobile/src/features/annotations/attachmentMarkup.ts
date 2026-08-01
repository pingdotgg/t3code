import type { PreviewAnnotationElementTarget, PreviewAnnotationPayload } from "@t3tools/contracts";

import type {
  DraftComposerImageAttachment,
  DraftComposerImageMarkupOriginal,
} from "../../lib/composerImages";
import type { MarkupDocument, MarkupSize } from "./model";

export function markupDocumentFromAttachment(
  attachment: DraftComposerImageAttachment,
): MarkupDocument {
  return {
    callouts: attachment.markup?.annotation.callouts ?? [],
    strokes: attachment.markup?.annotation.editable?.strokes ?? [],
  };
}

export function originalImageFromAttachment(
  attachment: DraftComposerImageAttachment,
): DraftComposerImageMarkupOriginal {
  return (
    attachment.markup?.original ?? {
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      dataUrl: attachment.dataUrl,
      previewUri: attachment.previewUri,
    }
  );
}

export function buildMobileImageAnnotation(input: {
  readonly attachment: DraftComposerImageAttachment;
  readonly document: MarkupDocument;
  readonly sourceSize: MarkupSize;
  readonly exportSize: MarkupSize;
  readonly annotationId: string;
  readonly createdAt: string;
  readonly semanticElements?: ReadonlyArray<PreviewAnnotationElementTarget>;
}): PreviewAnnotationPayload {
  const existing = input.attachment.markup?.annotation;
  const original = originalImageFromAttachment(input.attachment);
  const existingScreenshot = existing?.screenshot;
  const exportScale =
    existingScreenshot && existingScreenshot.width > 0
      ? ((existingScreenshot.scale ?? 1) * input.exportSize.width) / existingScreenshot.width
      : Math.min(
          input.exportSize.width / input.sourceSize.width,
          input.exportSize.height / input.sourceSize.height,
        );
  const scale = Number.isFinite(exportScale) && exportScale > 0 ? exportScale : 1;
  const selectedElementIds = new Set(
    input.document.callouts
      .filter((callout) => callout.anchor.kind === "element")
      .map((callout) =>
        callout.anchor.kind === "element" ? callout.anchor.targetId : /* istanbul ignore next */ "",
      ),
  );
  const elementsById = new Map(
    (existing?.elements ?? []).map((target) => [target.id, target] as const),
  );
  for (const target of input.semanticElements ?? []) {
    if (selectedElementIds.has(target.id)) {
      elementsById.set(target.id, target);
    }
  }
  const elements = [...elementsById.values()].filter((target) => selectedElementIds.has(target.id));
  const previewSource = existing?.source?.kind === "preview";

  return {
    id: existing?.id ?? input.annotationId,
    pageUrl: previewSource ? existing.pageUrl : "",
    pageTitle: previewSource ? existing.pageTitle : original.name || null,
    comment: existing?.comment ?? "",
    elements,
    regions: existing?.regions ?? [],
    strokes: existing?.strokes ?? [],
    styleChanges: existing?.styleChanges ?? [],
    screenshot: {
      dataUrl: "",
      width: input.exportSize.width,
      height: input.exportSize.height,
      cropRect: existingScreenshot?.cropRect ?? {
        x: 0,
        y: 0,
        width: input.sourceSize.width,
        height: input.sourceSize.height,
      },
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      pageRevision: existingScreenshot?.pageRevision ?? null,
    },
    createdAt: existing?.createdAt ?? input.createdAt,
    schemaVersion: 1,
    source:
      previewSource && existing.source
        ? existing.source
        : {
            kind: "image",
            name: original.name || null,
          },
    callouts: input.document.callouts,
    editable: {
      version: 1,
      coordinateSpace: "normalized",
      strokes: input.document.strokes,
    },
  };
}

export function buildAnnotatedImageAttachment(input: {
  readonly attachment: DraftComposerImageAttachment;
  readonly document: MarkupDocument;
  readonly sourceSize: MarkupSize;
  readonly exportSize: MarkupSize;
  readonly annotationId: string;
  readonly createdAt: string;
  readonly flattenedDataUrl: string;
  readonly flattenedSizeBytes: number;
  readonly semanticElements?: ReadonlyArray<PreviewAnnotationElementTarget>;
}): DraftComposerImageAttachment {
  const annotation = buildMobileImageAnnotation(input);
  return {
    id: input.attachment.id,
    type: "image",
    name: `preview-annotation-${annotation.id}.png`,
    mimeType: "image/png",
    sizeBytes: input.flattenedSizeBytes,
    dataUrl: input.flattenedDataUrl,
    previewUri: input.flattenedDataUrl,
    markup: {
      annotation,
      original: originalImageFromAttachment(input.attachment),
    },
  };
}
