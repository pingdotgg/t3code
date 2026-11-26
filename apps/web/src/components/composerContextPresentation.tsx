import { ProjectKnowledgeContextChip } from "./projectKnowledge/ProjectKnowledgeContextChip";
import type { ProjectKnowledgeContextRecord } from "@t3tools/contracts";
import ChatMarkdown from "./ChatMarkdown";
import { isSvgAttachment } from "@t3tools/shared/image";
import { ReadOnlySourcePreview } from "./files/AttachmentFilePreview";
import type {
  ChatAttachment,
  ComposerContextId,
  EnvironmentContextRecord,
  EnvironmentId,
  PreviewAnnotationPayload,
  ThreadContextRecord,
} from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { videoMimeType } from "@t3tools/shared/video";
import { MessageCircleIcon, MousePointerClickIcon } from "lucide-react";
import { createContext, type ReactElement, type ReactNode, use } from "react";
import { msg, T, useGT, useMessages } from "gt-react";
import type { MessageResolver } from "../i18n/messages";
import { ComposerContextActionsContext } from "./composerContextActions";

import type { ComposerFileAttachment, ComposerImageAttachment } from "~/composerDraftStore";
import { composerFileNeedsReattach } from "~/composerDraftStore";
import { useTheme } from "~/hooks/useTheme";
import {
  attachmentUploadFailureText,
  type AttachmentUploadState,
} from "~/lib/attachmentUploadState";
import { useAttachmentUploadProgress } from "~/hooks/useAttachmentUploadProgress";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import {
  fileContextReference,
  imageContextReference,
  isPullRequestSummaryContext,
  previewAnnotationContextId,
  previewAnnotationContextLabel,
  pullRequestContextDisplayState,
  pullRequestContextKindLabel,
  reviewCommentContextId,
  reviewCommentContextLabel,
  reviewCommentRangeText,
  reviewCommentSectionText,
  terminalContextReference,
  uploadedAttachmentContextRecord,
} from "~/lib/composerContextRecords";
import type { TerminalContextDraft } from "~/lib/terminalContext";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { isQueuedFileAttachment, isQueuedImageAttachment } from "./chat/queuedMessageEdit";
import { ComposerPendingTerminalContextChip } from "./chat/ComposerPendingTerminalContexts";
import { EnvironmentContextChip } from "./EnvironmentContextChip";
import { ThreadContextChip } from "./ThreadContextChip";
import { useLinkedEnvironments } from "~/state/peerLinks";
import {
  createContextPresentationRegistry,
  type ContextPresentationCapability,
} from "./contextPresentationRegistry";
import type { ContextChipKind } from "./ContextChip";
import {
  ContextChipPopover,
  ContextChipShell,
  FileChip,
  ImageChipButton,
  PULL_REQUEST_CHIP_KINDS,
  PullRequestChip,
  UnresolvedChip,
} from "./contextChipParts";
import { SharedTooltipTrigger } from "./ui/shared-tooltip";

export interface ComposerImageContextAttachment extends Omit<ComposerImageAttachment, "file"> {
  readonly file: File | null;
  readonly uploadedAttachmentId?: string | undefined;
}

export type ComposerDraftContextRecord =
  | { kind: "terminal"; record: TerminalContextDraft }
  | { kind: "review-comment"; record: ReviewCommentContext }
  | {
      kind: "preview-annotation";
      record: PreviewAnnotationPayload;
      screenshot?: ComposerImageAttachment | undefined;
    }
  | {
      kind: "image";
      record: ComposerImageContextAttachment;
      upload?: AttachmentUploadState | undefined;
      contextId?: ComposerContextId | undefined;
    }
  | {
      kind: "file";
      record: ComposerFileAttachment;
      upload?: AttachmentUploadState | undefined;
      contextId?: ComposerContextId | undefined;
    }
  | { kind: "thread"; record: ThreadContextRecord }
  | { kind: "project-knowledge"; record: ProjectKnowledgeContextRecord }
  | { kind: "environment"; record: EnvironmentContextRecord };

export {
  ComposerContextActionsContext,
  type ComposerContextActions,
} from "./composerContextActions";

export const CHIP_NODE_SELECTION_CLASS_NAME =
  "relative inline-flex min-w-0 max-w-full select-none items-baseline data-[composer-chip-selected]:after:pointer-events-none data-[composer-chip-selected]:after:absolute data-[composer-chip-selected]:after:inset-0 data-[composer-chip-selected]:after:rounded-sm data-[composer-chip-selected]:after:bg-[Highlight] data-[composer-chip-selected]:after:opacity-30 data-[composer-chip-selected]:after:content-['']";

export type ComposerDraftContextRecords = ReadonlyMap<string, ComposerDraftContextRecord>;

export const EMPTY_COMPOSER_CONTEXT_RECORDS: ComposerDraftContextRecords = new Map();

export function uploadedContextRecordFromDraft(entry: ComposerDraftContextRecord) {
  if (entry.kind !== "image" && entry.kind !== "file") return null;
  return uploadedAttachmentContextRecord(entry.record, entry.upload, entry.contextId);
}

export const ComposerContextRecordsContext = createContext<ComposerDraftContextRecords>(
  EMPTY_COMPOSER_CONTEXT_RECORDS,
);

export function composerContextRecordsFromDraft(input: {
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  reviewComments?: ReadonlyArray<ReviewCommentContext>;
  previewAnnotations?: ReadonlyArray<PreviewAnnotationPayload>;
  threadContexts?: ReadonlyArray<ThreadContextRecord>;
  knowledgeContexts?: ReadonlyArray<ProjectKnowledgeContextRecord>;
  environmentContexts?: ReadonlyArray<EnvironmentContextRecord>;
  images?: ReadonlyArray<ComposerImageAttachment>;
  files?: ReadonlyArray<ComposerFileAttachment>;
  existingAttachments?:
    | ReadonlyArray<{
        readonly attachment: ChatAttachment;
        readonly url: string | null;
        readonly contextIds?: ReadonlyArray<ComposerContextId> | undefined;
      }>
    | undefined;
  environmentId?: EnvironmentId | undefined;
  uploadsByImageId?: Readonly<Record<string, AttachmentUploadState>>;
}): ComposerDraftContextRecords {
  const records = new Map<string, ComposerDraftContextRecord>();
  for (const entry of input.existingAttachments ?? []) {
    for (const contextId of entry.contextIds ?? []) {
      if (isQueuedImageAttachment(entry.attachment)) {
        records.set(contextId, {
          kind: "image",
          contextId,
          record: {
            ...entry.attachment,
            previewUrl: entry.url ?? "",
            file: null,
            uploadedAttachmentId: entry.attachment.id,
          },
        });
      } else if (isQueuedFileAttachment(entry.attachment)) {
        records.set(contextId, {
          kind: "file",
          contextId,
          record: {
            ...entry.attachment,
            file: null,
            uploadedAttachmentId: entry.attachment.id,
            ...(input.environmentId ? { uploadEnvironmentId: input.environmentId } : {}),
          },
        });
      }
    }
  }
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
  const imagesById = new Map((input.images ?? []).map((image) => [image.id, image]));
  for (const record of input.previewAnnotations ?? []) {
    records.set(previewAnnotationContextId(record.id), {
      kind: "preview-annotation",
      record,
      screenshot: imagesById.get(record.id),
    });
  }
  for (const record of input.knowledgeContexts ?? [])
    records.set(record.contextId, { kind: "project-knowledge", record });
  for (const record of input.threadContexts ?? []) {
    records.set(record.contextId, { kind: "thread", record });
  }
  for (const record of input.environmentContexts ?? []) {
    records.set(record.contextId, { kind: "environment", record });
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
  const m = useMessages();
  const kindLabel = m(props.kindLabel);
  if (props.detailsMode === "popover") {
    return (
      <ContextChipPopover
        kind={props.kind}
        icon={props.icon}
        label={props.label}
        accessibleLabel={kindLabel + ", " + props.label}
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
      aria-label={props.detailsMode === "tooltip" ? `${kindLabel}, ${props.label}` : undefined}
      tooltip={props.detailsMode === "tooltip" ? props.details : undefined}
    />
  );
}

function useUploadStatusSuffix(
  key: string,
  upload: AttachmentUploadState | undefined,
): string | null {
  const gt = useGT();
  const progress = useAttachmentUploadProgress(key, upload);
  if (upload?.status === "failed") return gt("upload failed");
  return progress;
}

function attachmentTooltip(
  attachment: Pick<ComposerImageContextAttachment | ComposerFileAttachment, "name" | "sizeBytes">,
  upload: AttachmentUploadState | undefined,
  resolve: MessageResolver,
): string {
  const lines = [attachment.name, formatAttachmentSize(attachment.sizeBytes, resolve)];
  if (upload?.status === "failed") lines.push("", attachmentUploadFailureText(upload, resolve));
  return lines.join("\n");
}

function ImageContextChip(props: {
  record: ComposerImageContextAttachment;
  upload: AttachmentUploadState | undefined;
}) {
  const actions = use(ComposerContextActionsContext);
  const messages = useMessages();
  const suffix = useUploadStatusSuffix(props.record.id, props.upload);
  return (
    <SharedTooltipTrigger
      render={
        <ImageChipButton
          name={props.record.name}
          previewUrl={props.record.previewUrl}
          size={formatAttachmentSize(props.record.sizeBytes, messages)}
          suffix={suffix}
          onClick={() => actions.expandImage(props.record.id)}
        />
      }
      label={attachmentTooltip(props.record, props.upload, messages)}
      className="whitespace-pre-wrap"
    />
  );
}

function FileContextChip(props: {
  record: ComposerFileAttachment;
  upload: AttachmentUploadState | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const actions = use(ComposerContextActionsContext);
  const { resolvedTheme } = useTheme();
  const needsReattach = composerFileNeedsReattach(props.record);
  const uploadSuffix = useUploadStatusSuffix(props.record.id, props.upload);
  const suffix = needsReattach ? gt("attach again") : uploadSuffix;
  const size = formatAttachmentSize(props.record.sizeBytes, messages);
  const isVideo = videoMimeType(props.record) !== null;
  return (
    <FileChip
      name={props.record.name}
      svgPreview={
        isSvgAttachment(props.record)
          ? {
              file: props.record.file,
              environmentId: props.record.uploadEnvironmentId,
              attachmentId: props.record.uploadedAttachmentId,
            }
          : undefined
      }
      size={size}
      isVideo={isVideo}
      theme={resolvedTheme}
      error={props.upload?.status === "failed"}
      unresolved={needsReattach}
      suffix={suffix}
      accessibleLabel={
        isVideo && !needsReattach
          ? gt("Preview video attachment, {name}, {size}", { name: props.record.name, size })
          : gt("File attachment, {name}, {size}", { name: props.record.name, size })
      }
      onOpen={
        !needsReattach
          ? () =>
              isVideo ? actions.expandVideo(props.record.id) : actions.openFile(props.record.id)
          : undefined
      }
      tooltip={
        needsReattach
          ? gt("{name} was not saved with this draft. Attach it again to send it.", {
              name: props.record.name,
            })
          : attachmentTooltip(props.record, props.upload, messages)
      }
    />
  );
}

function PullRequestContextChip(props: { record: ReviewCommentContext; kind: ContextChipKind }) {
  const actions = use(ComposerContextActionsContext);
  const messages = useMessages();
  const metadata = props.record.pullRequest;
  if (metadata === undefined) return null;
  return (
    <PullRequestChip
      metadata={metadata}
      environmentId={actions.environmentId}
      label={reviewCommentContextLabel(props.record, messages)}
      kindLabel={pullRequestContextKindLabel(props.record, messages)}
      kind={props.kind}
      onOpen={actions.openPullRequest}
    />
  );
}

function ReviewCommentContextChip(props: {
  record: ReviewCommentContext;
  isPullRequest: boolean;
  detailsMode: ContextPresentationCapability["details"];
  kind: ContextChipKind;
}) {
  const messages = useMessages();
  return (
    <ContextChip
      icon={props.isPullRequest ? <PullRequestGlyph.pullRequest /> : <MessageCircleIcon />}
      label={reviewCommentContextLabel(props.record, messages)}
      kindLabel={
        props.isPullRequest
          ? pullRequestContextKindLabel(props.record, messages)
          : msg("Review comment")
      }
      details={<ComposerReviewCommentDetails comment={props.record} />}
      detailsMode={props.detailsMode}
      kind={props.kind}
    />
  );
}

function previewAnnotationTooltip(
  annotation: PreviewAnnotationPayload,
  resolve: MessageResolver,
): string {
  const lines = [annotation.pageTitle?.trim() || annotation.pageUrl];
  if (annotation.comment.trim()) lines.push("", annotation.comment.trim());
  const targets: string[] = [];
  const { elements, regions, strokes, styleChanges } = annotation;
  if (elements.length > 0) {
    targets.push(
      resolve(
        msg("{count, plural, one {{count} element} other {{count} elements}}", {
          count: elements.length,
        }),
      ),
    );
  }
  if (regions.length > 0) {
    targets.push(
      resolve(
        msg("{count, plural, one {{count} region} other {{count} regions}}", {
          count: regions.length,
        }),
      ),
    );
  }
  if (strokes.length > 0) {
    targets.push(
      resolve(
        msg("{count, plural, one {{count} drawing} other {{count} drawings}}", {
          count: strokes.length,
        }),
      ),
    );
  }
  if (styleChanges.length > 0) {
    targets.push(
      resolve(
        msg("{count, plural, one {{count} style change} other {{count} style changes}}", {
          count: styleChanges.length,
        }),
      ),
    );
  }
  if (targets.length > 0) lines.push("", targets.join(", "));
  return lines.join("\n");
}

function ComposerReviewCommentDetails({ comment }: { comment: ReviewCommentContext }) {
  const messages = useMessages();
  return (
    <div className="space-y-2 overflow-hidden rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="truncate text-xs font-medium text-foreground">{comment.filePath}</div>
        <div className="text-secondary-label text-2xs">
          {reviewCommentSectionText(comment.sectionTitle, messages)} ·{" "}
          {reviewCommentRangeText(comment.rangeLabel, messages)}
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

function PreviewAnnotationContextChip(props: {
  annotation: PreviewAnnotationPayload;
  screenshot: ComposerImageAttachment | undefined;
  detailsMode: ContextPresentationCapability["details"];
}) {
  const m = useMessages();
  return (
    <ContextChip
      icon={<MousePointerClickIcon />}
      label={previewAnnotationContextLabel(props.annotation, m)}
      kindLabel={msg("Preview annotation")}
      details={
        <ComposerPreviewAnnotationDetails
          annotation={props.annotation}
          screenshot={props.screenshot}
        />
      }
      detailsMode={props.detailsMode}
      kind="preview-annotation"
    />
  );
}

function ComposerPreviewAnnotationDetails({
  annotation,
  screenshot,
}: {
  annotation: PreviewAnnotationPayload;
  screenshot: ComposerImageAttachment | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const summary = previewAnnotationTooltip(annotation, m);
  const screenshotUrl = annotation.screenshot?.dataUrl || screenshot?.previewUrl;
  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {screenshotUrl ? (
        <img
          src={screenshotUrl}
          alt={gt("Annotated preview crop")}
          className="max-h-64 w-full border-border/70 border-b bg-muted object-contain"
        />
      ) : (
        <div className="border-border/70 border-b bg-muted/40 px-3 py-2 text-secondary-label text-xs">
          <T>Screenshot unavailable</T>
        </div>
      )}
      <div className="whitespace-pre-wrap wrap-break-word px-3 py-2.5 text-sm text-foreground">
        {summary}
      </div>
    </div>
  );
}

function ComposerThreadContextChip(props: { record: ThreadContextRecord }) {
  const { environmentId } = use(ComposerContextActionsContext);
  const linkedEnvironments = useLinkedEnvironments(environmentId);
  return (
    <ThreadContextChip
      record={props.record}
      unreadable={
        environmentId !== null &&
        props.record.environmentId !== environmentId &&
        !linkedEnvironments.has(props.record.environmentId)
      }
    />
  );
}

function UnresolvedContextChip(props: { label: string }) {
  const gt = useGT();
  return (
    <UnresolvedChip
      label={props.label}
      tooltip={gt("This context is no longer available. Remove it or attach it again.")}
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
  requiredKinds: [
    "image",
    "file",
    "terminal",
    "review-comment",
    "preview-annotation",
    "thread",
    "environment",
  ],
  handlers: [
    {
      kind: "project-knowledge",
      canRender: (entry) => entry.kind === "project-knowledge",
      render: (entry, context) =>
        entry.kind === "project-knowledge" ? (
          <ProjectKnowledgeContextChip record={entry.record} />
        ) : (
          <UnresolvedContextChip label={context.label} />
        ),
    },
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
          <ReviewCommentContextChip
            record={entry.record}
            isPullRequest={isPullRequest}
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
          <PreviewAnnotationContextChip
            annotation={entry.record}
            screenshot={entry.screenshot}
            detailsMode={definition.capabilities.details}
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
          <ComposerThreadContextChip record={entry.record} />
        ) : (
          <UnresolvedContextChip label={context.label} />
        ),
    },
    {
      kind: "environment",
      canRender: (entry) => entry.kind === "environment",
      render: (entry, context) =>
        entry.kind === "environment" ? (
          <EnvironmentContextChip record={entry.record} />
        ) : (
          <UnresolvedContextChip label={context.label} />
        ),
    },
  ],
  fallback: (_kind, _entry, context) => <UnresolvedContextChip label={context.label} />,
});

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
