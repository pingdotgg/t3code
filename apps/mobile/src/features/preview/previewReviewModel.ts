import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type PickedElementPayload,
  type PreviewAnnotationElementTarget,
  type PreviewAnnotationNormalizedPoint,
  type PreviewAnnotationNormalizedRect,
  type PreviewAnnotationPayload,
  type PreviewAnnotationRect,
  type PreviewEvent,
  type PreviewReviewSnapshot,
} from "@t3tools/contracts";

import { estimateBase64ByteSize } from "../../lib/base64";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";

export type MobilePreviewReviewSnapshot = PreviewReviewSnapshot;
export type MobilePreviewMarkupFrame = Pick<
  PreviewReviewSnapshot,
  | "capturedAt"
  | "elements"
  | "pageRevision"
  | "screenshot"
  | "snapshotId"
  | "title"
  | "url"
  | "viewport"
>;
type MobilePreviewReviewElement = MobilePreviewMarkupFrame["elements"][number];

export interface PreviewSnapshotMarkupSeed {
  readonly attachment: DraftComposerImageAttachment;
  readonly semanticElements: ReadonlyArray<PreviewAnnotationElementTarget>;
}

const clip = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

function clippedViewportRect(
  rect: PreviewAnnotationRect,
  viewport: { readonly width: number; readonly height: number },
): PreviewAnnotationRect | null {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return null;
  }
  const left = clip(rect.x, 0, viewport.width);
  const top = clip(rect.y, 0, viewport.height);
  const right = clip(rect.x + rect.width, 0, viewport.width);
  const bottom = clip(rect.y + rect.height, 0, viewport.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function normalizePreviewElementRect(
  rect: PreviewAnnotationRect,
  viewport: { readonly width: number; readonly height: number },
): PreviewAnnotationNormalizedRect | null {
  const clipped = clippedViewportRect(rect, viewport);
  if (!clipped) return null;
  return {
    x: clipped.x / viewport.width,
    y: clipped.y / viewport.height,
    width: clipped.width / viewport.width,
    height: clipped.height / viewport.height,
  };
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function semanticHtmlPreview(element: MobilePreviewReviewElement): string {
  const tag = element.tag.trim().toLowerCase() || "div";
  const attributes = [
    element.role?.trim() ? `role="${escapeHtmlAttribute(element.role.trim())}"` : null,
    element.name.trim() ? `aria-label="${escapeHtmlAttribute(element.name.trim())}"` : null,
  ].filter((attribute): attribute is string => attribute !== null);
  return `<${tag}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}>`;
}

function pickedElement(
  snapshot: MobilePreviewMarkupFrame,
  element: MobilePreviewReviewElement,
): PickedElementPayload {
  return {
    pageUrl: snapshot.url,
    pageTitle: snapshot.title || null,
    tagName: element.tag.trim().toLowerCase() || "div",
    selector: element.selector.trim() || null,
    htmlPreview: semanticHtmlPreview(element),
    componentName: null,
    source: null,
    stack: [],
    styles: "",
    pickedAt: snapshot.capturedAt,
  };
}

export function previewSnapshotSemanticElements(
  snapshot: MobilePreviewMarkupFrame,
): ReadonlyArray<PreviewAnnotationElementTarget> {
  const uniqueIds = new Set<string>();
  const targets: PreviewAnnotationElementTarget[] = [];
  for (const element of snapshot.elements) {
    if (element.id.trim().length === 0 || uniqueIds.has(element.id)) continue;
    const rect = clippedViewportRect(element.rect, snapshot.viewport);
    if (!rect) continue;
    uniqueIds.add(element.id);
    targets.push({
      id: element.id,
      rect,
      element: pickedElement(snapshot, element),
    });
  }
  return targets;
}

export function normalizedRectForSemanticElement(
  target: PreviewAnnotationElementTarget,
  annotation: PreviewAnnotationPayload,
): PreviewAnnotationNormalizedRect | null {
  const crop = annotation.screenshot?.cropRect;
  if (!crop || crop.width <= 0 || crop.height <= 0) return null;
  return normalizePreviewElementRect(
    {
      x: target.rect.x - crop.x,
      y: target.rect.y - crop.y,
      width: target.rect.width,
      height: target.rect.height,
    },
    crop,
  );
}

export function semanticElementAtPoint(input: {
  readonly point: PreviewAnnotationNormalizedPoint;
  readonly elements: ReadonlyArray<{
    readonly target: PreviewAnnotationElementTarget;
    readonly rect: PreviewAnnotationNormalizedRect;
  }>;
}): {
  readonly target: PreviewAnnotationElementTarget;
  readonly rect: PreviewAnnotationNormalizedRect;
} | null {
  let selected: {
    readonly target: PreviewAnnotationElementTarget;
    readonly rect: PreviewAnnotationNormalizedRect;
  } | null = null;
  let selectedArea = Number.POSITIVE_INFINITY;
  for (const candidate of input.elements) {
    const rect = candidate.rect;
    const contains =
      input.point.x >= rect.x &&
      input.point.x <= rect.x + rect.width &&
      input.point.y >= rect.y &&
      input.point.y <= rect.y + rect.height;
    if (!contains) continue;
    const area = rect.width * rect.height;
    if (area < selectedArea) {
      selected = candidate;
      selectedArea = area;
    }
  }
  return selected;
}

export function selectedSemanticElements(input: {
  readonly annotation: PreviewAnnotationPayload;
  readonly candidates: ReadonlyArray<PreviewAnnotationElementTarget>;
}): ReadonlyArray<PreviewAnnotationElementTarget> {
  const selectedIds = new Set(
    (input.annotation.callouts ?? [])
      .filter((callout) => callout.anchor.kind === "element")
      .map((callout) =>
        callout.anchor.kind === "element" ? callout.anchor.targetId : /* istanbul ignore next */ "",
      ),
  );
  const targets = new Map(input.annotation.elements.map((target) => [target.id, target]));
  for (const candidate of input.candidates) {
    if (selectedIds.has(candidate.id)) targets.set(candidate.id, candidate);
  }
  return [...targets.values()].filter((target) => selectedIds.has(target.id));
}

export function previewSnapshotIsStale(
  snapshot: PreviewReviewSnapshot,
  event: PreviewEvent,
): boolean {
  if (event.serverEpoch !== snapshot.serverEpoch) return true;
  return (
    event.threadId === snapshot.threadId &&
    event.tabId === snapshot.tabId &&
    event.revision > snapshot.previewRevision
  );
}

export function createPreviewSnapshotMarkupSeed(input: {
  readonly snapshot: MobilePreviewMarkupFrame;
  readonly attachmentId: string;
  readonly annotationId: string;
}): PreviewSnapshotMarkupSeed {
  const { snapshot } = input;
  const sizeBytes = estimateBase64ByteSize(snapshot.screenshot.data);
  if (sizeBytes <= 0) {
    throw new Error("The desktop preview returned an empty screenshot.");
  }
  if (sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    throw new Error("The preview screenshot exceeds the 10 MB attachment limit.");
  }
  const dataUrl = `data:${snapshot.screenshot.mimeType};base64,${snapshot.screenshot.data}`;
  const name = `preview-${snapshot.snapshotId}.png`;
  const original = {
    name,
    mimeType: snapshot.screenshot.mimeType,
    sizeBytes,
    dataUrl,
    previewUri: dataUrl,
  };
  const annotation: PreviewAnnotationPayload = {
    id: input.annotationId,
    pageUrl: snapshot.url,
    pageTitle: snapshot.title || null,
    comment: "",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: {
      dataUrl: "",
      width: snapshot.screenshot.width,
      height: snapshot.screenshot.height,
      cropRect: {
        x: 0,
        y: 0,
        width: snapshot.viewport.width,
        height: snapshot.viewport.height,
      },
      scale: snapshot.screenshot.scale,
      pageRevision: snapshot.pageRevision,
    },
    createdAt: snapshot.capturedAt,
    schemaVersion: 1,
    source: {
      kind: "preview",
      url: snapshot.url,
      title: snapshot.title || null,
    },
    callouts: [],
    editable: {
      version: 1,
      coordinateSpace: "normalized",
      strokes: [],
    },
  };
  return {
    attachment: {
      id: input.attachmentId,
      type: "image",
      ...original,
      markup: { annotation, original },
    },
    semanticElements: previewSnapshotSemanticElements(snapshot),
  };
}
