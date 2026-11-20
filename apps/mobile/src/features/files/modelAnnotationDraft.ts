import {
  COMPOSER_CONTEXT_PREVIEW_COMMENT_MAX_CHARS,
  type ComposerContextRecord,
  type ImageContextRecord,
  type OrchestrationMessageContext,
  type PreviewAnnotationContextRecord,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import {
  modelAnnotationFileTarget,
  modelAnnotationNotes,
} from "@t3tools/client-runtime/model-preview/annotations";
import {
  formatComposerContextReference,
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";

import { estimateBase64ByteSize } from "../../lib/base64";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/**
 * Composer content for model notes, shaped like web's preview annotation records. The screenshot
 * stays PNG so its transparent background follows every theme.
 */
export function modelAnnotationComposerContent(
  annotation: PreviewAnnotationPayload,
  createId: () => string,
): {
  readonly text: string;
  readonly context: OrchestrationMessageContext;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
} | null {
  const dataUrl = annotation.screenshot?.dataUrl;
  if (!dataUrl?.startsWith(PNG_DATA_URL_PREFIX)) return null;
  const screenshot: DraftComposerImageAttachment = {
    id: createId(),
    type: "image",
    name: `preview-annotation-${annotation.id}.png`,
    mimeType: "image/png",
    sizeBytes: estimateBase64ByteSize(dataUrl.slice(PNG_DATA_URL_PREFIX.length)),
    dataUrl,
    previewUri: dataUrl,
  };
  const image: ImageContextRecord = {
    version: 1,
    kind: "image",
    contextId: toKindScopedComposerContextId("image", screenshot.id),
    label: sanitizeComposerContextLabel(screenshot.name, "image"),
    attachmentId: screenshot.id,
    name: screenshot.name,
    mimeType: screenshot.mimeType,
    sizeBytes: screenshot.sizeBytes,
  };
  const comment = annotation.comment.trim();
  const record: PreviewAnnotationContextRecord = {
    version: 1,
    kind: "preview-annotation",
    contextId: toKindScopedComposerContextId("preview-annotation", annotation.id),
    label: sanitizeComposerContextLabel(
      annotation.pageTitle ?? annotation.pageUrl,
      "preview-annotation",
    ),
    annotationId: annotation.id,
    pageUrl: annotation.pageUrl,
    pageTitle: annotation.pageTitle,
    comment:
      comment.length <= COMPOSER_CONTEXT_PREVIEW_COMMENT_MAX_CHARS
        ? comment
        : `${comment.slice(0, COMPOSER_CONTEXT_PREVIEW_COMMENT_MAX_CHARS - 1)}…`,
    targetSummary: "",
    styleChanges: [],
    styleChangeDetails: [],
    screenshotContextId: image.contextId,
  };
  return {
    text: `${formatComposerContextReference(record)} `,
    context: { version: 1, records: [record, image] },
    attachments: [screenshot],
  };
}

/** A context record's notes on a 3D model and the file and camera they reopen, or null for other records. */
export function modelAnnotationOf(record: ComposerContextRecord | undefined) {
  if (!record || record.kind !== "preview-annotation" || "payload" in record) return null;
  if ((record.elements?.length ?? 0) > 0) return null;
  const target = modelAnnotationFileTarget(record.pageUrl);
  const parsed = modelAnnotationNotes(record.comment);
  if (!parsed && !target) return null;
  return {
    record,
    notes: parsed?.notes ?? [{ number: 1, text: record.comment, stale: false }],
    target,
  };
}

/** The model annotations a draft holds, each with the attachment of its screenshot. */
export function modelAnnotationDrafts(
  context: OrchestrationMessageContext | undefined,
  attachments: ReadonlyArray<{ readonly id: string }>,
) {
  const records = context?.records ?? [];
  return records.flatMap((entry) => {
    const annotation = modelAnnotationOf(entry);
    if (!annotation) return [];
    const image = records.find(
      (candidate) => candidate.contextId === annotation.record.screenshotContextId,
    );
    const screenshot =
      image && "attachmentId" in image
        ? attachments.find((attachment) => attachment.id === image.attachmentId)
        : undefined;
    return [{ ...annotation, screenshotId: screenshot?.id ?? null }];
  });
}
