import {
  COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS,
  COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS,
} from "@t3tools/contracts";
import type {
  ComposerContextId,
  ComposerContextRecord,
  FileContextRecord,
  ImageContextRecord,
  KnownComposerContextRecord,
  OrchestrationMessageContext,
  PreviewAnnotationContextRecord,
  PreviewAnnotationPayload,
  ReviewCommentContextRecord,
  TerminalContextRecord,
  ThreadId,
} from "@t3tools/contracts";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { sanitizeComposerContextLabel } from "@t3tools/shared/composerContextReferences";

import {
  type ComposerContextReference,
  producerIdFromComposerContextId,
  toKindScopedComposerContextId,
} from "./composerContextReferences";
import type { ComposerFileAttachment, ComposerImageAttachment } from "~/composerDraftStore";
import type { AttachmentUploadState } from "./attachmentUploadState";
import { normalizeElementContextSelection } from "./elementContext";
import {
  formatTerminalContextLabel,
  normalizeTerminalContextText,
  type TerminalContextDraft,
} from "./terminalContext";
import type { ReviewCommentContext } from "~/reviewCommentContext";

/**
 * Builds the wire records behind a draft's inline references, and the reverse for reading a
 * message. Draft shapes stay what the producing panels emit; only the send boundary converts.
 */

const PREVIEW_LABEL_MAX_CHARS = 48;

/**
 * A review selection can be arbitrarily large, but the wire schema bounds `text` and `diff`.
 * Clamp at the same boundary so an oversized selection still sends, marked where it was cut,
 * rather than failing to encode at send time.
 */
const TRUNCATION_MARKER = "\n… truncated …";

function clampContextText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? filePath;
}

export function reviewCommentContextLabel(comment: ReviewCommentContext): string {
  return `${basename(comment.filePath)} ${comment.rangeLabel}`;
}

export function previewAnnotationContextLabel(annotation: PreviewAnnotationPayload): string {
  const comment = annotation.comment.trim().replace(/\s+/g, " ");
  if (comment) {
    return comment.length > PREVIEW_LABEL_MAX_CHARS
      ? `${comment.slice(0, PREVIEW_LABEL_MAX_CHARS - 1)}…`
      : comment;
  }
  return annotation.pageTitle?.trim() || "Preview annotation";
}

export function terminalContextReference(context: TerminalContextDraft): ComposerContextReference {
  return {
    kind: "terminal",
    contextId: toKindScopedComposerContextId("terminal", context.id),
    label: formatTerminalContextLabel(context),
  };
}

/** Review producers mint ids in their own grammars; the context id is a folded form of them. */
export function reviewCommentContextId(commentId: string): ComposerContextId {
  return toKindScopedComposerContextId("review-comment", commentId);
}

/** Distinct from the screenshot image, which reuses the annotation id as its attachment id. */
export function previewAnnotationContextId(annotationId: string): ComposerContextId {
  return toKindScopedComposerContextId("preview-annotation", annotationId);
}

export function reviewCommentContextReference(
  comment: ReviewCommentContext,
): ComposerContextReference {
  return {
    kind: "review-comment",
    contextId: reviewCommentContextId(comment.id),
    label: reviewCommentContextLabel(comment),
  };
}

export function previewAnnotationContextReference(
  annotation: PreviewAnnotationPayload,
): ComposerContextReference {
  return {
    kind: "preview-annotation",
    contextId: previewAnnotationContextId(annotation.id),
    label: previewAnnotationContextLabel(annotation),
  };
}

export function terminalContextRecord(context: TerminalContextDraft): TerminalContextRecord {
  return {
    version: 1,
    contextId: toKindScopedComposerContextId("terminal", context.id),
    kind: "terminal",
    label: sanitizeComposerContextLabel(formatTerminalContextLabel(context), "terminal"),
    terminalId: context.terminalId,
    terminalLabel: context.terminalLabel,
    lineStart: context.lineStart,
    lineEnd: context.lineEnd,
    text: normalizeTerminalContextText(context.text),
  };
}

export function reviewCommentContextRecord(
  comment: ReviewCommentContext,
): ReviewCommentContextRecord {
  return {
    version: 1,
    contextId: reviewCommentContextId(comment.id),
    kind: "review-comment",
    label: sanitizeComposerContextLabel(reviewCommentContextLabel(comment), "review-comment"),
    sectionId: comment.sectionId,
    sectionTitle: comment.sectionTitle,
    filePath: comment.filePath,
    startIndex: comment.startIndex,
    endIndex: comment.endIndex,
    rangeLabel: comment.rangeLabel,
    text: clampContextText(comment.text, COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS),
    diff: clampContextText(comment.diff, COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS),
    ...(comment.fenceLanguage !== undefined ? { fenceLanguage: comment.fenceLanguage } : {}),
    ...(comment.pullRequest !== undefined ? { pullRequest: comment.pullRequest } : {}),
  };
}

function previewAnnotationTargetSummary(annotation: PreviewAnnotationPayload): string {
  const parts: string[] = [];
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  if (annotation.elements.length > 0)
    parts.push(plural(annotation.elements.length, "selected element"));
  if (annotation.regions.length > 0) parts.push(plural(annotation.regions.length, "marked region"));
  if (annotation.strokes.length > 0) parts.push(plural(annotation.strokes.length, "drawing"));
  return parts.join(", ");
}

export function previewAnnotationContextRecord(
  annotation: PreviewAnnotationPayload,
  options?: { screenshotContextId?: string | undefined },
): PreviewAnnotationContextRecord {
  const targets = annotation.elements.flatMap((target) => {
    const element = normalizeElementContextSelection(target.element);
    return element ? [{ id: target.id, element }] : [];
  });
  return {
    version: 1,
    contextId: previewAnnotationContextId(annotation.id),
    kind: "preview-annotation",
    label: sanitizeComposerContextLabel(
      previewAnnotationContextLabel(annotation),
      "preview-annotation",
    ),
    annotationId: annotation.id,
    pageUrl: annotation.pageUrl,
    pageTitle: annotation.pageTitle,
    comment: annotation.comment.trim(),
    targetSummary: previewAnnotationTargetSummary(annotation),
    styleChanges: annotation.styleChanges.map(
      (change) => `${change.property}: ${change.previousValue || "(unset)"} → ${change.value}`,
    ),
    ...(targets.length > 0
      ? {
          elements: targets.map((target) => target.element),
          elementIds: targets.map((target) => target.id),
        }
      : {}),
    styleChangeDetails: annotation.styleChanges.map((change) => ({ ...change })),
    ...(annotation.regions.length > 0 ? { regionCount: annotation.regions.length } : {}),
    ...(annotation.strokes.length > 0 ? { strokeCount: annotation.strokes.length } : {}),
    ...(options?.screenshotContextId !== undefined
      ? { screenshotContextId: toKindScopedComposerContextId("image", options.screenshotContextId) }
      : {}),
  };
}

export function imageContextReference(image: ComposerImageAttachment): ComposerContextReference {
  return {
    kind: "image",
    contextId: toKindScopedComposerContextId("image", image.id),
    label: image.name,
  };
}

export function fileContextReference(file: ComposerFileAttachment): ComposerContextReference {
  return {
    kind: "file",
    contextId: toKindScopedComposerContextId("file", file.id),
    label: file.name,
  };
}

/** Binds a draft attachment to the id the receiving side will know it by. */
export interface BoundComposerAttachment {
  attachment: ComposerImageAttachment | ComposerFileAttachment;
  attachmentId: string;
}

/** Clipboard payloads may only point at attachments that already exist on the server. */
export function uploadedAttachmentContextRecord(
  attachment: ComposerImageAttachment | ComposerFileAttachment,
  upload: AttachmentUploadState | undefined,
): ImageContextRecord | FileContextRecord | null {
  const attachmentId =
    attachment.type === "file" && attachment.uploadedAttachmentId !== undefined
      ? attachment.uploadedAttachmentId
      : upload?.status === "ready"
        ? upload.attachmentId
        : undefined;
  return attachmentId === undefined ? null : attachmentContextRecord({ attachment, attachmentId });
}

export function attachmentContextRecord(
  bound: BoundComposerAttachment,
): ImageContextRecord | FileContextRecord {
  const { attachment, attachmentId } = bound;
  const base = {
    version: 1 as const,
    contextId: toKindScopedComposerContextId(attachment.type, attachment.id),
    label: sanitizeComposerContextLabel(attachment.name, attachment.type),
    attachmentId,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
  return attachment.type === "image" ? { ...base, kind: "image" } : { ...base, kind: "file" };
}

export function buildMessageContext(input: {
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  reviewComments: ReadonlyArray<ReviewCommentContext>;
  previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  attachments?: ReadonlyArray<BoundComposerAttachment>;
}): OrchestrationMessageContext | undefined {
  // An annotation's screenshot travels as the image attachment that reuses its id.
  const screenshotAttachmentIds = new Set(
    (input.attachments ?? []).flatMap(({ attachment }) =>
      attachment.type === "image" ? [attachment.id] : [],
    ),
  );
  const records: ComposerContextRecord[] = [
    ...input.terminalContexts.map(terminalContextRecord),
    ...input.reviewComments.map(reviewCommentContextRecord),
    ...input.previewAnnotations.map((annotation) =>
      previewAnnotationContextRecord(annotation, {
        screenshotContextId: screenshotAttachmentIds.has(annotation.id) ? annotation.id : undefined,
      }),
    ),
    ...(input.attachments ?? []).map(attachmentContextRecord),
  ];
  return records.length === 0 ? undefined : { version: 1, records };
}

/**
 * Narrows away the unknown-kind member. Its `kind` is an open string, so a plain
 * `record.kind === "terminal"` check cannot discriminate the union on its own.
 */
export function asKnownContextRecord(
  record: ComposerContextRecord | undefined,
): KnownComposerContextRecord | undefined {
  if (!record || "payload" in record) return undefined;
  return record as KnownComposerContextRecord;
}

/** Candidate keys for finding the draft record an imported wire record would reconstruct. */
export function composerContextImportLookupIds(
  record: KnownComposerContextRecord,
): ReadonlyArray<ComposerContextId> {
  const destinationId = toKindScopedComposerContextId(
    record.kind,
    producerIdFromComposerContextId(record.kind, record.contextId),
  );
  return destinationId === record.contextId
    ? [record.contextId]
    : [destinationId, record.contextId];
}

export interface ResolvedUserMessageContext {
  text: string;
  records: ReadonlyArray<ComposerContextRecord>;
  recordsById: ReadonlyMap<string, ComposerContextRecord>;
}

/** A message's canonical text plus records; old messages are upgraded in memory on read. */
export function resolveUserMessageContext(message: {
  text: string;
  context?: OrchestrationMessageContext | undefined;
}): ResolvedUserMessageContext {
  const resolved = message.context
    ? { text: message.text, records: message.context.records }
    : upgradeLegacyContextMessage(message.text);
  return {
    text: resolved.text,
    records: resolved.records,
    recordsById: new Map(resolved.records.map((record) => [record.contextId, record])),
  };
}

// ---------------------------------------------------------------------------
// Records back into draft shapes (paste)
// ---------------------------------------------------------------------------

export function terminalContextDraftFromRecord(
  record: TerminalContextRecord,
  threadId: ThreadId,
): TerminalContextDraft {
  return {
    id: producerIdFromComposerContextId("terminal", record.contextId),
    threadId,
    createdAt: new Date().toISOString(),
    terminalId: record.terminalId,
    terminalLabel: record.terminalLabel,
    lineStart: record.lineStart,
    lineEnd: record.lineEnd,
    text: record.text,
  };
}

export function reviewCommentFromRecord(record: ReviewCommentContextRecord): ReviewCommentContext {
  return {
    id: producerIdFromComposerContextId("review-comment", record.contextId),
    sectionId: record.sectionId,
    sectionTitle: record.sectionTitle,
    filePath: record.filePath,
    startIndex: record.startIndex,
    endIndex: record.endIndex,
    rangeLabel: record.rangeLabel,
    text: record.text,
    diff: record.diff,
    ...(record.fenceLanguage !== undefined ? { fenceLanguage: record.fenceLanguage } : {}),
    ...(record.pullRequest !== undefined ? { pullRequest: record.pullRequest } : {}),
  };
}

/** Lossy on purpose: geometry and screenshot do not travel; the agent-facing detail does. */
export function previewAnnotationFromRecord(
  record: PreviewAnnotationContextRecord,
): PreviewAnnotationPayload {
  return {
    id:
      record.annotationId ||
      producerIdFromComposerContextId("preview-annotation", record.contextId),
    pageUrl: record.pageUrl,
    pageTitle: record.pageTitle,
    comment: record.comment,
    elements: (record.elements ?? []).map((element, index) => ({
      id: record.elementIds?.[index] ?? `${record.contextId}-element-${index + 1}`,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      element: { ...element, stack: [], pickedAt: new Date().toISOString() },
    })),
    // Geometry does not travel, but the counts do, so the rebuilt summary still reports
    // what the annotation marked.
    regions: Array.from({ length: record.regionCount ?? 0 }, (_unused, index) => ({
      id: `${record.contextId}-region-${index + 1}`,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    })),
    strokes: Array.from({ length: record.strokeCount ?? 0 }, (_unused, index) => ({
      id: `${record.contextId}-stroke-${index + 1}`,
      color: "",
      width: 0,
      points: [],
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    })),
    styleChanges:
      record.styleChangeDetails ??
      record.styleChanges.flatMap((change) => {
        const match = /^(.+?): ([\s\S]*?) → ([\s\S]*)$/.exec(change);
        if (!match) return [];
        return [
          {
            targetId: record.elementIds?.[0] ?? `${record.contextId}-element-1`,
            selector: null,
            property: match[1]!,
            previousValue: match[2] === "(unset)" ? "" : match[2]!,
            value: match[3]!,
          },
        ];
      }),
    screenshot: null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Whether two records carry the same payload, ignoring the label (display text, never
 * identity). Context ids are a folded form of producer ids, so a collision alone does not mean
 * the records are the same excerpt; the paste path compares payloads before de-duplicating.
 */
export function isSameComposerContextPayload(
  left: ComposerContextRecord,
  right: ComposerContextRecord,
): boolean {
  if (left.kind !== right.kind) return false;
  const stableKey = (record: ComposerContextRecord) => {
    const { label: _label, ...rest } = record;
    const sortDeep = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sortDeep);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value)
          .toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
          .map(([key, nested]) => [key, sortDeep(nested)]),
      );
    };
    return JSON.stringify(sortDeep(rest));
  };
  return stableKey(left) === stableKey(right);
}
