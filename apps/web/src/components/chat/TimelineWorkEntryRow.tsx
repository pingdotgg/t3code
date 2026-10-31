import { THINKING_PREVIEW_PLUGINS, THOUGHT_PREVIEW_PLUGINS } from "./TimelineWorkEntryRow.logic";
import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";
import { MESSAGE_HEADING_LEVEL } from "./TimelineRowParts";
import {
  TimelineRowActivityCtx,
  TimelineRowCtx,
  type TimelineWorkEntry,
  WorkGroupViewCtx,
} from "./timelineRowContext";
import {
  ToolActivityIconView,
  failedToolIconClassName,
  toolIconAcceptsTint,
} from "./TimelineToolActivityIcon";
import {
  buildToolCallExpandedBody,
  workEntryIconName,
  workToneIcon,
} from "./TimelineWorkEntryRow.logic";
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
  toolGroupAction,
  workEntryViewedImagePath,
} from "@t3tools/client-runtime/work-log/presentation";
import { turnItemNeedsDetailFetch } from "@t3tools/client-runtime/work-log/item-detail";
import { claudeSkillInvocation } from "@t3tools/shared/toolActivity";
import { memo, use, useState, type KeyboardEvent } from "react";
import {
  workEntryDisplayIndicatesToolFailure,
  workEntrySignalsSevereFailure,
  workLogEntryIsToolLike,
} from "../../session-logic";
import ChatMarkdown from "../ChatMarkdown";
import { ChatMarkdownAssetImage } from "./ChatMarkdownMedia";
import { ChevronRightIcon, CircleAlertIcon, XIcon, RotateCcwIcon } from "lucide-react";
import { Button, InlineButton } from "../ui/button";
import { useAssetUrls } from "../../assets/assetUrls";
import { useThreadShell } from "../../state/entities";
import {
  threadReadLabelPrefix,
  threadReadTargetId,
  threadReadTargetTitle,
  workEntryDisplayLabel,
  workEntryReadOutput,
} from "./MessagesTimeline.logic";
import { cn } from "~/lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { FetchedToolOutput, V2ItemInspector, v2ItemInspectorHasContent } from "./V2ItemInspector";
import { SubagentNotificationLink } from "./V2LifecycleRow";

export function useThreadReadTarget(entry: TimelineWorkEntry, environmentId: EnvironmentId) {
  const rawThreadId = threadReadTargetId(entry);
  const threadId = rawThreadId === null ? null : ThreadId.make(rawThreadId);
  const shell = useThreadShell(threadId ? scopeThreadRef(environmentId, threadId) : null);
  const title = threadReadTargetTitle(shell);
  return threadId && title ? { threadId, title } : null;
}

export function threadReadLabel(label: string, target: ReturnType<typeof useThreadReadTarget>) {
  const prefix = target && threadReadLabelPrefix(label);
  return prefix ? { ...target, prefix, text: `${prefix} “${target.title}”` } : null;
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
  return (
    <span className="flex min-w-0">
      <span className="shrink-0">{label.prefix} “</span>
      {linked ? (
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
      )}
      <span className="shrink-0">”</span>
    </span>
  );
}

const toolCallExpandedBodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-muted-foreground text-(length:--font-size-code,var(--text-2xs)) leading-relaxed select-text";

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
  expandable?: boolean;
  onToggleEntry?: (() => void) | undefined;
  /** A failed test run reads in the error tone, keeping its own tool icon. */
  severeFailure?: boolean | undefined;
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

function WorkEntryLogRow(props: WorkEntryRowProps) {
  const {
    workEntry,
    workspaceRoot,
    displayLabel,
    expandable = true,
    severeFailure = false,
  } = props;
  const ctx = use(TimelineRowCtx);
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
  const toggleExpanded = () => {
    const next = !expanded;
    if (groupView) {
      groupView.onToggleEntry();
      if (next) groupView.state.expandedEntries.add(workEntry.id);
      else groupView.state.expandedEntries.delete(workEntry.id);
    } else {
      props.onToggleEntry?.();
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
    const resetTime = resetAt ? formatUpcomingTimestamp(resetAt, timestampFormat) : null;
    const label = warning
      ? `Usage limit reached.${resetTime ? ` Retry after ${resetTime}.` : ""}`
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
            className={cn("size-4", warning ? "text-warning-foreground" : "text-destructive")}
          />
        }
        label={
          <span
            className={cn(
              "text-sm font-medium",
              warning ? "text-warning-foreground" : "text-destructive",
            )}
          >
            {label}
          </span>
        }
      >
        {!warning ? (
          <p className="ms-7.5 whitespace-pre-wrap break-words py-1 text-sm leading-relaxed text-foreground">
            {failureItem.failure.message}
          </p>
        ) : null}
        {retryRunId !== null && onRetryWorkspacePreparation ? (
          <div className="ms-7.5 pb-1">
            <Button
              type="button"
              size="xs"
              variant="secondary"
              onClick={() => onRetryWorkspacePreparation(retryRunId)}
            >
              <RotateCcwIcon aria-hidden />
              Retry
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
    (severeFailure ||
      workEntrySignalsSevereFailure(workEntry) ||
      !workLogEntryIsToolLike(workEntry));
  const replacesIcon = showWarningIndicator || (showDestructiveRowStyle && !severeFailure);
  const entryIconName = replacesIcon ? "circle-alert" : workEntryIconName(workEntry);
  const entryToolIcon = replacesIcon
    ? undefined
    : (workEntry.toolIcon ?? workEntry.toolSource?.icon);
  const isReasoning = workEntry.itemType === "reasoning";
  const questionHeading = workEntry.questionAnswer
    ? getQuestionTextPreview(workEntry.questionAnswer)
    : "";
  const previewText =
    isReasoning && expanded
      ? workEntry.toolLifecycleStatus === "inProgress"
        ? "Thinking"
        : "Thought"
      : questionHeading || (displayLabel ?? workEntryDisplayLabel(workEntry, workspaceRoot));
  const editItem = workEntry.projectedItem?.item ?? workEntry.structuredPayload;
  const editCounts =
    editItem?.type === "file_change" &&
    (editItem.additions !== undefined || editItem.deletions !== undefined)
      ? { additions: editItem.additions ?? 0, deletions: editItem.deletions ?? 0 }
      : null;
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
  const inspectedItem =
    plainOutput === undefined &&
    workEntry.projectedItem &&
    v2ItemInspectorHasContent(workEntry.projectedItem.item)
      ? workEntry.projectedItem
      : undefined;
  // Check the body before offering a disclosure, including for non-projected entries.
  const expandedBody =
    (expanded || !inspectedItem) && !isReasoning
      ? plainOutput !== undefined
        ? plainOutput
        : buildToolCallExpandedBody(
            workEntry,
            workspaceRoot,
            previewText,
            viewedImage ? viewedImagePath : null,
          )
      : null;
  const plainOutputFetches =
    plainOutput !== undefined &&
    workEntry.projectedItem !== undefined &&
    turnItemNeedsDetailFetch(workEntry.projectedItem.item);
  const canExpandProjectedItem =
    expandable &&
    Boolean(
      expandedBody ||
      inspectedItem ||
      viewedImage ||
      workEntry.questionAnswer ||
      plainOutputFetches ||
      (isReasoning && workEntry.detail?.trim()),
    );
  const iconWrapperClass = cn(
    "flex size-3.5 items-center justify-center",
    showWarningIndicator
      ? "text-warning-foreground"
      : showDestructiveRowStyle
        ? "text-error-foreground"
        : showFailedIndicator
          ? failedToolIconClassName
          : workEntry.tone === "tool"
            ? "text-muted-foreground"
            : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : workLogEntryIsToolLike(workEntry)
        ? "text-secondary-label"
        : "text-foreground/80";
  const threadLabel = isReasoning ? null : threadReadLabel(previewText, threadTarget);
  const accessiblePreview = [
    [threadLabel?.text ?? previewText, answerPreview].filter(Boolean).join(": "),
    editCounts ? `${editCounts.additions} additions, ${editCounts.deletions} deletions` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const accessibleDisplayText = showFailedIndicator
    ? `${accessiblePreview}, tool call failed`
    : accessiblePreview;
  const rowToggleProps = canExpandProjectedItem
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": accessibleDisplayText,
        "aria-expanded": expanded,
        onClick: toggleExpanded,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggleExpanded();
          }
        },
      }
    : {};

  return (
    <WorkLogRow
      data-v2-item-type={workEntry.projectedItem?.item.type}
      data-v2-item-visibility={workEntry.projectedItem?.visibility}
      {...rowToggleProps}
      icon={
        <span
          className={iconWrapperClass}
          role={showFailedIndicator ? "img" : undefined}
          aria-label={showFailedIndicator ? "Tool call failed" : undefined}
        >
          <ToolActivityIconView
            icon={entryToolIcon}
            fallbackName={entryIconName}
            className="block size-3.5 shrink-0 stroke-2"
            muted
          />
        </span>
      }
      label={
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className="flex min-w-0 w-full items-baseline gap-1.25 text-body">
            <span
              className={cn(
                answerPreview || editCounts ? "min-w-0" : "min-w-0 flex-1",
                "truncate",
                headingClass,
              )}
            >
              {isReasoning && !expanded ? (
                <ChatMarkdown
                  inline
                  text={workEntry.detail ?? previewText}
                  cwd={ctx.markdownCwd}
                  parseRawHtml={false}
                  extraRemarkPlugins={
                    workEntry.toolLifecycleStatus === "inProgress"
                      ? THINKING_PREVIEW_PLUGINS
                      : THOUGHT_PREVIEW_PLUGINS
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
            {editCounts ? (
              <span
                aria-hidden
                className="shrink-0 font-sans text-body text-dim-foreground tabular-nums"
              >
                +{editCounts.additions} −{editCounts.deletions}
              </span>
            ) : null}
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
              aria-label={`Open ${createdThread.title ?? "created thread"}`}
              onClick={(event) => {
                event.stopPropagation();
                ctx.onOpenThread(createdThread.targetThreadId);
              }}
              onKeyDown={stopRowToggle}
            >
              Open chat
            </button>
          ) : null}
          {notifiedSubagentThreadId ? (
            <InlineButton
              aria-label="Open subagent thread"
              onClick={(event) => {
                event.stopPropagation();
                ctx.onOpenThread(notifiedSubagentThreadId);
              }}
              onKeyDown={stopRowToggle}
            >
              Open subagent
            </InlineButton>
          ) : null}
          {showFailedIndicator &&
          !showDestructiveRowStyle &&
          !toolIconAcceptsTint(entryToolIcon) ? (
            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
          ) : null}
          {canExpandProjectedItem ? (
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-dim-foreground transition-transform duration-200",
                expanded && "rotate-90",
              )}
            />
          ) : null}
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
            onImageExpand={onImageExpand}
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
      (expandedBody || inspectedItem || plainOutputFetches) ? (
        <WorkLogDetails kind="panel">
          {inspectedItem ? (
            <V2ItemInspector
              projectedItem={inspectedItem}
              environmentId={ctx.activeThreadEnvironmentId}
              cwd={ctx.markdownCwd}
              workspaceRoot={workspaceRoot}
              onOpenToolDiff={ctx.onOpenToolDiff}
              onImageExpand={ctx.onImageExpand}
              source={ctx.turnItemSource}
            />
          ) : (
            <>
              {expandedBody ? (
                <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>
              ) : null}
              {plainOutputFetches && workEntry.projectedItem ? (
                <FetchedToolOutput
                  projectedItem={workEntry.projectedItem}
                  environmentId={ctx.activeThreadEnvironmentId}
                  onImageExpand={onImageExpand}
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

const questionAnswerTextSizeClassName = "text-sm";

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
    <div className="ms-7.5 mt-2 space-y-2" onClick={stopRowToggle}>
      {[
        ...new Set([
          ...Object.keys(answer.questionTextById ?? {}),
          ...Object.keys(answer.answers),
          ...Object.keys(answer.attachmentsByQuestionId),
        ]),
      ].map((questionId) => (
        <div key={questionId} className="space-y-1">
          {answer.questionTextById?.[questionId] ? (
            <p
              className={cn(
                questionAnswerTextSizeClassName,
                "whitespace-pre-wrap text-muted-foreground",
              )}
            >
              {answer.questionTextById[questionId]}
            </p>
          ) : null}
          {getQuestionAnswerText(answer.answers[questionId]) ? (
            <p
              className={cn(
                questionAnswerTextSizeClassName,
                "ms-3 whitespace-pre-wrap text-muted-foreground",
              )}
            >
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
                  className={cn(questionAnswerTextSizeClassName, "underline")}
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
