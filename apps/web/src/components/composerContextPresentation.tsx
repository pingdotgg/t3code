import ChatMarkdown from "./ChatMarkdown";
import { ReadOnlySourcePreview } from "./files/AttachmentFilePreview";
import type { PreviewAnnotationPayload, ThreadContextRecord } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { videoMimeType } from "@t3tools/shared/video";
import { MessageCircleIcon, MousePointerClickIcon } from "lucide-react";
import { createContext, type MouseEvent, type ReactElement, type ReactNode, use } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import type { ComposerFileAttachment, ComposerImageAttachment } from "~/composerDraftStore";
import { composerFileNeedsReattach } from "~/composerDraftStore";
import { useTheme } from "~/hooks/useTheme";
import {
  formatAttachmentUploadProgress,
  type AttachmentUploadState,
} from "~/lib/attachmentUploadState";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import {
  fileContextReference,
  imageContextReference,
  isPullRequestSummaryContext,
  pullRequestContextDisplayState,
  pullRequestContextKindLabel,
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
import { ThreadContextChip } from "./ThreadContextChip";
import {
  createContextPresentationRegistry,
  type ContextPresentationCapability,
} from "./contextPresentationRegistry";
import type { ContextChipKind } from "./ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  ContextChipPopover,
  ContextChipShell,
  FileChip,
  ImageChipButton,
  PULL_REQUEST_CHIP_KINDS,
  PullRequestChip,
  UnresolvedChip,
} from "./contextChipParts";

/**
 * Draft-side payload behind a context reference chip. Each kind keeps its existing draft
 * shape; the editor only needs a way to look one up by id.
 */
export type ComposerDraftContextRecord =
  | { kind: "terminal"; record: TerminalContextDraft }
  | { kind: "review-comment"; record: ReviewCommentContext }
  | { kind: "preview-annotation"; record: PreviewAnnotationPayload }
  | { kind: "image"; record: ComposerImageAttachment; upload?: AttachmentUploadState | undefined }
  | { kind: "file"; record: ComposerFileAttachment; upload?: AttachmentUploadState | undefined }
  | { kind: "thread"; record: ThreadContextRecord };

/** What a chip can do beyond showing itself; the composer supplies the handlers. */
export interface ComposerContextActions {
  environmentId: EnvironmentId | null;
  expandImage: (imageId: string) => void;
  expandVideo: (fileId: string) => void;
  openFile: (fileId: string) => void;
  openMention: (path: string) => void;
  openPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
}

export const ComposerContextActionsContext = createContext<ComposerContextActions>({
  environmentId: null,
  expandImage: () => {},
  expandVideo: () => {},
  openFile: () => {},
  openMention: () => {},
  openPullRequest: () => {},
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
  threadContexts?: ReadonlyArray<ThreadContextRecord>;
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
  for (const record of input.threadContexts ?? []) {
    records.set(record.contextId, { kind: "thread", record });
  }
  return records;
}

function ContextChip(props: {
  icon: ReactElement;
  label: string;
  kindLabel: string;
  details: ReactNode;
  detailsMode: ContextPresentationCapability["details"];
  kind: ContextChipKind;
}) {
  if (props.detailsMode === "popover") {
    return (
      <ContextChipPopover
        kind={props.kind}
        icon={props.icon}
        label={props.label}
        accessibleLabel={props.kindLabel + ", " + props.label}
      >
        {props.details}
      </ContextChipPopover>
    );
  }
  return (
    <ContextChipShell
      kind={props.kind}
      icon={props.icon}
      label={props.label}
      aria-label={
        props.detailsMode === "tooltip" ? `${props.kindLabel}, ${props.label}` : undefined
      }
      tooltip={props.detailsMode === "tooltip" ? props.details : undefined}
    />
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
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ImageChipButton
            name={props.record.name}
            previewUrl={props.record.previewUrl}
            size={formatAttachmentSize(props.record.sizeBytes)}
            suffix={uploadStatusSuffix(props.upload)}
            onClick={() => actions.expandImage(props.record.id)}
          />
        }
      />
      <TooltipPopup side="top" className="whitespace-pre-wrap">
        {attachmentTooltip(props.record, props.upload)}
      </TooltipPopup>
    </Tooltip>
  );
}

function FileContextChip(props: {
  record: ComposerFileAttachment;
  upload: AttachmentUploadState | undefined;
}) {
  const actions = use(ComposerContextActionsContext);
  const { resolvedTheme } = useTheme();
  const needsReattach = composerFileNeedsReattach(props.record);
  const suffix = needsReattach ? "attach again" : uploadStatusSuffix(props.upload);
  const size = formatAttachmentSize(props.record.sizeBytes);
  const isVideo = videoMimeType(props.record) !== null;
  return (
    <FileChip
      name={props.record.name}
      size={size}
      isVideo={isVideo}
      theme={resolvedTheme}
      error={props.upload?.status === "failed"}
      unresolved={needsReattach}
      suffix={suffix}
      accessibleLabel={`${isVideo && !needsReattach ? "Preview video" : "File"} attachment, ${props.record.name}, ${size}`}
      onOpen={
        !needsReattach
          ? () =>
              isVideo ? actions.expandVideo(props.record.id) : actions.openFile(props.record.id)
          : undefined
      }
      tooltip={
        needsReattach
          ? `${props.record.name} was not saved with this draft. Attach it again to send it.`
          : attachmentTooltip(props.record, props.upload)
      }
    />
  );
}

function PullRequestContextChip(props: { record: ReviewCommentContext; kind: ContextChipKind }) {
  const actions = use(ComposerContextActionsContext);
  const metadata = props.record.pullRequest;
  if (metadata === undefined) return null;
  return (
    <PullRequestChip
      metadata={metadata}
      environmentId={actions.environmentId}
      label={reviewCommentContextLabel(props.record)}
      kindLabel={pullRequestContextKindLabel(props.record)}
      kind={props.kind}
      onOpen={actions.openPullRequest}
    />
  );
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

function ComposerReviewCommentDetails({ comment }: { comment: ReviewCommentContext }) {
  return (
    <div className="space-y-2 overflow-hidden rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="truncate text-xs font-medium text-foreground">{comment.filePath}</div>
        <div className="text-secondary-label text-2xs">
          {comment.sectionTitle} · {comment.rangeLabel}
        </div>
      </div>
      {comment.text.trim() ? <ChatMarkdown text={comment.text.trim()} cwd={undefined} /> : null}
      {comment.diff.trim() ? (
        <div className="flex h-64 min-h-0 flex-col overflow-hidden rounded-md border border-border">
          <ReadOnlySourcePreview name="review.diff" text={comment.diff} />
        </div>
      ) : null}
    </div>
  );
}

function ComposerPreviewAnnotationDetails({
  annotation,
}: {
  annotation: PreviewAnnotationPayload;
}) {
  const summary = previewAnnotationTooltip(annotation);
  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {annotation.screenshot?.dataUrl ? (
        <img
          src={annotation.screenshot.dataUrl}
          alt="Annotated preview crop"
          className="max-h-64 w-full border-border/70 border-b bg-muted object-contain"
        />
      ) : (
        <div className="border-border/70 border-b bg-muted/40 px-3 py-2 text-secondary-label text-xs">
          Screenshot unavailable
        </div>
      )}
      <div className="whitespace-pre-wrap wrap-break-word px-3 py-2.5 text-sm text-foreground">
        {summary}
      </div>
    </div>
  );
}

function UnresolvedContextChip(props: { label: string }) {
  return (
    <UnresolvedChip
      label={props.label}
      tooltip="This context is no longer available. Remove it or attach it again."
    />
  );
}

interface ComposerContextRenderContext {
  label: string;
}

const composerContextPresentationRegistry = createContextPresentationRegistry<
  ComposerDraftContextRecord,
  ComposerContextRenderContext,
  ReactElement
>({
  requiredKinds: ["image", "file", "terminal", "review-comment", "preview-annotation", "thread"],
  handlers: [
    {
      kind: "terminal",
      canRender: (entry) => entry.kind === "terminal",
      render: (entry, context, definition) =>
        entry.kind === "terminal" ? (
          <ComposerPendingTerminalContextChip
            context={entry.record}
            detailsMode={definition.capabilities.details}
          />
        ) : (
          <UnresolvedContextChip label={context.label} />
        ),
    },
    {
      kind: "image",
      canRender: (entry) => entry.kind === "image",
      render: (entry, context) =>
        entry.kind === "image" ? (
          <ImageContextChip record={entry.record} upload={entry.upload} />
        ) : (
          <UnresolvedContextChip label={context.label} />
        ),
    },
    {
      kind: "file",
      canRender: (entry) => entry.kind === "file",
      render: (entry, context) =>
        entry.kind === "file" ? (
          <FileContextChip record={entry.record} upload={entry.upload} />
        ) : (
          <UnresolvedContextChip label={context.label} />
        ),
    },
    {
      kind: "review-comment",
      canRender: (entry) => entry.kind === "review-comment",
      render: (entry, context, definition) => {
        if (entry.kind !== "review-comment") {
          return <UnresolvedContextChip label={context.label} />;
        }
        const isPullRequest = isPullRequestSummaryContext(entry.record);
        const pullRequestState = pullRequestContextDisplayState(entry.record) ?? "unknown";
        if (isPullRequest && entry.record.pullRequest !== undefined) {
          return (
            <PullRequestContextChip
              record={entry.record}
              kind={PULL_REQUEST_CHIP_KINDS[pullRequestState]}
            />
          );
        }
        return (
          <ContextChip
            icon={isPullRequest ? <PullRequestGlyph.pullRequest /> : <MessageCircleIcon />}
            label={reviewCommentContextLabel(entry.record)}
            kindLabel={isPullRequest ? pullRequestContextKindLabel(entry.record) : "Review comment"}
            details={<ComposerReviewCommentDetails comment={entry.record} />}
            detailsMode={definition.capabilities.details}
            kind={isPullRequest ? PULL_REQUEST_CHIP_KINDS[pullRequestState] : "review-comment"}
          />
        );
      },
    },
    {
      kind: "preview-annotation",
      canRender: (entry) => entry.kind === "preview-annotation",
      render: (entry, context, definition) =>
        entry.kind === "preview-annotation" ? (
          <ContextChip
            icon={<MousePointerClickIcon />}
            label={previewAnnotationContextLabel(entry.record)}
            kindLabel="Preview annotation"
            details={<ComposerPreviewAnnotationDetails annotation={entry.record} />}
            detailsMode={definition.capabilities.details}
            kind="preview-annotation"
          />
        ) : (
          <UnresolvedContextChip label={context.label} />
        ),
    },
    {
      kind: "thread",
      canRender: (entry) => entry.kind === "thread",
      render: (entry, context) =>
        entry.kind === "thread" ? (
          <ThreadContextChip record={entry.record} />
        ) : (
          <UnresolvedContextChip label={context.label} />
        ),
    },
  ],
  fallback: (_kind, _entry, context) => <UnresolvedContextChip label={context.label} />,
});

/** Compact chip for one reference. Unknown kinds and missing records use the registry fallback. */
export function ComposerContextReferenceChip(props: {
  kind: string;
  contextId: string;
  label: string;
}): ReactElement {
  const records = use(ComposerContextRecordsContext);
  return composerContextPresentationRegistry.render(props.kind, records.get(props.contextId), {
    label: props.label,
  });
}
