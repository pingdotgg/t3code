import {
  PREVIEW_REVIEW_SNAPSHOT_MAX_BASE64_CHARS,
  PREVIEW_REVIEW_SNAPSHOT_MAX_ELEMENTS,
  PREVIEW_REVIEW_SNAPSHOT_MAX_IMAGE_BYTES,
  PREVIEW_REVIEW_SNAPSHOT_MAX_PAGE_REVISION_LENGTH,
  PreviewReviewSnapshotMalformedError,
  PreviewReviewSnapshotTooLargeError,
  type PreviewAutomationReviewSnapshot,
  type PreviewListResult,
  type PreviewReviewSnapshot,
  type PreviewReviewSnapshotElementV1,
  type PreviewReviewSnapshotInput,
  type PreviewReviewSnapshotRectV1,
  type PreviewReviewSnapshotViewportV1,
} from "@t3tools/contracts";
import * as NodeBuffer from "node:buffer";
import * as Effect from "effect/Effect";

const bounded = (value: string, maximumLength: number): string => value.slice(0, maximumLength);

const decodedBase64Length = (value: string): number | null => {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const encodedLength = value.length - padding;
  if (encodedLength % 4 === 1) return null;
  for (let index = 0; index < encodedLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return null;
  }
  for (let index = encodedLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return null;
  }
  return (value.length / 4) * 3 - padding;
};

const readPngDimensions = (
  value: string,
): { readonly width: number; readonly height: number } | null => {
  if (value.length < 32) return null;
  const header = NodeBuffer.Buffer.from(value.slice(0, 32), "base64");
  if (
    header.length < 24 ||
    header[0] !== 0x89 ||
    header[1] !== 0x50 ||
    header[2] !== 0x4e ||
    header[3] !== 0x47 ||
    header[4] !== 0x0d ||
    header[5] !== 0x0a ||
    header[6] !== 0x1a ||
    header[7] !== 0x0a ||
    header.readUInt32BE(8) !== 13 ||
    header.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return null;
  }
  return {
    width: header.readUInt32BE(16),
    height: header.readUInt32BE(20),
  };
};

const nearlyEqualScale = (left: number, right: number): boolean =>
  Math.abs(left - right) / Math.max(left, right) <= 0.02;

const fallbackViewport = (
  snapshot: PreviewAutomationReviewSnapshot,
): PreviewReviewSnapshotViewportV1 => ({
  width: snapshot.screenshot.width,
  height: snapshot.screenshot.height,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 1,
});

const clipRect = (
  rect: PreviewReviewSnapshotRectV1,
  viewport: PreviewReviewSnapshotViewportV1,
): PreviewReviewSnapshotRectV1 | null => {
  const right = Math.min(viewport.width, rect.x + rect.width);
  const bottom = Math.min(viewport.height, rect.y + rect.height);
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const width = right - x;
  const height = bottom - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
};

const compactElements = (
  snapshot: PreviewAutomationReviewSnapshot,
  viewport: PreviewReviewSnapshotViewportV1,
): ReadonlyArray<PreviewReviewSnapshotElementV1> => {
  const elements: PreviewReviewSnapshotElementV1[] = [];
  for (const element of snapshot.interactiveElements) {
    if (elements.length >= PREVIEW_REVIEW_SNAPSHOT_MAX_ELEMENTS) break;
    if (
      !Number.isFinite(element.x) ||
      !Number.isFinite(element.y) ||
      !Number.isFinite(element.width) ||
      !Number.isFinite(element.height)
    ) {
      continue;
    }
    const rect = clipRect(
      {
        x: element.x,
        y: element.y,
        width: Math.max(0, element.width),
        height: Math.max(0, element.height),
      },
      viewport,
    );
    if (!rect) continue;
    elements.push({
      id: `element-${elements.length + 1}`,
      tag: bounded(element.tag, 64),
      role: element.role === null ? null : bounded(element.role, 128),
      name: bounded(element.name, 1_024),
      selector: bounded(element.selector, 2_048),
      rect,
    });
  }
  return elements;
};

export interface CompactPreviewReviewSnapshotInput {
  readonly request: PreviewReviewSnapshotInput;
  readonly snapshot: PreviewAutomationReviewSnapshot;
  readonly snapshotId: string;
  readonly capturedAt: string;
  readonly previewState: Pick<PreviewListResult, "serverEpoch" | "revision">;
}

export const compactPreviewReviewSnapshot = Effect.fn("PreviewReviewSnapshot.compact")(function* (
  input: CompactPreviewReviewSnapshotInput,
): Effect.fn.Return<
  PreviewReviewSnapshot,
  PreviewReviewSnapshotMalformedError | PreviewReviewSnapshotTooLargeError
> {
  const { request, snapshot } = input;
  const malformed = () =>
    new PreviewReviewSnapshotMalformedError({
      threadId: request.threadId,
      tabId: request.tabId,
    });
  if (
    snapshot.screenshot.width <= 0 ||
    snapshot.screenshot.height <= 0 ||
    !Number.isInteger(snapshot.screenshot.width) ||
    !Number.isInteger(snapshot.screenshot.height)
  ) {
    return yield* malformed();
  }
  const tooLarge = () =>
    new PreviewReviewSnapshotTooLargeError({
      threadId: request.threadId,
      tabId: request.tabId,
      maximumBytes: PREVIEW_REVIEW_SNAPSHOT_MAX_IMAGE_BYTES,
    });
  if (snapshot.screenshot.data.length > PREVIEW_REVIEW_SNAPSHOT_MAX_BASE64_CHARS) {
    return yield* tooLarge();
  }
  const imageBytes = decodedBase64Length(snapshot.screenshot.data);
  if (imageBytes === null) return yield* malformed();
  if (imageBytes > PREVIEW_REVIEW_SNAPSHOT_MAX_IMAGE_BYTES) {
    return yield* tooLarge();
  }
  const pngDimensions = readPngDimensions(snapshot.screenshot.data);
  if (
    pngDimensions === null ||
    pngDimensions.width !== snapshot.screenshot.width ||
    pngDimensions.height !== snapshot.screenshot.height
  ) {
    return yield* malformed();
  }
  const viewport = snapshot.viewport ?? fallbackViewport(snapshot);
  const horizontalScale = snapshot.screenshot.width / viewport.width;
  const verticalScale = snapshot.screenshot.height / viewport.height;
  const scale = snapshot.screenshot.scale ?? horizontalScale;
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !nearlyEqualScale(horizontalScale, verticalScale) ||
    !nearlyEqualScale(scale, horizontalScale)
  ) {
    return yield* malformed();
  }
  if (
    snapshot.pageRevision !== undefined &&
    snapshot.pageRevision.length > PREVIEW_REVIEW_SNAPSHOT_MAX_PAGE_REVISION_LENGTH
  ) {
    return yield* malformed();
  }

  return {
    version: 1,
    snapshotId: input.snapshotId,
    pageRevision: snapshot.pageRevision ?? input.snapshotId,
    serverEpoch: input.previewState.serverEpoch,
    previewRevision: input.previewState.revision,
    threadId: request.threadId,
    tabId: request.tabId,
    capturedAt: snapshot.capturedAt ?? input.capturedAt,
    url: bounded(snapshot.url, 2_048),
    title: bounded(snapshot.title, 512),
    loading: snapshot.loading,
    viewport,
    screenshot: {
      mimeType: "image/png",
      data: snapshot.screenshot.data,
      width: snapshot.screenshot.width,
      height: snapshot.screenshot.height,
      scale,
    },
    elements: compactElements(snapshot, viewport),
  };
});
