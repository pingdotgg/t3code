import type { ProjectKnowledgeContextRecord } from "@t3tools/contracts";
import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import {
  COMPOSER_CONTEXT_PREVIEW_COMMENT_MAX_CHARS,
  COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS,
  COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS,
  COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS,
} from "@t3tools/contracts";
import type {
  ChatFileAttachment,
  ChatImageAttachment,
  ComposerContextId,
  ComposerContextRecord,
  EnvironmentContextRecord,
  EnvironmentId,
  FileContextRecord,
  ImageContextRecord,
  KnownComposerContextRecord,
  MessageId,
  OrchestrationMessageContext,
  PreviewAnnotationContextRecord,
  PreviewAnnotationPayload,
  ResponseContextRecord,
  ReviewCommentContextRecord,
  TerminalContextRecord,
  ThreadContextRecord,
  ThreadId,
} from "@t3tools/contracts";
import { decodeMsg, msg } from "gt-react";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";

import {
  type ComposerContextReference,
  producerIdFromComposerContextId,
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
import type { MessageResolver } from "~/i18n/messages";
import { changeRequestTermKind } from "~/components/pullRequest/changeRequestTerm";

const PREVIEW_LABEL_MAX_CHARS = 48;
const RESPONSE_LABEL_MAX_CHARS = 64;

// Truncate selections to wire bounds before persistence to avoid send-time encoding failures.
const TRUNCATION_MARKER = "\n… truncated …";

function clampContextText(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max - TRUNCATION_MARKER.length);
  // Never end on a lone high surrogate.
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}${TRUNCATION_MARKER}`;
}

type ReviewCommentPresentation = ReviewCommentContext | ReviewCommentContextRecord;

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? filePath;
}

function diffRangeLabel(
  start: string,
  end: string | undefined,
  before: boolean,
  resolve: MessageResolver | undefined,
): string {
  if (resolve === undefined) {
    return `L${start}${end ? ` to L${end}` : ""}${before ? " (before)" : ""}`;
  }
  if (end === undefined) {
    return before
      ? resolve(msg("L{start} (before)", { $context: "line in the old version of a diff" }), {
          start,
        })
      : `L${start}`;
  }
  return before
    ? resolve(
        msg("L{start} to L{end} (before)", { $context: "line range in the old version of a diff" }),
        { start, end },
      )
    : resolve(msg("L{start} to L{end}", { $context: "line range in a diff" }), { start, end });
}

/** Without `resolve` the label stays English, for records sent to the agent. */
export function reviewCommentContextLabel(
  comment: ReviewCommentPresentation,
  resolve?: MessageResolver,
): string {
  const pullRequestNumber = pullRequestContextNumber(comment);
  if (isPullRequestSummaryContext(comment) && pullRequestNumber !== null) {
    return `#${pullRequestNumber}`;
  }
  const diffRange = /^([+-])(\d+)(?: to \1(\d+))?$/u.exec(comment.rangeLabel);
  const rangeLabel = diffRange
    ? diffRangeLabel(diffRange[2]!, diffRange[3], diffRange[1] === "-", resolve)
    : comment.rangeLabel;
  const sectionPullRequest = /^pull-request:(\d+)$/u.exec(comment.sectionId)?.[1];
  const prefix = sectionPullRequest === undefined ? "" : `#${sectionPullRequest} `;
  return `${prefix}${basename(comment.filePath)} ${rangeLabel}`;
}

const REVIEW_SECTION_TITLES: ReadonlyMap<string, string> = new Map([
  ["File comment", msg("File comment")],
  ["Review guide", msg("Review guide")],
]);

/** A stored review comment `sectionTitle` for display; the record itself stays English. */
export function reviewCommentSectionText(sectionTitle: string, resolve: MessageResolver): string {
  const known = REVIEW_SECTION_TITLES.get(sectionTitle);
  if (known !== undefined) return resolve(known);
  const number = /^PR #(\d+) review$/u.exec(sectionTitle)?.[1];
  return number === undefined ? sectionTitle : resolve(msg("PR #{number} review", { number }));
}

/** A stored `rangeLabel` such as "+12 to +15" or "L3 to L9" for display. */
export function reviewCommentRangeText(rangeLabel: string, resolve: MessageResolver): string {
  const range = /^([+-]?L?\d+) to ([+-]?L?\d+)$/u.exec(rangeLabel);
  return range === null
    ? rangeLabel
    : resolve(msg("{start} to {end}", { $context: "a range of lines in a file or diff" }), {
        start: range[1]!,
        end: range[2]!,
      });
}

/** A preview annotation record's `targetSummary` rebuilt in the UI language when it has counts. */
export function previewAnnotationTargetText(
  record: Pick<
    PreviewAnnotationContextRecord,
    "targetSummary" | "elementIds" | "regionCount" | "strokeCount"
  >,
  resolve: MessageResolver,
): string {
  const parts: string[] = [];
  // The stored summary also counts selected elements whose details failed to normalize.
  const summaryElements = /^(\d+) selected elements?\b/.exec(record.targetSummary)?.[1];
  const elements =
    summaryElements === undefined ? (record.elementIds?.length ?? 0) : Number(summaryElements);
  if (elements > 0) {
    parts.push(
      resolve(
        msg("{count, plural, one {{count} selected element} other {{count} selected elements}}", {
          count: elements,
        }),
      ),
    );
  }
  if ((record.regionCount ?? 0) > 0) {
    parts.push(
      resolve(
        msg("{count, plural, one {{count} marked region} other {{count} marked regions}}", {
          count: record.regionCount!,
        }),
      ),
    );
  }
  if ((record.strokeCount ?? 0) > 0) {
    parts.push(
      resolve(
        msg("{count, plural, one {{count} drawing} other {{count} drawings}}", {
          count: record.strokeCount!,
        }),
      ),
    );
  }
  // Older records carry only the English summary.
  return parts.length === 0 ? record.targetSummary : parts.join(", ");
}

export function isPullRequestSummaryContext(comment: ReviewCommentPresentation): boolean {
  if (comment.pullRequest !== undefined) return true;
  return (
    comment.sectionId.startsWith("pull-request:") &&
    comment.diff.trim().length === 0 &&
    /^PR #\d+$/u.test(comment.filePath)
  );
}

function pullRequestContextNumber(comment: ReviewCommentPresentation): number | null {
  if (comment.pullRequest !== undefined) return comment.pullRequest.number;
  const legacyNumber = /^PR #(\d+)$/u.exec(comment.filePath)?.[1];
  return legacyNumber === undefined ? null : Number(legacyNumber);
}

export type PullRequestContextDisplayState = "open" | "draft" | "merged" | "closed";

export function pullRequestContextDisplayState(
  comment: ReviewCommentPresentation,
): PullRequestContextDisplayState | null {
  const pullRequest = comment.pullRequest;
  if (pullRequest === undefined) return null;
  return pullRequest.state === "open" && pullRequest.isDraft ? "draft" : pullRequest.state;
}

/** Without `resolve` the label stays English. */
export function pullRequestContextKindLabel(
  comment: ReviewCommentPresentation,
  resolve?: MessageResolver,
): string {
  const url = comment.pullRequest?.url;
  const host = url === undefined ? null : sourceControlClients.findByChangeRequestUrl(url);
  const term = (host ?? sourceControlClients.get(undefined)).changeRequest.singular;
  const state = pullRequestContextDisplayState(comment);
  if (resolve !== undefined) {
    const variables = { term: changeRequestTermKind({ singular: term }) };
    switch (state) {
      case null:
        return resolve(
          msg("{term, select, mr {Merge request} cr {Change request} other {Pull request}}"),
          variables,
        );
      case "open":
        return resolve(
          msg(
            "{term, select, mr {Open merge request} cr {Open change request} other {Open pull request}}",
          ),
          variables,
        );
      case "draft":
        return resolve(
          msg(
            "{term, select, mr {Draft merge request} cr {Draft change request} other {Draft pull request}}",
          ),
          variables,
        );
      case "merged":
        return resolve(
          msg(
            "{term, select, mr {Merged merge request} cr {Merged change request} other {Merged pull request}}",
          ),
          variables,
        );
      case "closed":
        return resolve(
          msg(
            "{term, select, mr {Closed merge request} cr {Closed change request} other {Closed pull request}}",
          ),
          variables,
        );
    }
  }
  if (state === null) return capitalizeTerm(term);
  return `${capitalizeTerm(state)} ${term}`;
}

/** Without `resolve` the fallback stays English, for records sent to the agent. */
export function previewAnnotationContextLabel(
  annotation: PreviewAnnotationPayload,
  resolve?: MessageResolver,
): string {
  const comment = annotation.comment.trim().replace(/\s+/g, " ");
  if (comment) {
    if (comment.length <= PREVIEW_LABEL_MAX_CHARS) return comment;
    let end = PREVIEW_LABEL_MAX_CHARS - 1;
    const previous = comment.charCodeAt(end - 1);
    const next = comment.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    return `${comment.slice(0, end).trimEnd()}…`;
  }
  const fallback = msg("Preview annotation");
  return annotation.pageTitle?.trim() || (resolve ? resolve(fallback) : decodeMsg(fallback));
}

export function terminalContextReference(context: TerminalContextDraft): ComposerContextReference {
  return {
    kind: "terminal",
    contextId: toKindScopedComposerContextId("terminal", context.id),
    label: formatTerminalContextLabel(context),
  };
}

export function reviewCommentContextId(commentId: string): ComposerContextId {
  return toKindScopedComposerContextId("review-comment", commentId);
}

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

export function threadContextReference(record: ThreadContextRecord): ComposerContextReference {
  return { kind: "thread", contextId: record.contextId, label: record.label };
}

export function isResponseContextRecord(
  record: ComposerContextRecord,
): record is ResponseContextRecord {
  return record.kind === "response" && "citation" in record;
}

export function responseContextReference(record: ResponseContextRecord): ComposerContextReference {
  return { kind: "response", contextId: record.contextId, label: record.label };
}

function responseContextLabel(text: string): string {
  const last = text.charCodeAt(RESPONSE_LABEL_MAX_CHARS - 1);
  const end =
    last >= 0xd800 && last <= 0xdbff ? RESPONSE_LABEL_MAX_CHARS - 1 : RESPONSE_LABEL_MAX_CHARS;
  return sanitizeComposerContextLabel(text.slice(0, end), "response");
}

/** One record per response, so replying to it again reuses the same reference. */
export function responseContextRecord(
  input: Pick<ResponseContextRecord, "citation" | "itemId"> & {
    readonly subagents: ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly title: string;
      readonly environmentId?: EnvironmentId;
    }>;
  },
): ResponseContextRecord {
  return {
    version: 1,
    kind: "response",
    contextId: toKindScopedComposerContextId("response", input.citation.messageId),
    label: responseContextLabel(input.citation.text),
    citation: input.citation,
    itemId: input.itemId,
    ...(input.subagents.length > 0
      ? {
          subagents: input.subagents.slice(0, 20).map(({ title, ...subagent }) => ({
            ...subagent,
            title: sanitizeComposerContextLabel(title, "response"),
          })),
        }
      : {}),
  };
}

/** One record per machine: mentioning the same machine twice reuses the chip. */
export function environmentContextReference(
  record: EnvironmentContextRecord,
): ComposerContextReference {
  return { kind: "environment", contextId: record.contextId, label: record.label };
}

export function environmentContextRecord(
  environmentId: EnvironmentId,
  label: string,
): EnvironmentContextRecord {
  return {
    version: 1,
    kind: "environment",
    contextId: toKindScopedComposerContextId("environment", environmentId),
    label: sanitizeComposerContextLabel(label, "environment"),
    environmentId,
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
    text: clampContextText(
      normalizeTerminalContextText(context.text),
      COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS,
    ),
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

// Stored in the record and read by the agent, so it stays English.
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
    comment: clampContextText(
      annotation.comment.trim(),
      COMPOSER_CONTEXT_PREVIEW_COMMENT_MAX_CHARS,
    ),
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

export type ComposerContextAttachment =
  | ComposerImageAttachment
  | ComposerFileAttachment
  | (Omit<ComposerImageAttachment, "file"> & {
      readonly file: File | null;
      readonly uploadedAttachmentId?: string | undefined;
    })
  | ChatImageAttachment
  | ChatFileAttachment;

export interface BoundComposerAttachment {
  attachment: ComposerContextAttachment;
  attachmentId: string;
  contextId?: ComposerContextId | undefined;
}

/** Returns null until the attachment has a server id. */
export function uploadedAttachmentContextRecord(
  attachment: ComposerContextAttachment,
  upload: AttachmentUploadState | undefined,
  contextId?: ComposerContextId,
): ImageContextRecord | FileContextRecord | null {
  const attachmentId =
    "uploadedAttachmentId" in attachment && attachment.uploadedAttachmentId !== undefined
      ? attachment.uploadedAttachmentId
      : upload?.status === "ready"
        ? upload.attachmentId
        : undefined;
  return attachmentId === undefined
    ? null
    : attachmentContextRecord({ attachment, attachmentId, contextId });
}

export function attachmentContextRecord(
  bound: BoundComposerAttachment,
): ImageContextRecord | FileContextRecord {
  const { attachment, attachmentId, contextId } = bound;
  const base = {
    version: 1 as const,
    contextId: contextId ?? toKindScopedComposerContextId(attachment.type, attachment.id),
    label: sanitizeComposerContextLabel(attachment.name, attachment.type),
    attachmentId,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
  return attachment.type === "image"
    ? {
        ...base,
        kind: "image",
        ...(attachment.source !== undefined ? { source: attachment.source } : {}),
      }
    : { ...base, kind: "file" };
}

export function buildMessageContext(input: {
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  reviewComments: ReadonlyArray<ReviewCommentContext>;
  previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  threadContexts?: ReadonlyArray<ThreadContextRecord>;
  knowledgeContexts?: ReadonlyArray<ProjectKnowledgeContextRecord>;
  environmentContexts?: ReadonlyArray<EnvironmentContextRecord>;
  replyTo?: ResponseContextRecord | null;
  attachments?: ReadonlyArray<BoundComposerAttachment>;
}): OrchestrationMessageContext | undefined {
  const screenshotAttachmentIds = new Set(
    (input.attachments ?? []).flatMap(({ attachment }) =>
      attachment.type === "image" ? [attachment.id] : [],
    ),
  );
  const records: ComposerContextRecord[] = [
    ...input.terminalContexts.map(terminalContextRecord),
    ...input.reviewComments.map(reviewCommentContextRecord),
    ...(input.threadContexts ?? []),
    ...(input.knowledgeContexts ?? []),
    ...(input.environmentContexts ?? []),
    ...(input.replyTo ? [input.replyTo] : []),
    ...input.previewAnnotations.map((annotation) =>
      previewAnnotationContextRecord(annotation, {
        screenshotContextId: screenshotAttachmentIds.has(annotation.id) ? annotation.id : undefined,
      }),
    ),
    ...(input.attachments ?? []).map(attachmentContextRecord),
  ];
  return records.length === 0 ? undefined : { version: 1, records };
}

export function asKnownContextRecord(
  record: ComposerContextRecord | undefined,
): KnownComposerContextRecord | undefined {
  if (!record || "payload" in record) return undefined;
  return record;
}

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

export function selectedMessageContextFragment(input: {
  readonly markdown: string;
  readonly records: ReadonlyArray<ComposerContextRecord>;
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly messageId: MessageId;
}): string | null {
  const selectedIds = new Set(
    collectComposerContextReferences(input.markdown).map((occurrence) => occurrence.contextId),
  );
  const records = input.records.filter((record) => selectedIds.has(record.contextId));
  if (records.length === 0) return null;
  return encodeComposerContextFragment({
    version: 1,
    source: {
      environmentId: input.environmentId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      messageId: input.messageId,
    },
    records,
  });
}

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

/** Labels are display-only; folded ids can collide, so paste deduplication compares payloads. */
export function isSameComposerContextPayload(
  left: ComposerContextRecord,
  right: ComposerContextRecord,
): boolean {
  if (left.kind !== right.kind) return false;
  const stableKey = (record: ComposerContextRecord) => {
    const { label: _label, contextId: _contextId, ...rest } = record;
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
