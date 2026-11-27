import { ProjectKnowledgeContextChip } from "../projectKnowledge/ProjectKnowledgeContextChip";
import { msg, T, useGT, useMessages } from "gt-react";
import type { MessageResolver } from "~/i18n/messages";
import { useNativeFileDrag } from "../../useNativeFileDrag";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { documentChipKindForFileName } from "~/pierre-icons";
import { isSvgAttachment } from "@t3tools/shared/image";
import { useRenderedAppearance } from "../../hooks/useTheme";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { ReadOnlySourcePreview } from "../files/AttachmentFilePreview";
import { useRightPanelStore } from "~/rightPanelStore";
import { COMPOSER_CONTEXT_KINDS } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { use, type ReactNode } from "react";
import { FileDiff } from "@pierre/diffs/react";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import {
  type ChatFileAttachment,
  type ChatImageAttachment,
  isImageAttachment,
  isVideoAttachment,
} from "../../types";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import ChatMarkdown from "../ChatMarkdown";
import { EnvironmentContextChip } from "../EnvironmentContextChip";
import { ThreadContextChip } from "../ThreadContextChip";
import { ResponseReplyCard } from "./AssistantCitationChip";
import { MessageCircleIcon, MousePointerClickIcon, PaintbrushIcon } from "lucide-react";
import type {
  ComposerContextId,
  KnownComposerContextRecord,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { buildExpandedImagePreview } from "./ExpandedImagePreview";
import { WorkspaceEntryIcon, WorkspaceEntryTooltip } from "./WorkspaceEntryIcon";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  ContextChipPopover as UserMessageContextPopover,
  FileChip,
  ImageChipButton,
  PULL_REQUEST_CHIP_KINDS,
  PullRequestChip,
  UnresolvedChip,
} from "../contextChipParts";
import {
  isPullRequestSummaryContext,
  previewAnnotationTargetText,
  pullRequestContextDisplayState,
  pullRequestContextKindLabel,
  reviewCommentContextLabel,
  reviewCommentRangeText,
  reviewCommentSectionText,
} from "~/lib/composerContextRecords";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { ContextChip, ContextChipLabel, type ContextChipKind } from "../ContextChip";
import { createContextPresentationRegistry } from "../contextPresentationRegistry";
import type { ChatMarkdownContextReference } from "../ChatMarkdown";
import {
  SkillChipPopover,
  skillInstructionsOpener,
  skillPopoverDescription,
} from "./SkillInlineText";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  buildReviewCommentRenderablePatch,
  formatReviewCommentFence,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import { TimelineRowCtx } from "./timelineRowContext";
import { userMessageFileLabel } from "./TimelineUserMessageRow.logic";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

function UserMessageMentionChip(props: {
  record: Extract<KnownComposerContextRecord, { kind: "mention" }>;
  copyMarkdown: string;
}) {
  const gt = useGT();
  const ctx = use(TimelineRowCtx);
  const nativeDrag = useNativeFileDrag(ctx.activeThreadEnvironmentId, () =>
    resolvePathLinkTarget(props.record.path, ctx.workspaceRoot ?? ""),
  );
  return (
    <SharedTooltipTrigger
      render={
        <ContextChip
          {...nativeDrag}
          kind={documentChipKindForFileName(props.record.path) ?? "mention"}
          render={<button type="button" />}
          aria-label={gt("Preview {name}", { name: props.record.path })}
          data-markdown-copy={props.copyMarkdown}
          onClick={() => {
            if (ctx.threadRef)
              useRightPanelStore.getState().openFile(ctx.threadRef, props.record.path);
          }}
        >
          <WorkspaceEntryIcon
            path={props.record.path}
            environmentId={ctx.activeThreadEnvironmentId}
            cwd={ctx.workspaceRoot}
            theme={ctx.resolvedTheme}
          />
          <ContextChipLabel>{props.record.label}</ContextChipLabel>
        </ContextChip>
      }
      label={
        <>
          <WorkspaceEntryTooltip
            path={props.record.path}
            environmentId={ctx.activeThreadEnvironmentId}
            cwd={ctx.workspaceRoot}
          />
        </>
      }
      className="pointer-events-auto"
    />
  );
}

function UserMessageSkillChip(props: {
  record: Extract<KnownComposerContextRecord, { kind: "skill" }>;
  copyMarkdown: string;
}) {
  const { skills, threadRef } = use(TimelineRowCtx);
  const skill = skills.find((candidate) => candidate.name === props.record.name);
  return (
    <SkillChipPopover
      label={props.record.label || props.record.name}
      description={skill ? skillPopoverDescription(skill) : null}
      copyMarkdown={props.copyMarkdown}
      onViewInstructions={skillInstructionsOpener(threadRef, skill)}
    />
  );
}

function UserMessagePullRequestContextChip(props: {
  record: Extract<KnownComposerContextRecord, { kind: "review-comment" }>;
  copyMarkdown: string;
  kind: ContextChipKind;
}) {
  const { activeThreadEnvironmentId, openPullRequest } = use(TimelineRowCtx);
  const messages = useMessages();
  const metadata = props.record.pullRequest;
  if (metadata === undefined) return null;
  return (
    <PullRequestChip
      metadata={metadata}
      environmentId={activeThreadEnvironmentId}
      label={reviewCommentContextLabel(props.record, messages)}
      kindLabel={pullRequestContextKindLabel(props.record, messages)}
      kind={props.kind}
      copyMarkdown={props.copyMarkdown}
      onOpen={openPullRequest}
    />
  );
}

function UserMessagePreviewAnnotationDetails(props: {
  record: Extract<KnownComposerContextRecord, { kind: "preview-annotation" }>;
  image: ChatImageAttachment | null;
}) {
  const ctx = use(TimelineRowCtx);
  const gt = useGT();
  const messages = useMessages();
  const visibleElements = props.record.elements ?? [];
  const targetText = previewAnnotationTargetText(props.record, messages);
  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {props.image?.previewUrl ? (
        <button
          type="button"
          className="block max-h-64 w-full cursor-zoom-in overflow-hidden border-b border-border/70 bg-muted"
          aria-label={gt("Preview {name}", { name: props.image.name })}
          onClick={() => {
            if (!props.image) return;
            const preview = buildExpandedImagePreview([props.image], props.image.id);
            if (preview) ctx.onImageExpand(preview);
          }}
        >
          <img
            src={props.image.previewUrl}
            alt={gt("Annotated preview crop")}
            className="max-h-64 w-full object-contain"
          />
        </button>
      ) : (
        <div className="border-b border-border/70 bg-muted/40 px-3 py-2 text-secondary-label text-xs">
          <T>Screenshot unavailable</T>
        </div>
      )}
      <div className="min-w-0 px-3 py-2.5">
        <div className="text-message-foreground text-xs font-medium">
          {props.record.pageTitle?.trim() || props.record.pageUrl || gt("Preview annotation")}
        </div>
        {props.record.comment ? (
          <div className="mt-1 whitespace-pre-wrap wrap-break-word text-sm">
            {props.record.comment}
          </div>
        ) : null}
        <div className="mt-1 flex items-center gap-2 text-secondary-label text-3xs">
          {targetText ? <span className="truncate">{targetText}</span> : null}
          {(props.record.styleChanges?.length ?? 0) > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PaintbrushIcon className="size-3" />
              {props.record.styleChanges?.length ?? 0}
            </span>
          ) : null}
        </div>
        {visibleElements.length > 0 ? (
          <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
            {visibleElements.map((element) => {
              const source = element.source;
              const sourceLabel = source?.fileName
                ? `${source.fileName}${source.lineNumber === null ? "" : `:${source.lineNumber}`}`
                : null;
              return (
                <div
                  key={`${element.selector}\u0000${element.tagName}\u0000${sourceLabel ?? ""}\u0000${element.htmlPreview}`}
                  className="min-w-0"
                >
                  <div className="flex min-w-0 items-center gap-2 text-xs">
                    <code className="truncate text-message-foreground">
                      {element.selector || `<${element.tagName}>`}
                    </code>
                    {sourceLabel ? (
                      <span className="ml-auto shrink-0 text-secondary-label">{sourceLabel}</span>
                    ) : null}
                  </div>
                  {element.htmlPreview?.trim() ? (
                    <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/60 px-2 py-1.5 text-3xs leading-relaxed">
                      {element.htmlPreview.trim()}
                    </pre>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function UserMessageElementDetails({
  record,
}: {
  record: Extract<KnownComposerContextRecord, { kind: "element" }>;
}) {
  const sourceLabel = record.source?.fileName
    ? `${record.source.fileName}${record.source.lineNumber === null ? "" : `:${record.source.lineNumber}`}`
    : null;
  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border/70 bg-background/70">
      <div className="border-b border-border/70 px-3 py-2.5">
        <div className="truncate text-message-foreground text-xs font-medium">
          {record.pageTitle?.trim() || record.pageUrl}
        </div>
        <div className="mt-0.5 truncate text-secondary-label text-3xs">{record.pageUrl}</div>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <code className="truncate text-message-foreground">
            {record.selector || `<${record.tagName}>`}
          </code>
          {sourceLabel ? (
            <span className="ml-auto shrink-0 text-secondary-label">{sourceLabel}</span>
          ) : null}
        </div>
        {record.htmlPreview?.trim() ? (
          <div className="flex h-40 flex-col overflow-hidden rounded border border-border">
            <ReadOnlySourcePreview name="element.html" text={record.htmlPreview} />
          </div>
        ) : null}
        {record.styles?.trim() ? (
          <div className="flex h-32 flex-col overflow-hidden rounded border border-border">
            <ReadOnlySourcePreview name="styles.css" text={record.styles} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface UserMessageContextRenderContext {
  environmentId: import("@t3tools/contracts").EnvironmentId;
  reference: ChatMarkdownContextReference;
  messageId: MessageId | undefined;
  sourceThreadId: ThreadId | undefined;
  annotationImage: ChatImageAttachment | null;
  attachment: ChatImageAttachment | ChatFileAttachment | null;
  resolvedTheme: "light" | "dark";
  copyMarkdown: string;
  onExpandImage: (image: ChatImageAttachment) => void;
  onExpandVideo: (file: ChatFileAttachment) => void;
  onOpenFile: (file: ChatFileAttachment) => void;
  m: MessageResolver;
}

function SentProjectKnowledgeContextChip(props: {
  record: Extract<KnownComposerContextRecord, { kind: "project-knowledge" }>;
  messageId: MessageId | undefined;
  sourceThreadId: ThreadId | undefined;
}) {
  const { threadRef } = use(TimelineRowCtx);
  // Messages folded in from another thread were delivered by that thread's run.
  const threadId = props.sourceThreadId ?? threadRef?.threadId;
  return (
    <ProjectKnowledgeContextChip
      record={props.record}
      sent={threadId && props.messageId ? { threadId, messageId: props.messageId } : undefined}
    />
  );
}

function UnavailableUserMessageContextChip(props: UserMessageContextRenderContext) {
  return (
    <UnresolvedChip
      label={props.reference.label}
      copyMarkdown={props.copyMarkdown}
      tooltip={props.m(msg("This context is no longer available."))}
    />
  );
}

const userMessageContextPresentationRegistry = createContextPresentationRegistry<
  KnownComposerContextRecord,
  UserMessageContextRenderContext,
  ReactNode
>({
  requiredKinds: COMPOSER_CONTEXT_KINDS,
  handlers: [
    {
      kind: "project-knowledge",
      canRender: (record) => record.kind === "project-knowledge",
      render: (record, context) =>
        record.kind === "project-knowledge" ? (
          <SentProjectKnowledgeContextChip
            record={record}
            messageId={context.messageId}
            sourceThreadId={context.sourceThreadId}
          />
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "mention",
      canRender: (record) => record.kind === "mention",
      render: (record, context) =>
        record.kind === "mention" ? (
          <UserMessageMentionChip record={record} copyMarkdown={context.copyMarkdown} />
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "skill",
      canRender: (record) => record.kind === "skill",
      render: (record, context) =>
        record.kind === "skill" ? (
          <UserMessageSkillChip record={record} copyMarkdown={context.copyMarkdown} />
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "thread",
      canRender: (record) => record.kind === "thread",
      render: (record, context) =>
        record.kind === "thread" ? (
          <ThreadContextChip record={record} copyMarkdown={context.copyMarkdown} />
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "response",
      canRender: (record) => record.kind === "response",
      render: (record, context) =>
        record.kind === "response" ? (
          <ResponseReplyCard
            record={record}
            copyMarkdown={context.copyMarkdown}
            leading={context.reference.leading ?? false}
            trailing={context.reference.trailing ?? false}
          />
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "environment",
      canRender: (record) => record.kind === "environment",
      render: (record, context) =>
        record.kind === "environment" ? (
          <EnvironmentContextChip record={record} copyMarkdown={context.copyMarkdown} />
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "image",
      canRender: (record, context) =>
        record.kind === "image" &&
        context.attachment !== null &&
        isImageAttachment(context.attachment),
      render: (record, context) => {
        if (
          record.kind !== "image" ||
          context.attachment === null ||
          !isImageAttachment(context.attachment)
        ) {
          return <UnavailableUserMessageContextChip {...context} />;
        }
        const attachment = context.attachment;
        return (
          <ImageChipButton
            name={record.name}
            previewUrl={attachment.previewUrl}
            size={formatAttachmentSize(record.sizeBytes, context.m)}
            data-markdown-copy={context.copyMarkdown}
            onClick={() => context.onExpandImage(attachment)}
          />
        );
      },
    },
    {
      kind: "file",
      canRender: (record, context) =>
        record.kind === "file" && context.attachment !== null && context.attachment.type === "file",
      render: (record, context) => {
        if (
          record.kind !== "file" ||
          context.attachment === null ||
          context.attachment.type !== "file"
        ) {
          return <UnavailableUserMessageContextChip {...context} />;
        }
        const attachment = context.attachment;
        const isVideo = isVideoAttachment(attachment);
        const label = userMessageFileLabel(attachment, context.m);
        const disabled =
          attachment.downloadable === false && (!isVideo || attachment.previewUrl === undefined);
        const size =
          attachment.downloadable === false
            ? context.m(msg("Sending…"))
            : formatAttachmentSize(record.sizeBytes, context.m);
        return (
          <FileChip
            name={label}
            svgPreview={
              isSvgAttachment(attachment)
                ? { environmentId: context.environmentId, attachmentId: attachment.id }
                : undefined
            }
            size={size}
            isVideo={isVideo}
            theme={context.resolvedTheme}
            disabled={disabled}
            accessibleLabel={
              isVideo
                ? context.m(msg("Video attachment, {label}, {size}", { label, size }))
                : context.m(msg("File attachment, {label}, {size}", { label, size }))
            }
            copyMarkdown={context.copyMarkdown}
            onOpen={() =>
              isVideo ? context.onExpandVideo(attachment) : context.onOpenFile(attachment)
            }
            tooltip={`${label}\n${size}`}
          />
        );
      },
    },
    {
      kind: "terminal",
      canRender: (record) => record.kind === "terminal",
      render: (record, context, definition) =>
        record.kind === "terminal" ? (
          <span data-markdown-copy={context.copyMarkdown}>
            <TerminalContextInlineChip
              terminalLabel={record.terminalLabel}
              lineStart={record.lineStart}
              lineEnd={record.lineEnd}
              text={record.text}
              detailsMode={definition.capabilities.details}
            />
          </span>
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "element",
      canRender: (record) => record.kind === "element",
      render: (record, context) =>
        record.kind === "element" ? (
          <UserMessageContextPopover
            copyMarkdown={context.copyMarkdown}
            accessibleLabel={context.m(msg("Browser element, {label}", { label: record.label }))}
            kind="element"
            icon={<MousePointerClickIcon />}
            label={record.label}
          >
            <UserMessageElementDetails record={record} />
          </UserMessageContextPopover>
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "review-comment",
      canRender: (record) => record.kind === "review-comment",
      render: (record, context) => {
        if (record.kind !== "review-comment") {
          return <UnavailableUserMessageContextChip {...context} />;
        }
        const isPullRequest = isPullRequestSummaryContext(record);
        const label = reviewCommentContextLabel(record, context.m);
        const kindLabel = isPullRequest
          ? pullRequestContextKindLabel(record, context.m)
          : context.m(msg("Review comment"));
        const pullRequestState = pullRequestContextDisplayState(record) ?? "unknown";
        if (isPullRequest && record.pullRequest !== undefined) {
          return (
            <UserMessagePullRequestContextChip
              record={record}
              copyMarkdown={context.copyMarkdown}
              kind={PULL_REQUEST_CHIP_KINDS[pullRequestState]}
            />
          );
        }
        return (
          <UserMessageContextPopover
            copyMarkdown={context.copyMarkdown}
            accessibleLabel={
              record.pullRequest
                ? context.m(
                    msg("{kind}, {label}, {title}", {
                      kind: kindLabel,
                      label,
                      title: record.pullRequest.title,
                    }),
                  )
                : context.m(msg("{kind}, {label}", { kind: kindLabel, label }))
            }
            kind={isPullRequest ? PULL_REQUEST_CHIP_KINDS[pullRequestState] : "review-comment"}
            icon={isPullRequest ? <PullRequestGlyph.pullRequest /> : <MessageCircleIcon />}
            label={label}
          >
            <UserMessageReviewCommentCard
              comment={{
                id: record.contextId,
                sectionId: record.sectionId,
                sectionTitle: record.sectionTitle,
                filePath: record.filePath,
                startIndex: record.startIndex,
                endIndex: record.endIndex,
                rangeLabel: record.rangeLabel,
                text: record.text,
                diff: record.diff,
                ...(record.fenceLanguage !== undefined
                  ? { fenceLanguage: record.fenceLanguage }
                  : {}),
                ...(record.pullRequest !== undefined ? { pullRequest: record.pullRequest } : {}),
              }}
            />
          </UserMessageContextPopover>
        );
      },
    },
    {
      kind: "preview-annotation",
      canRender: (record) => record.kind === "preview-annotation",
      render: (record, context) =>
        record.kind === "preview-annotation" ? (
          <UserMessageContextPopover
            copyMarkdown={context.copyMarkdown}
            accessibleLabel={context.m(msg("Preview annotation, {label}", { label: record.label }))}
            kind="preview-annotation"
            icon={<MousePointerClickIcon />}
            label={record.label}
          >
            <UserMessagePreviewAnnotationDetails record={record} image={context.annotationImage} />
          </UserMessageContextPopover>
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
  ],
  fallback: (_kind, _record, context) => <UnavailableUserMessageContextChip {...context} />,
});

export function UserMessageContextReferenceChip(props: {
  reference: ChatMarkdownContextReference;
  record: KnownComposerContextRecord | undefined;
  messageId?: MessageId;
  sourceThreadId?: ThreadId | undefined;
  annotationImage: ChatImageAttachment | null;
  attachment: ChatImageAttachment | ChatFileAttachment | null;
  onExpandImage: (image: ChatImageAttachment) => void;
  onExpandVideo: (file: ChatFileAttachment) => void;
  onOpenFile: (file: ChatFileAttachment) => void;
}) {
  const { resolvedTheme, activeThreadEnvironmentId } = use(TimelineRowCtx);
  const m = useMessages();
  const copyMarkdown = formatComposerContextReference({
    kind: props.reference.kind,
    contextId: props.reference.contextId as ComposerContextId,
    label: props.reference.label,
  });
  return userMessageContextPresentationRegistry.render(props.reference.kind, props.record, {
    environmentId: activeThreadEnvironmentId,
    reference: props.reference,
    messageId: props.messageId,
    sourceThreadId: props.sourceThreadId,
    annotationImage: props.annotationImage,
    attachment: props.attachment,
    resolvedTheme,
    copyMarkdown,
    onExpandImage: props.onExpandImage,
    onExpandVideo: props.onExpandVideo,
    onOpenFile: props.onOpenFile,
    m,
  });
}

function UserMessageReviewCommentCard({ comment }: { comment: ReviewCommentContext }) {
  const m = useMessages();
  const renderedAppearance = useRenderedAppearance();
  const ctx = use(TimelineRowCtx);
  const fenceLanguage = comment.fenceLanguage ?? "diff";
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
    undefined,
    m,
  );

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="text-xs font-medium text-foreground">
          {formatWorkspaceRelativePath(comment.filePath, ctx.workspaceRoot)}
        </div>
        <div className="text-2xs text-muted-foreground">
          {reviewCommentSectionText(comment.sectionTitle, m)} ·{" "}
          {reviewCommentRangeText(comment.rangeLabel, m)}
        </div>
      </div>
      {comment.text.length > 0 && (
        <div className="wrap-break-word text-sm">
          <ChatMarkdown
            text={comment.text}
            cwd={ctx.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            skills={ctx.skills}
            parseRawHtml={false}
            lineBreaks
          />
        </div>
      )}
      {fenceLanguage !== "diff" && comment.diff.trim().length > 0 && (
        <ChatMarkdown
          text={formatReviewCommentFence(fenceLanguage, comment.diff)}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={ctx.skills}
          className="text-foreground"
        />
      )}
      {renderablePatch?.kind === "files" && (
        <DiffWorkerPoolProvider>
          {renderablePatch.files.map((fileDiff) => (
            <FileDiff
              key={resolveFileDiffPath(fileDiff)}
              fileDiff={fileDiff}
              options={{
                collapsed: false,
                diffStyle: "unified",
                theme: resolveDiffThemeName(renderedAppearance),
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
              }}
            />
          ))}
        </DiffWorkerPoolProvider>
      )}
      {renderablePatch?.kind === "raw" && (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
          {renderablePatch.text}
        </pre>
      )}
    </div>
  );
}
