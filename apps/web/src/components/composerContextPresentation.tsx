import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  CircleDashedIcon,
  FileIcon,
  ImageIcon,
  MessageCircleIcon,
  MousePointerClickIcon,
} from "lucide-react";
import { createContext, type ReactElement, use } from "react";

import type { ComposerFileAttachment, ComposerImageAttachment } from "~/composerDraftStore";
import { composerFileNeedsReattach } from "~/composerDraftStore";
import {
  formatAttachmentUploadProgress,
  type AttachmentUploadState,
} from "~/lib/attachmentUploadState";
import { cn } from "~/lib/utils";
import {
  fileContextReference,
  imageContextReference,
  previewAnnotationContextId,
  previewAnnotationContextLabel,
  reviewCommentContextId,
  reviewCommentContextLabel,
  terminalContextReference,
  uploadedAttachmentContextRecord,
} from "~/lib/composerContextRecords";
import type { TerminalContextDraft } from "~/lib/terminalContext";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { ComposerPendingTerminalContextChip } from "./chat/ComposerPendingTerminalContexts";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "./composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Draft-side payload behind a context reference chip. Each kind keeps its existing draft
 * shape; the editor only needs a way to look one up by id.
 */
export type ComposerDraftContextRecord =
  | { kind: "terminal"; record: TerminalContextDraft }
  | { kind: "review-comment"; record: ReviewCommentContext }
  | { kind: "preview-annotation"; record: PreviewAnnotationPayload }
  | { kind: "image"; record: ComposerImageAttachment; upload?: AttachmentUploadState | undefined }
  | { kind: "file"; record: ComposerFileAttachment; upload?: AttachmentUploadState | undefined };

/** What a chip can do beyond showing itself; the composer supplies the handlers. */
export interface ComposerContextActions {
  expandImage: (imageId: string) => void;
}

export const ComposerContextActionsContext = createContext<ComposerContextActions>({
  expandImage: () => {},
});

export type ComposerDraftContextRecords = ReadonlyMap<string, ComposerDraftContextRecord>;

export const EMPTY_COMPOSER_CONTEXT_RECORDS: ComposerDraftContextRecords = new Map();

export function uploadedContextRecordFromDraft(entry: ComposerDraftContextRecord) {
  if (entry.kind !== "image" && entry.kind !== "file") return null;
  return uploadedAttachmentContextRecord(entry.record, entry.upload);
}

export const ComposerContextRecordsContext = createContext<ComposerDraftContextRecords>(
  EMPTY_COMPOSER_CONTEXT_RECORDS,
);

export function composerContextRecordsFromDraft(input: {
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  reviewComments?: ReadonlyArray<ReviewCommentContext>;
  previewAnnotations?: ReadonlyArray<PreviewAnnotationPayload>;
  images?: ReadonlyArray<ComposerImageAttachment>;
  files?: ReadonlyArray<ComposerFileAttachment>;
  uploadsByImageId?: Readonly<Record<string, AttachmentUploadState>>;
}): ComposerDraftContextRecords {
  const records = new Map<string, ComposerDraftContextRecord>();
  for (const record of input.images ?? []) {
    records.set(imageContextReference(record).contextId, {
      kind: "image",
      record,
      upload: input.uploadsByImageId?.[record.id],
    });
  }
  for (const record of input.files ?? []) {
    records.set(fileContextReference(record).contextId, {
      kind: "file",
      record,
      upload: input.uploadsByImageId?.[record.id],
    });
  }
  for (const record of input.terminalContexts) {
    records.set(terminalContextReference(record).contextId, { kind: "terminal", record });
  }
  for (const record of input.reviewComments ?? []) {
    records.set(reviewCommentContextId(record.id), { kind: "review-comment", record });
  }
  for (const record of input.previewAnnotations ?? []) {
    records.set(previewAnnotationContextId(record.id), { kind: "preview-annotation", record });
  }
  return records;
}

function ContextChip(props: {
  icon: ReactElement;
  label: string;
  kindLabel: string;
  tooltip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={COMPOSER_INLINE_CHIP_CLASS_NAME}
            tabIndex={props.tooltip ? 0 : undefined}
            aria-label={`${props.kindLabel}, ${props.label}`}
          >
            {props.icon}
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.label}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {props.tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

function uploadStatusSuffix(upload: AttachmentUploadState | undefined): string | null {
  if (upload?.status === "uploading") return formatAttachmentUploadProgress(upload.progress);
  if (upload?.status === "failed") return "upload failed";
  return null;
}

function attachmentTooltip(
  attachment: ComposerImageAttachment | ComposerFileAttachment,
  upload: AttachmentUploadState | undefined,
): string {
  const lines = [attachment.name, formatAttachmentSize(attachment.sizeBytes)];
  if (upload?.status === "failed") lines.push("", upload.reason);
  return lines.join("\n");
}

function ImageContextChip(props: {
  record: ComposerImageAttachment;
  upload: AttachmentUploadState | undefined;
}) {
  const actions = use(ComposerContextActionsContext);
  const suffix = uploadStatusSuffix(props.upload);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "cursor-zoom-in")}
            aria-label={`Image attachment, ${props.record.name}`}
            onClick={() => actions.expandImage(props.record.id)}
          >
            {props.record.previewUrl ? (
              <img
                src={props.record.previewUrl}
                alt=""
                className="size-3.5 shrink-0 rounded-sm object-cover"
              />
            ) : (
              <ImageIcon className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3.5")} />
            )}
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.record.name}</span>
            {suffix ? <span className="text-[10px] text-muted-foreground">{suffix}</span> : null}
          </button>
        }
      />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
        {attachmentTooltip(props.record, props.upload)}
      </TooltipPopup>
    </Tooltip>
  );
}

function FileContextChip(props: {
  record: ComposerFileAttachment;
  upload: AttachmentUploadState | undefined;
}) {
  const needsReattach = composerFileNeedsReattach(props.record);
  const suffix = needsReattach ? "attach again" : uploadStatusSuffix(props.upload);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              COMPOSER_INLINE_CHIP_CLASS_NAME,
              needsReattach && "border-dashed text-muted-foreground",
              props.upload?.status === "failed" &&
                "border-destructive/35 bg-destructive/8 text-destructive",
            )}
            aria-label={`File attachment, ${props.record.name}`}
            data-context-unresolved={needsReattach ? "true" : undefined}
          >
            <FileIcon className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3.5")} />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.record.name}</span>
            {suffix ? <span className="text-[10px] opacity-80">{suffix}</span> : null}
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
        {needsReattach
          ? `${props.record.name} was not saved with this draft. Attach it again to send it.`
          : attachmentTooltip(props.record, props.upload)}
      </TooltipPopup>
    </Tooltip>
  );
}

function reviewCommentTooltip(comment: ReviewCommentContext): string {
  const lines = [`${comment.filePath} ${comment.rangeLabel}`];
  if (comment.text.trim()) lines.push("", comment.text.trim());
  return lines.join("\n");
}

function previewAnnotationTooltip(annotation: PreviewAnnotationPayload): string {
  const lines = [annotation.pageTitle?.trim() || annotation.pageUrl];
  if (annotation.comment.trim()) lines.push("", annotation.comment.trim());
  const targets: string[] = [];
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  if (annotation.elements.length > 0) targets.push(plural(annotation.elements.length, "element"));
  if (annotation.regions.length > 0) targets.push(plural(annotation.regions.length, "region"));
  if (annotation.strokes.length > 0) targets.push(plural(annotation.strokes.length, "drawing"));
  if (annotation.styleChanges.length > 0) {
    targets.push(plural(annotation.styleChanges.length, "style change"));
  }
  if (targets.length > 0) lines.push("", targets.join(", "));
  return lines.join("\n");
}

function UnresolvedContextChip(props: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "border-dashed text-muted-foreground")}
            aria-label={`Unavailable context, ${props.label}`}
            data-context-unresolved="true"
          >
            <CircleDashedIcon className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3.5")} />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.label}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-80 leading-tight">
        This context is no longer available. Remove it or attach it again.
      </TooltipPopup>
    </Tooltip>
  );
}

/** Compact chip for one reference. Unknown kinds and missing records get the unresolved chip. */
export function ComposerContextReferenceChip(props: {
  kind: string;
  contextId: string;
  label: string;
}): ReactElement {
  const records = use(ComposerContextRecordsContext);
  const entry = records.get(props.contextId);
  if (entry?.kind === "terminal" && props.kind === "terminal") {
    return <ComposerPendingTerminalContextChip context={entry.record} />;
  }
  if (entry?.kind === "image" && props.kind === "image") {
    return <ImageContextChip record={entry.record} upload={entry.upload} />;
  }
  if (entry?.kind === "file" && props.kind === "file") {
    return <FileContextChip record={entry.record} upload={entry.upload} />;
  }
  if (entry?.kind === "review-comment" && props.kind === "review-comment") {
    return (
      <ContextChip
        icon={
          <MessageCircleIcon className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3.5")} />
        }
        label={reviewCommentContextLabel(entry.record)}
        kindLabel="Review comment"
        tooltip={reviewCommentTooltip(entry.record)}
      />
    );
  }
  if (entry?.kind === "preview-annotation" && props.kind === "preview-annotation") {
    return (
      <ContextChip
        icon={
          <MousePointerClickIcon className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3.5")} />
        }
        label={previewAnnotationContextLabel(entry.record)}
        kindLabel="Preview annotation"
        tooltip={previewAnnotationTooltip(entry.record)}
      />
    );
  }
  return <UnresolvedContextChip label={props.label} />;
}
