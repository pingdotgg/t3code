import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";
import { WorkLogDetails, WorkLogRow } from "./WorkLog";
import {
  getQuestionAnswerPreview,
  getQuestionAnswerText,
  getQuestionTextPreview,
  hasQuestionAnswer,
} from "@t3tools/client-runtime/work-log/user-input";
import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { notificationChildThreadId } from "@t3tools/client-runtime/state/thread-execution";
import {
  resolveViewedImageAsset,
  resolveWorkEntryToolPresentation,
  toolGroupAction,
  workEntryViewedImagePath,
} from "@t3tools/client-runtime/work-log/presentation";
import { t3ToolResultIndicatesFailure } from "@t3tools/client-runtime/t3ToolSummary";
import {
  turnItemHasDetail,
  turnItemNeedsDetailFetch,
} from "@t3tools/client-runtime/work-log/item-detail";
import { claudeSkillInvocation } from "@t3tools/shared/toolActivity";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { memo, use, useState, type KeyboardEvent } from "react";
import {
  workEntryDisplayIndicatesToolFailure,
  workEntrySignalsSevereFailure,
  workLogEntryIsToolLike,
} from "../../session-logic";
import ChatMarkdown from "../ChatMarkdown";
import { ChatMarkdownAssetImage } from "./ChatMarkdownMedia";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { workGroupImageGallery } from "./markdownImageGallery";
import { McpSignInAction } from "./McpSignInAction";
import * as DateTime from "effect/DateTime";
import { ChevronRightIcon, CircleAlertIcon, XIcon, RotateCcwIcon } from "lucide-react";
import { Button, InlineButton } from "../ui/button";
import { useAssetUrls } from "../../assets/assetUrls";
import { useThreadShell } from "../../state/entities";
import {
  threadReadTargetId,
  threadReadTargetTitle,
  workEntryDisplayLabel,
  workEntryReadOutput,
} from "./MessagesTimeline.logic";
import { cn } from "~/lib/utils";
import type { MessageResolver } from "~/i18n/messages";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { FetchedToolOutput, V2ItemInspector } from "./V2ItemInspector";
import { SubagentNotificationLink } from "./V2LifecycleRow";
import {
  TimelineRowCtx,
  TimelineRowActivityCtx,
  WorkGroupViewCtx,
  type TimelineRow,
  type TimelineWorkEntry,
} from "./timelineRowContext";
import { MESSAGE_HEADING_LEVEL, TimelineRowTimestamp } from "./TimelineRowParts";
import {
  failedToolIconClassName,
  toolIconAcceptsTint,
  ToolActivityIconView,
} from "./TimelineToolActivityIcon";
import {
  workToneIcon,
  workEntryRawCommand,
  buildToolCallExpandedBody,
  workEntryIconName,
  thoughtPreviewPlugins,
  THOUGHT_PREVIEW_SOURCE_MAX_LENGTH,
} from "./TimelineWorkEntryRow.logic";

export function useThreadReadTarget(entry: TimelineWorkEntry, environmentId: EnvironmentId) {
  const rawThreadId = threadReadTargetId(entry);
  const threadId = rawThreadId === null ? null : ThreadId.make(rawThreadId);
  const shell = useThreadShell(threadId ? scopeThreadRef(environmentId, threadId) : null);
  const title = threadReadTargetTitle(shell);
  return threadId && title ? { threadId, title } : null;
}

const THREAD_READ_STATUSES = ["inProgress", "completed", "failed", "declined", "stopped"] as const;
type ThreadReadStatus = (typeof THREAD_READ_STATUSES)[number];

// The label arrives resolved (or still English), so its status is found by resolving each one.
function threadReadStatus(
  label: string,
  entry: TimelineWorkEntry,
  resolve: MessageResolver,
): ThreadReadStatus | null {
  const payload = entry.structuredPayload;
  if (payload?.type !== "dynamic_tool") return null;
  if (t3ToolResultIndicatesFailure(payload.output)) return "failed";
  for (const resolver of [resolve, undefined]) {
    for (const status of THREAD_READ_STATUSES) {
      const presentation = resolveWorkEntryToolPresentation(
        { ...entry, toolLifecycleStatus: status },
        undefined,
        resolver,
      );
      if (presentation?.displayName === label) return status;
    }
  }
  return null;
}

export function threadReadLabel(
  label: string,
  entry: TimelineWorkEntry,
  target: ReturnType<typeof useThreadReadTarget>,
  resolve: MessageResolver,
) {
  const status = target && threadReadStatus(label, entry, resolve);
  if (!target || !status) return null;
  return {
    ...target,
    status,
    text: resolve(
      msg(
        "{status, select, inProgress {Reading thread “{title}”} completed {Read thread “{title}”} failed {Failed to read thread “{title}”} declined {Declined to read thread “{title}”} stopped {Stopped reading thread “{title}”} other {Reading thread “{title}”}}",
        { status, title: target.title },
      ),
    ),
  };
}

export function ThreadReadLabel({
  label,
  environmentId,
  linked,
}: {
  label: NonNullable<ReturnType<typeof threadReadLabel>>;
  environmentId: EnvironmentId;
  linked: boolean;
}) {
  const title = linked ? (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId: label.threadId }}
      className="min-w-0 truncate rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={stopRowToggle}
      onKeyDown={stopRowToggle}
    >
      {label.title}
    </Link>
  ) : (
    <span className="min-w-0 truncate">{label.title}</span>
  );
  return (
    <span className="flex min-w-0">
      {label.status === "completed" ? (
        <T>
          <span className="shrink-0">Read thread “</span>
          <Var>{title}</Var>
          <span className="shrink-0">”</span>
        </T>
      ) : label.status === "failed" ? (
        <T>
          <span className="shrink-0">Failed to read thread “</span>
          <Var>{title}</Var>
          <span className="shrink-0">”</span>
        </T>
      ) : label.status === "declined" ? (
        <T>
          <span className="shrink-0">Declined to read thread “</span>
          <Var>{title}</Var>
          <span className="shrink-0">”</span>
        </T>
      ) : label.status === "stopped" ? (
        <T>
          <span className="shrink-0">Stopped reading thread “</span>
          <Var>{title}</Var>
          <span className="shrink-0">”</span>
        </T>
      ) : (
        <T>
          <span className="shrink-0">Reading thread “</span>
          <Var>{title}</Var>
          <span className="shrink-0">”</span>
        </T>
      )}
    </span>
  );
}

const toolCallExpandedBodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-(length:--font-size-code,var(--text-2xs)) leading-relaxed select-text";

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

export function ReasoningTraceContent({ entries }: { entries: ReadonlyArray<TimelineWorkEntry> }) {
  const ctx = use(TimelineRowCtx);
  const { isWorking, latestRunId } = use(TimelineRowActivityCtx);
  const isStreaming = (entry: TimelineWorkEntry) =>
    isWorking && entry.runId === latestRunId && entry.toolLifecycleStatus === "inProgress";
  return (
    <WorkLogDetails followLive={entries.some(isStreaming)}>
      {entries.map((entry) => (
        <ChatMarkdown
          key={entry.id}
          className="text-foreground"
          text={entry.detail ?? ""}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={ctx.skills}
          isStreaming={isStreaming(entry)}
          headingLevelOffset={MESSAGE_HEADING_LEVEL}
          onUseArtifactTemplate={ctx.onUseArtifactTemplate}
          onImageExpand={ctx.onImageExpand}
          lineBreaks
        />
      ))}
    </WorkLogDetails>
  );
}

type WorkEntryRowProps = {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  displayLabel?: string | undefined;
  onToggleEntry?: ((collapsed: boolean) => void) | undefined;
  onContentReady?: (() => void) | undefined;
};

export const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: WorkEntryRowProps) {
  const ctx = use(TimelineRowCtx);
  const item = props.workEntry.projectedItem?.item;
  const childThreadId =
    item?.type === "notification" ? notificationChildThreadId(item.source) : undefined;
  if (item?.type !== "notification" || childThreadId === undefined) {
    return <WorkEntryLogRow {...props} />;
  }
  return (
    <SubagentNotificationLink
      parentRef={scopeThreadRef(ctx.activeThreadEnvironmentId, item.threadId)}
      childThreadId={childThreadId}
      taskIds={item.source.kind === "delegated_task" ? item.source.taskIds : undefined}
      outcome={item.outcome}
      createdAt={props.workEntry.createdAt}
      timestampFormat={ctx.timestampFormat}
      onOpenThread={ctx.onOpenThread}
      fallback={<WorkEntryLogRow {...props} />}
    />
  );
});

export function ViewedImagesTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "viewed-images" }>;
}) {
  const { threadRef, workspaceRoot, onImageExpand } = use(TimelineRowCtx);
  if (!threadRef) return null;
  return (
    <div className="flex flex-wrap items-start gap-2 px-0.5" data-image-gallery>
      {row.paths.map((path) => {
        const image = resolveViewedImageAsset(path, {
          threadId: threadRef.threadId,
          workspaceRoot,
        });
        return image ? (
          <ChatMarkdownAssetImage
            key={path}
            environmentId={threadRef.environmentId}
            resource={image.resource}
            alt={image.alt}
            srcFragment={image.srcFragment}
            workspaceRoot={workspaceRoot}
            maxHeightRem={10}
            onImageExpand={onImageExpand}
          />
        ) : null;
      })}
    </div>
  );
}

function WorkEntryLogRow(props: WorkEntryRowProps) {
  const { workEntry, workspaceRoot, displayLabel } = props;
  const ctx = use(TimelineRowCtx);
  const gt = useGT();
  const m = useMessages();
  const { threadRef, onImageExpand, timestampFormat } = ctx;
  const { retryableWorkspacePreparationRunIds, onRetryWorkspacePreparation } = ctx;
  const threadTarget = useThreadReadTarget(workEntry, ctx.activeThreadEnvironmentId);
  const createdThread =
    workEntry.projectedItem?.item.type === "thread_created"
      ? workEntry.projectedItem.item
      : undefined;
  const notifiedSubagentThreadId =
    workEntry.projectedItem?.item.type === "notification"
      ? notificationChildThreadId(workEntry.projectedItem.item.source)
      : undefined;
  const groupView = use(WorkGroupViewCtx);
  const [expanded, setExpanded] = useState(
    () => groupView?.state.expandedEntries.has(workEntry.id) ?? false,
  );
  const onInitialOutputReady = () => {
    if (groupView) groupView.onContentReady?.(workEntry.id);
    else props.onContentReady?.();
  };
  const toggleExpanded = () => {
    const next = !expanded;
    if (groupView) {
      groupView.onToggleEntry(!next, workEntry.id);
      if (next) groupView.state.expandedEntries.add(workEntry.id);
      else groupView.state.expandedEntries.delete(workEntry.id);
    } else {
      props.onToggleEntry?.(!next);
    }
    setExpanded(next);
  };
  const failureItem = workEntry.projectedItem?.item;
  const pendingApproval =
    failureItem?.type === "approval_request"
      ? ctx.pendingApprovals.get(failureItem.requestId)
      : undefined;
  if (pendingApproval) return <TimelinePendingApprovalRow approval={pendingApproval} />;
  if (failureItem?.type === "error" && failureItem.status === "failed") {
    const warning = failureItem.failure.class === "usage_limit";
    const resetAt = failureItem.failure.resetAt;
    // The reset time is the viewer's local time; naming the zone keeps it
    // unambiguous. Both read the zone now, since the device's can change.
    const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const resetTime = resetAt
      ? `${formatUpcomingTimestamp(resetAt, timestampFormat, undefined, timeZone, m)} (${timeZone})`
      : null;
    const label = warning
      ? resetTime
        ? gt("Usage limit reached. Retry after {resetTime}.", { resetTime })
        : gt("Usage limit reached.")
      : workEntry.label;
    const retryRunId =
      failureItem.runId !== null &&
      retryableWorkspacePreparationRunIds.has(failureItem.runId) &&
      failureItem.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE
        ? failureItem.runId
        : null;
    return (
      <WorkLogRow
        data-v2-item-type="error"
        data-v2-item-visibility={workEntry.projectedItem?.visibility}
        wrapLabel
        icon={
          <CircleAlertIcon
            className={cn("size-4", warning ? "text-warning" : "text-destructive")}
          />
        }
        label={
          <span
            className={cn("text-sm font-medium", warning ? "text-warning" : "text-destructive")}
          >
            {label}
          </span>
        }
        trailing={
          <TimelineRowTimestamp
            createdAt={workEntry.createdAt}
            timestampFormat={timestampFormat}
            alwaysVisible
          />
        }
      >
        {!warning ? (
          <p className="ms-7 whitespace-pre-wrap break-words py-1 text-sm leading-relaxed text-foreground/80">
            {failureItem.failure.message}
          </p>
        ) : null}
        {retryRunId !== null && onRetryWorkspacePreparation ? (
          <div className="ms-7 pb-1">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => onRetryWorkspacePreparation(retryRunId)}
            >
              <RotateCcwIcon aria-hidden />
              <T>Retry</T>
            </Button>
          </div>
        ) : null}
      </WorkLogRow>
    );
  }
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const showFailedIndicator =
    !showWarningIndicator && workEntryDisplayIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle =
    !showWarningIndicator &&
    showFailedIndicator &&
    (workEntrySignalsSevereFailure(workEntry) || !workLogEntryIsToolLike(workEntry));
  const entryIconName =
    showWarningIndicator || showDestructiveRowStyle ? "circle-alert" : workEntryIconName(workEntry);
  const entryToolIcon =
    showWarningIndicator || showDestructiveRowStyle
      ? undefined
      : (workEntry.toolIcon ?? workEntry.toolSource?.icon);
  const isReasoning = workEntry.itemType === "reasoning";
  const questionHeading = workEntry.questionAnswer
    ? getQuestionTextPreview(workEntry.questionAnswer)
    : "";
  const previewText =
    isReasoning && expanded
      ? workEntry.toolLifecycleStatus === "inProgress"
        ? gt("Thinking")
        : gt("Thought")
      : questionHeading || (displayLabel ?? workEntryDisplayLabel(workEntry, workspaceRoot, m));
  const answerPreview =
    workEntry.questionAnswer && hasQuestionAnswer(workEntry.questionAnswer)
      ? getQuestionAnswerPreview(workEntry.questionAnswer)
      : null;
  const viewedImagePath = workEntryViewedImagePath(workEntry);
  const payload = workEntry.structuredPayload;
  const skill =
    payload?.type === "dynamic_tool"
      ? claudeSkillInvocation(payload.toolName, payload.input)
      : undefined;
  const plainOutput =
    toolGroupAction(workEntry) === "read"
      ? workEntryReadOutput(workEntry, workspaceRoot)
      : skill
        ? (skill.args ?? null)
        : undefined;
  const viewedImage =
    viewedImagePath && threadRef
      ? resolveViewedImageAsset(viewedImagePath, {
          threadId: threadRef.threadId,
          workspaceRoot,
        })
      : null;
  const groupViewedImages = groupView?.viewedImages;
  // Images in this entry's expanded body page through the group's viewed images, like its strip.
  const expandImage =
    viewedImage && groupViewedImages
      ? (preview: ExpandedImagePreview) =>
          onImageExpand(workGroupImageGallery(groupViewedImages, viewedImagePath, preview))
      : onImageExpand;
  const canExpand =
    previewText.trim().length > 0 ||
    (workEntry.itemType === "dynamic_tool" && workEntry.toolData !== undefined) ||
    Boolean(
      workEntryRawCommand(workEntry) ||
      workEntry.command?.trim() ||
      workEntry.detail?.trim() ||
      workEntry.changedFiles?.length ||
      viewedImage,
    );
  const expandedBody =
    expanded && !isReasoning
      ? plainOutput !== undefined
        ? plainOutput
        : buildToolCallExpandedBody(
            workEntry,
            workspaceRoot,
            previewText,
            viewedImage ? viewedImagePath : null,
            m,
          )
      : null;
  const plainOutputFetches =
    plainOutput !== undefined &&
    workEntry.projectedItem !== undefined &&
    turnItemNeedsDetailFetch(workEntry.projectedItem.item);
  const canExpandProjectedItem =
    plainOutput !== undefined
      ? Boolean(plainOutput || viewedImage || workEntry.questionAnswer || plainOutputFetches)
      : workEntry.projectedItem === undefined
        ? canExpand
        : isReasoning
          ? Boolean(workEntry.detail?.trim())
          : Boolean(
              viewedImage ||
              workEntry.questionAnswer ||
              turnItemHasDetail(workEntry.projectedItem.item),
            );
  const iconWrapperClass = cn(
    "flex size-4 items-center justify-center",
    showWarningIndicator
      ? "text-warning"
      : showDestructiveRowStyle
        ? "text-destructive"
        : showFailedIndicator
          ? failedToolIconClassName
          : workEntry.tone === "tool"
            ? "text-icon-muted"
            : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : workLogEntryIsToolLike(workEntry)
        ? "text-secondary-label"
        : "text-foreground/80";
  const threadLabel = isReasoning ? null : threadReadLabel(previewText, workEntry, threadTarget, m);
  const accessiblePreview = [threadLabel?.text ?? previewText, answerPreview]
    .filter(Boolean)
    .join(": ");
  const accessibleDisplayText = showFailedIndicator
    ? gt("{label}, tool call failed", { label: accessiblePreview })
    : accessiblePreview;
  const rowToggleProps = canExpandProjectedItem
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": accessibleDisplayText,
        "aria-expanded": expanded,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggleExpanded();
          }
        },
      }
    : undefined;

  return (
    <WorkLogRow
      data-work-entry-id={workEntry.id}
      data-v2-item-type={workEntry.projectedItem?.item.type}
      data-v2-item-visibility={workEntry.projectedItem?.visibility}
      onClick={canExpandProjectedItem ? toggleExpanded : undefined}
      toggle={rowToggleProps}
      icon={
        <span
          className={iconWrapperClass}
          role={showFailedIndicator ? "img" : undefined}
          aria-label={showFailedIndicator ? gt("Tool call failed") : undefined}
        >
          <ToolActivityIconView
            icon={entryToolIcon}
            fallbackName={entryIconName}
            className="block size-4 shrink-0 stroke-2"
            muted
          />
        </span>
      }
      label={
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className="flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed">
            <span
              className={cn(answerPreview ? "min-w-0" : "min-w-0 flex-1", "truncate", headingClass)}
            >
              {isReasoning && !expanded ? (
                <ChatMarkdown
                  inline
                  text={(workEntry.detail ?? previewText).slice(
                    0,
                    THOUGHT_PREVIEW_SOURCE_MAX_LENGTH,
                  )}
                  cwd={ctx.markdownCwd}
                  parseRawHtml={false}
                  extraRemarkPlugins={
                    workEntry.toolLifecycleStatus === "inProgress"
                      ? thoughtPreviewPlugins(gt("Thinking"))
                      : thoughtPreviewPlugins(gt("Thought"))
                  }
                />
              ) : threadLabel ? (
                <ThreadReadLabel
                  label={threadLabel}
                  environmentId={ctx.activeThreadEnvironmentId}
                  linked
                />
              ) : (
                previewText
              )}
            </span>
            {answerPreview ? (
              <span
                className={cn(
                  "min-w-0 truncate",
                  !expanded &&
                    workEntry.questionAnswer &&
                    hasQuestionAnswer(workEntry.questionAnswer)
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {answerPreview}
              </span>
            ) : null}
          </p>
        </div>
      }
      trailing={
        <>
          {createdThread ? (
            <button
              type="button"
              className="shrink-0 rounded-sm text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              aria-label={
                createdThread.title != null
                  ? gt("Open {title}", { title: createdThread.title })
                  : gt("Open created thread")
              }
              onClick={(event) => {
                event.stopPropagation();
                ctx.onOpenThread(createdThread.targetThreadId);
              }}
              onKeyDown={stopRowToggle}
            >
              <T>Open chat</T>
            </button>
          ) : null}
          {payload?.type === "system_notice" &&
          payload.mcpSignIn !== undefined &&
          payload.providerThreadId !== null ? (
            <McpSignInAction
              environmentId={ctx.activeThreadEnvironmentId}
              threadId={payload.threadId}
              providerThreadId={payload.providerThreadId}
              server={payload.mcpSignIn.server}
              noticeAt={DateTime.toEpochMillis(payload.updatedAt)}
            />
          ) : null}
          {notifiedSubagentThreadId ? (
            <InlineButton
              aria-label={gt("Open subagent thread")}
              onClick={(event) => {
                event.stopPropagation();
                ctx.onOpenThread(notifiedSubagentThreadId);
              }}
              onKeyDown={stopRowToggle}
            >
              <T>Open subagent</T>
            </InlineButton>
          ) : null}
          {showFailedIndicator &&
          !showDestructiveRowStyle &&
          !toolIconAcceptsTint(entryToolIcon) ? (
            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
          ) : null}
          {canExpandProjectedItem ? (
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
              <ChevronRightIcon
                className={cn(
                  "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                  expanded && "rotate-90",
                )}
              />
            </span>
          ) : null}
          <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />
        </>
      }
    >
      {expanded && viewedImage && threadRef ? (
        <WorkLogDetails kind="media">
          <ChatMarkdownAssetImage
            environmentId={threadRef.environmentId}
            resource={viewedImage.resource}
            alt={viewedImage.alt}
            srcFragment={viewedImage.srcFragment}
            workspaceRoot={workspaceRoot}
            maxHeightRem={16}
            onImageExpand={expandImage}
          />
        </WorkLogDetails>
      ) : null}
      {expanded && workEntry.questionAnswer ? (
        <QuestionAnswerHistory answer={workEntry.questionAnswer} />
      ) : null}
      {expanded && isReasoning ? <ReasoningTraceContent entries={[workEntry]} /> : null}
      {expanded &&
      !isReasoning &&
      !workEntry.questionAnswer &&
      canExpandProjectedItem &&
      (expandedBody ||
        plainOutputFetches ||
        (workEntry.projectedItem && plainOutput === undefined)) ? (
        <WorkLogDetails kind="panel">
          {workEntry.projectedItem && plainOutput === undefined ? (
            <V2ItemInspector
              onInitialOutputReady={onInitialOutputReady}
              projectedItem={workEntry.projectedItem}
              environmentId={ctx.activeThreadEnvironmentId}
              cwd={ctx.markdownCwd}
              workspaceRoot={workspaceRoot}
              onOpenToolDiff={ctx.onOpenToolDiff}
              onImageExpand={expandImage}
              source={ctx.turnItemSource}
            />
          ) : (
            <>
              {expandedBody ? (
                <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>
              ) : null}
              {plainOutputFetches && workEntry.projectedItem ? (
                <FetchedToolOutput
                  onInitialOutputReady={onInitialOutputReady}
                  projectedItem={workEntry.projectedItem}
                  environmentId={ctx.activeThreadEnvironmentId}
                  onImageExpand={expandImage}
                  source={ctx.turnItemSource}
                />
              ) : null}
            </>
          )}
        </WorkLogDetails>
      ) : null}
    </WorkLogRow>
  );
}

function QuestionAnswerHistory({
  answer,
}: {
  answer: import("@t3tools/contracts").UserInputAttachmentAnswerPayload;
}) {
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  const attachments = Object.values(answer.attachmentsByQuestionId).flat();
  const resources = attachments.map((attachment) => ({
    _tag: "attachment" as const,
    attachmentId: attachment.id,
  }));
  const urls = useAssetUrls(activeThreadEnvironmentId, resources);
  return (
    <div className="ms-7 mt-2 space-y-2" onClick={stopRowToggle}>
      {[
        ...new Set([
          ...Object.keys(answer.questionTextById ?? {}),
          ...Object.keys(answer.answers),
          ...Object.keys(answer.attachmentsByQuestionId),
        ]),
      ].map((questionId) => (
        <div key={questionId} className="space-y-1">
          {answer.questionTextById?.[questionId] ? (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {answer.questionTextById[questionId]}
            </p>
          ) : null}
          {getQuestionAnswerText(answer.answers[questionId]) ? (
            <p className="ms-3 whitespace-pre-wrap text-sm text-muted-foreground">
              {getQuestionAnswerText(answer.answers[questionId])}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {(answer.attachmentsByQuestionId[questionId] ?? []).map((attachment) => {
              const url = urls[attachments.indexOf(attachment)];
              return (
                <a
                  key={attachment.id}
                  href={url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm underline"
                >
                  {attachment.type === "image" && url ? (
                    <img
                      src={url}
                      alt={attachment.name}
                      className="h-20 max-w-32 rounded object-contain"
                    />
                  ) : (
                    attachment.name
                  )}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
