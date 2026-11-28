import {
  groupRowSpeaker,
  isQuietPass,
  quietPassLine,
  withoutCloseLine,
} from "@t3tools/client-runtime/state/thread-group";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/assistantInsights";
import { trimThreadAutolinkPadding } from "@t3tools/shared/threadLinks";
import { MessageId, type TurnItemId } from "@t3tools/contracts";
import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import { agentWorkingDirectories } from "@t3tools/client-runtime/workspace-basename-lookup";
import { T, useGT, useMessages } from "gt-react";
import { use, useState } from "react";
import { type ChatMessage } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { GitForkIcon, ReplyIcon } from "lucide-react";
import { captureAssistantMessageOpening } from "~/lib/assistantTextSelection";
import { responseContextRecord } from "~/lib/composerContextRecords";
import { Button } from "../ui/button";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { McpAppFrame } from "./McpAppFrame";
import { readResponseSubagents, useAssistantMessageText } from "../../state/entities";
import { MessageCopyButton } from "./MessageCopyButton";
import { AssistantCitationSource } from "./AssistantCitationSource";
import { RememberMessageButton } from "../projectKnowledge/RememberMessageButton";
import { resolveAssistantMessageCopyState } from "./MessagesTimeline.logic";
import { cn } from "~/lib/utils";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { readThreadTurnItems } from "../../state/entities";
import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { TimelineRowCtx, TimelineRowActivityCtx, type TimelineRow } from "./timelineRowContext";
import { MESSAGE_HEADING_LEVEL, MessageAuthorHeading } from "./TimelineRowParts";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const gt = useGT();
  // The timeline holds a streaming message's row while only its text grows.
  const liveText = useAssistantMessageText(
    row.message.streaming ? ctx.threadRef : null,
    row.projectedItem?.item.id,
  );
  const rawText = liveText ?? row.message.text;
  const item = row.projectedItem?.item;
  const speaker = groupRowSpeaker(ctx.group, {
    speaker: item?.type === "assistant_message" ? item.speaker : undefined,
    run: ctx.group == null ? undefined : ctx.runs.find((run) => run.id === item?.runId),
  });
  const text = speaker === null ? rawText : withoutCloseLine(rawText);
  const messageText =
    trimThreadAutolinkPadding(text) ||
    (row.message.streaming || row.suppressEmptyResponse ? "" : gt("(empty response)"));
  if (speaker !== null && !row.message.streaming && isQuietPass(rawText)) {
    return (
      <div className="min-w-0 px-1 py-0.5 text-xs text-muted-foreground">
        <MessageAuthorHeading>{speaker.label}</MessageAuthorHeading>
        {quietPassLine(speaker.label)}
      </div>
    );
  }

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        <MessageAuthorHeading>{speaker?.label ?? "T3 Code"}</MessageAuthorHeading>
        {speaker === null ? null : (
          <p className="mb-0.5 flex items-baseline gap-1.5 text-xs" data-group-speaker="true">
            <span className="font-medium">{speaker.label}</span>
            <span className="text-muted-foreground">{speaker.model}</span>
          </p>
        )}
        <div data-thread-find-text="true">
          <AssistantCitationSource
            messageId={row.message.id}
            {...(ctx.threadRef ? { threadRef: ctx.threadRef } : {})}
            itemKey={row.id}
            request={ctx.citationRequest}
            listRef={ctx.listRef}
          >
            <ChatMarkdown
              text={messageText}
              renderInsights
              previewMarkdownFences
              cwd={ctx.markdownCwd}
              agentDirectories={() =>
                ctx.threadRef && row.projectedItem
                  ? agentWorkingDirectories(readThreadTurnItems(ctx.threadRef), row.projectedItem)
                  : []
              }
              threadRef={ctx.threadRef ?? undefined}
              isStreaming={Boolean(row.message.streaming)}
              streamingId={row.message.id}
              lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
              skills={ctx.skills}
              group={ctx.group}
              headingLevelOffset={MESSAGE_HEADING_LEVEL}
              onUseArtifactTemplate={ctx.onUseArtifactTemplate}
              onRunShellCommand={ctx.onRunShellCommand}
              onImageExpand={ctx.onImageExpand}
            />
          </AssistantCitationSource>
        </div>
        {!row.showAssistantMeta && row.projectedItem?.item.status === "interrupted" ? (
          <div className="mt-1.5 flex">
            <AssistantStatusBadge status="interrupted" />
          </div>
        ) : null}
        {row.showAssistantMeta ? (
          <AssistantMessageMeta
            className="mt-1.5"
            projectedItem={row.projectedItem}
            message={row.message}
            showCopyButton={row.showAssistantCopyButton}
            copyStreaming={row.assistantCopyStreaming}
          />
        ) : null}
      </div>
    </>
  );
}

/** Text an agent sent with `send_to_user`, shown as its own words. */
export function SentMessageTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "sent-message" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <MessageAuthorHeading>T3 Code</MessageAuthorHeading>
      {/* Sent messages have no message id; citations name their turn item instead. */}
      <AssistantCitationSource
        messageId={MessageId.make(row.id)}
        {...(ctx.threadRef ? { threadRef: ctx.threadRef } : {})}
        itemKey={row.id}
        request={ctx.citationRequest}
        listRef={ctx.listRef}
      >
        <ChatMarkdown
          text={row.text}
          previewMarkdownFences
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          lineBreaks={shouldPreserveAssistantLineBreaks(row.text)}
          skills={ctx.skills}
          group={ctx.group}
          headingLevelOffset={MESSAGE_HEADING_LEVEL}
          onUseArtifactTemplate={ctx.onUseArtifactTemplate}
          onRunShellCommand={ctx.onRunShellCommand}
          onImageExpand={ctx.onImageExpand}
        />
      </AssistantCitationSource>
    </div>
  );
}

function AssistantForkButton({
  projectedItem,
}: {
  readonly projectedItem: NonNullable<Extract<TimelineRow, { kind: "message" }>["projectedItem"]>;
}) {
  const ctx = use(TimelineRowCtx);
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const support = useV2ItemSupport({
    environmentId: ctx.activeThreadEnvironmentId,
    sourceThreadId: projectedItem.sourceThreadId,
    sourceItemId: projectedItem.sourceItemId,
  });
  const canFork = canForkProjectedAssistantItem({
    projectedItem,
    capabilities: support.providerSession?.capabilities,
  });

  const onForkFromRun = ctx.onForkFromRun;
  if (!canFork || onForkFromRun === undefined || projectedItem.item.runId === null) return null;
  const runId = projectedItem.item.runId;

  return (
    <SharedTooltipTrigger
      render={
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onForkFromRun({ sourceThreadId: projectedItem.sourceThreadId, runId }).finally(
              () => setBusy(false),
            );
          }}
          aria-label={gt("Fork from this response")}
        />
      }
      label={
        <>
          <T>Fork from this response</T>
        </>
      }
    >
      <GitForkIcon className={cn("size-3", busy && "animate-pulse")} />
    </SharedTooltipTrigger>
  );
}

export function AssistantMetaTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "assistant-meta" }>;
}) {
  return (
    <div className="px-1">
      <AssistantMessageMeta
        className="mt-0.5"
        projectedItem={row.projectedItem}
        message={row.message}
        showCopyButton={row.showAssistantCopyButton}
        copyStreaming={row.assistantCopyStreaming}
        alwaysVisible
      />
    </div>
  );
}

function AssistantMessageMeta({
  className,
  projectedItem,
  message,
  showCopyButton,
  copyStreaming,
  alwaysVisible = false,
}: {
  className?: string;
  projectedItem?: Extract<TimelineRow, { kind: "message" }>["projectedItem"];
  message: ChatMessage;
  showCopyButton: boolean;
  copyStreaming: boolean;
  alwaysVisible?: boolean;
}) {
  const ctx = use(TimelineRowCtx);
  const m = useMessages();

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200",
        alwaysVisible
          ? "opacity-100"
          : "opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100",
        className,
      )}
    >
      {projectedItem && projectedItem.item.status !== "completed" ? (
        <AssistantStatusBadge status={projectedItem.item.status} />
      ) : null}
      <AssistantCopyButton
        message={ctx.group == null ? message : { ...message, text: withoutCloseLine(message.text) }}
        showCopyButton={showCopyButton}
        streaming={copyStreaming}
      />
      {projectedItem?.item.type === "assistant_message" ? (
        <AssistantForkButton projectedItem={projectedItem} />
      ) : null}
      {!message.streaming && message.text ? (
        <RememberMessageButton
          threadRef={ctx.threadRef}
          sourceThreadId={projectedItem?.sourceThreadId}
          messageId={message.id}
        />
      ) : null}
      {!message.streaming && projectedItem ? (
        <AssistantReplyButton message={message} itemId={projectedItem.sourceItemId} />
      ) : null}
      {!message.streaming && (
        <SharedTooltipTrigger
          render={<p className="text-muted-foreground text-xs tabular-nums" />}
          label={formatChatTimestampTooltip(message.updatedAt, ctx.timestampFormat, m)}
        >
          {formatDayAwareTimestamp(message.updatedAt, ctx.timestampFormat, undefined, undefined, m)}
        </SharedTooltipTrigger>
      )}
    </div>
  );
}

function AssistantReplyButton({ message, itemId }: { message: ChatMessage; itemId: TurnItemId }) {
  const ctx = use(TimelineRowCtx);
  const gt = useGT();
  const { threadRef, onReplyToResponse } = ctx;
  if (!threadRef || !onReplyToResponse || !message.text.trim()) return null;

  const reply = () => {
    // The meta row can sit below trailing tool rows, so the message may be virtualized away.
    const source = [
      ...document.querySelectorAll<HTMLElement>("[data-assistant-citation-source]"),
    ].find(
      (element) =>
        element.dataset.assistantCitationSource === message.id &&
        element.dataset.assistantCitationThread === threadRef.threadId &&
        element.dataset.assistantCitationEnvironment === threadRef.environmentId,
    );
    const opening = captureAssistantMessageOpening(source ?? null, message.text);
    if (!opening) return;
    onReplyToResponse(
      responseContextRecord({
        citation: { version: 1, ...threadRef, messageId: message.id, ...opening },
        itemId,
        subagents: readResponseSubagents(threadRef, itemId),
      }),
    );
  };

  return (
    <SharedTooltipTrigger
      render={
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          onClick={reply}
          aria-label={gt("Reply to this response")}
        />
      }
      label={
        <>
          <T>Reply to this response</T>
        </>
      }
    >
      <ReplyIcon className="size-3" />
    </SharedTooltipTrigger>
  );
}

function AssistantStatusBadge({ status }: { status: string }) {
  return (
    <span className="rounded-full border border-border/70 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
      {status}
    </span>
  );
}

function AssistantCopyButton({
  message,
  showCopyButton,
  streaming,
}: {
  message: ChatMessage;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: message.text ?? null,
    showCopyButton,
    streaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

export function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
        findActive={ctx.findActive}
      />
    </div>
  );
}

export function HtmlRenderTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "html-render" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const { onAppFullscreenChange } = ctx;
  const onFullscreenChange = (fullscreen: boolean) => onAppFullscreenChange(row.id, fullscreen);

  if (ctx.renderHtmlRender) {
    return <div className="min-w-0 px-1">{ctx.renderHtmlRender(row)}</div>;
  }
  return (
    <div className="html-preview-lane min-w-0 px-1">
      <HtmlRenderFrame
        key={row.htmlRender.attachmentId}
        environmentId={ctx.activeThreadEnvironmentId}
        htmlRender={row.htmlRender}
        threadRef={ctx.threadRef ?? undefined}
        onFullscreenChange={onFullscreenChange}
      />
    </div>
  );
}

export function McpAppTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "mcp-app" }> }) {
  const ctx = use(TimelineRowCtx);
  const { awaitingUser } = use(TimelineRowActivityCtx);

  return (
    <div className="min-w-0 px-1">
      <McpAppFrame
        key={row.mcpApp.attachmentId}
        environmentId={ctx.activeThreadEnvironmentId}
        threadId={row.sourceThreadId}
        conversationThreadId={ctx.threadRef?.threadId ?? row.sourceThreadId}
        itemId={row.itemId}
        revision={row.revision}
        app={row.mcpApp}
        onSendMessage={ctx.onSendAppMessage}
        awaitingUser={awaitingUser}
        onFullscreenChange={(fullscreen) => ctx.onAppFullscreenChange(row.id, fullscreen)}
      />
    </div>
  );
}
