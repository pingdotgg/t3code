import { InlineAudioPreview } from "../files/InlineAudioPreview";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { findRevealRef } from "./markdownFindContext";
import {
  type EnvironmentId,
  type MessageId,
  type ScheduledTaskId,
  type ServerProviderSkill,
  ThreadId,
} from "@t3tools/contracts";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { Link } from "@tanstack/react-router";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { memo, use, useState, type ReactNode } from "react";
import {
  createMessageAttachmentPreviewProjector,
  selectMessageImageResources,
} from "../../session-logic";
import {
  type ChatFileAttachment,
  isFileAttachment,
  isImageAttachment,
  isVideoAttachment,
} from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import {
  CalendarClockIcon,
  ChevronDownIcon,
  DownloadIcon,
  EyeIcon,
  type LucideIcon,
  MessagesSquareIcon,
  Redo2Icon,
  PencilIcon,
} from "lucide-react";
import { Link as LinkIconNode } from "lucide";
import { Button, InlineButton } from "../ui/button";
import { ModelSwitchRow } from "./V2LifecycleRow";
import { useAssetUrlRefresh, useAssetUrls, useAssetUrlState } from "../../assets/assetUrls";
import { AttachmentImage } from "../media/AttachmentImage";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import {
  buildAttachmentVideoAsset,
  buildAttachmentVideoPreview,
  buildExpandedImagePreview,
} from "./ExpandedImagePreview";
import {
  SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
  SnapShotAttachmentDetails,
} from "./SnapShotAttachmentDetails";
import { GuestMessageName, guestBubbleClassName } from "./guestMessageStyle";
import { MessageCopyButton } from "./MessageCopyButton";
import { promptLinkFor } from "../promptLinks/copyPromptLink";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { formatBytes } from "../../lib/formatBytes";
import { shouldCollapseUserMessage } from "./MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  asKnownContextRecord,
  resolveUserMessageContext,
  selectedMessageContextFragment,
} from "~/lib/composerContextRecords";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { chatMarkdownClipboardPayload } from "../../markdown-clipboard";
import type { ChatMarkdownContextReference } from "../ChatMarkdown";
import { cn } from "~/lib/utils";
import { markdownProseDirection } from "~/textDirection";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { WorkflowOpeningBlock } from "./WorkflowOpeningBlock";
import { TimelineRowCtx, TimelineRowActivityCtx, type TimelineRow } from "./timelineRowContext";
import {
  MESSAGE_HEADING_LEVEL,
  MessageAuthorHeading,
  TimelineRowTimestamp,
} from "./TimelineRowParts";
import { UserMessageContextReferenceChip } from "./UserMessageContextChips";
import {
  resolvePreviewAnnotationImage,
  userMessageFileLabel,
} from "./TimelineUserMessageRow.logic";
import { UserTimelineRow } from "./TimelineUserMessageRowParts";

// Drawn inside the media so dark screenshots keep an edge on the dark background.
export const MEDIA_EDGE_CLASS_NAME =
  "relative after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-black/9 dark:after:ring-white/12";

export const BUBBLE_CHIP_CLASS_NAME =
  "[&_[data-slot=context-chip]]:[--context-chip-ink:var(--context-chip-message,var(--context-chip-accent))]";

export function UserFileCard({
  file,
  copyMarkdown,
}: {
  readonly file: ChatFileAttachment;
  readonly copyMarkdown: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  const pastedText = file.source?._tag === "pasted-text";
  const label = userMessageFileLabel(file);
  const extension = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1]?.toUpperCase() ?? "File";
  const identity = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background/60">
        <PierreEntryIcon pathValue={file.name} kind="file" theme={ctx.resolvedTheme} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium group-hover/file:underline">
          {label}
        </span>
        <span className="block text-xs text-muted-foreground tabular-nums">
          {file.downloadable === false ? (
            "Sending…"
          ) : (
            <>
              {!pastedText && `${extension} · `}
              {formatBytes(file.sizeBytes)}
            </>
          )}
        </span>
      </span>
    </>
  );
  return (
    <div
      data-markdown-copy={copyMarkdown}
      className="flex w-64 max-w-full items-center gap-1 rounded-2xl bg-message py-2 ps-2 pe-1 text-message-foreground"
    >
      {file.downloadable === false ? (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-3">{identity}</div>
          <Button size="icon-xs" variant="ghost-muted" disabled aria-label="Sending attachment">
            <DownloadIcon />
          </Button>
        </>
      ) : (
        <>
          <button
            type="button"
            aria-label={`Preview ${label}`}
            onClick={() => ctx.onFileOpen(file)}
            className="group/file focus-visible:ring-ring/70 flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl text-left focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
          >
            {identity}
          </button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Download ${label}`}
                  onClick={() => ctx.onFileDownload(file)}
                />
              }
            >
              <DownloadIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Download {label}</TooltipPopup>
          </Tooltip>
        </>
      )}
    </div>
  );
}

export function UserVideoAttachment({
  file,
  standalone = false,
  cornerClassName,
}: {
  readonly file: ChatFileAttachment;
  readonly standalone?: boolean;
  readonly cornerClassName?: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  // Row updates rebuild attachment objects, so the asset follows only the
  // fields it reads.
  const { downloadable, id, mimeType, name } = file;
  const environmentId = ctx.activeThreadEnvironmentId;
  const asset =
    downloadable === false
      ? null
      : buildAttachmentVideoAsset(environmentId, { id, mimeType, name });
  const resource = asset?.resource ?? null;
  const assetUrl = useAssetUrlState(ctx.activeThreadEnvironmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(ctx.activeThreadEnvironmentId, resource);
  const src = assetUrl._tag === "Success" ? assetUrl.url : (file.previewUrl ?? null);

  if (asset === null && src === null) {
    return (
      <div
        className={cn(
          "flex aspect-[4/3] w-full items-center justify-center bg-black px-2 py-3 text-center text-2xs text-white/70",
          standalone
            ? cn(MEDIA_EDGE_CLASS_NAME, "rounded-2xl", cornerClassName)
            : "rounded-lg border border-border/80",
        )}
      >
        {file.name}
      </div>
    );
  }

  const player = (
    <MediaVideoPlayer
      src={src}
      sourceFailed={
        file.previewUrl === undefined && resource !== null && assetUrl._tag === "Failure"
      }
      label={file.name}
      preload="visible"
      onOpen={() => {
        const preview = buildAttachmentVideoPreview(ctx.activeThreadEnvironmentId, file);
        if (preview) ctx.onImageExpand(preview);
      }}
      className="block aspect-[4/3] w-full"
      videoClassName={cn(
        "aspect-auto size-full",
        !standalone && "rounded-lg border border-border/80",
      )}
      stateClassName={cn(
        "aspect-auto min-h-full bg-black text-white",
        !standalone && "rounded-lg border border-border/80",
      )}
      onRetry={asset ? refreshAssetUrl : undefined}
      actionsSource={asset ? { kind: "video", name: file.name, src, asset } : undefined}
    />
  );
  return standalone ? (
    <div className={cn(MEDIA_EDGE_CLASS_NAME, "overflow-hidden rounded-2xl", cornerClassName)}>
      {player}
    </div>
  ) : (
    player
  );
}

export function UserMessageRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const item = row.projectedItem?.item;
  const modelSwitch = item?.type === "user_message" ? item.modelSwitch : undefined;
  return (
    <>
      {modelSwitch ? (
        <ModelSwitchRow environmentId={ctx.activeThreadEnvironmentId} modelSwitch={modelSwitch} />
      ) : null}
      <UserMessageContent row={row} />
    </>
  );
}

function UserMessageContent({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  return ctx.workflowOpening?.messageId === row.message.id ? (
    <WorkflowOpeningBlock
      opening={ctx.workflowOpening}
      environmentId={ctx.activeThreadEnvironmentId}
      onOpenThread={(threadId) => ctx.onOpenThread(ThreadId.make(threadId))}
    />
  ) : resolveUserMessagePresentation(row.message).attribution === "automation" ? (
    <AutomationMessageRow row={row} />
  ) : (
    <UserTimelineRow row={row} />
  );
}

/** Automation prompts are long, repeated runbooks; a folded bubble keeps them out of the way. */
function AutomationMessageRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const [expanded, setExpanded] = useState(false);
  const revealRef = findRevealRef(() => setExpanded(true));
  const { text, scheduledTaskId } = resolveUserMessagePresentation(row.message);
  const summary =
    useScheduledTaskTitle(ctx.activeThreadEnvironmentId, scheduledTaskId) ??
    text.trim().split(/\r?\n/, 1)[0] ??
    "";

  const revertTurnCount = row.revertTurnCount;
  const promptLink = promptLinkFor(text);
  // Find reads the DOM, so a folded prompt stays mounted but hidden while find is open.
  const bodyMounted = expanded || ctx.findActive;

  return (
    <div className="group flex flex-col items-end gap-1" data-user-message-attribution="automation">
      {row.message.inputIntent === "steer" ||
      row.message.inputIntent === "promoted_queued_to_steer" ? (
        <UserMessageIntentMarker intent={row.message.inputIntent} />
      ) : null}
      <div
        className={cn(
          "min-w-0 max-w-[80%] rounded-2xl bg-message text-message-foreground",
          BUBBLE_CHIP_CLASS_NAME,
          expanded && "w-full",
        )}
      >
        <MessageAuthorHeading>Automation</MessageAuthorHeading>
        <FoldedMessageHeader
          icon={CalendarClockIcon}
          label="Automation"
          summary={summary}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
        />
        {bodyMounted ? (
          // `beforematch` does not bubble, so the reveal listener sits on the hidden fold itself.
          <div
            ref={revealRef}
            hidden={!expanded}
            className={cn("px-3 pb-3", !ctx.findActive && "max-h-96 overflow-auto")}
            data-thread-find-text="true"
          >
            <UserMessageBody text={text} skills={ctx.skills} markdownCwd={ctx.markdownCwd} />
          </div>
        ) : null}
      </div>
      <UserMessageProjectedStatus row={row} />
      {expanded ? (
        <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100">
          <div className="flex shrink-0 items-center gap-2">
            {scheduledTaskId ? (
              <Link
                to="/settings/scheduled-tasks"
                search={{ environmentId: ctx.activeThreadEnvironmentId, taskId: scheduledTaskId }}
                className="rounded-sm text-xs text-muted-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                Open automation
              </Link>
            ) : null}
            <TimelineRowTimestamp
              createdAt={row.message.createdAt}
              timestampFormat={ctx.timestampFormat}
              alwaysVisible
            />
            <div className="flex items-center gap-0.5">
              {typeof revertTurnCount === "number" && (
                <RevertUserMessageButton turnCount={revertTurnCount} messageId={row.message.id} />
              )}
              <MessageCopyButton text={text} variant="ghost" />
              {promptLink !== null && (
                <MessageCopyButton
                  text={promptLink}
                  label="Copy prompt link"
                  icon={LinkIconNode}
                  variant="ghost"
                />
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function useScheduledTaskTitle(
  environmentId: EnvironmentId,
  scheduledTaskId: ScheduledTaskId | undefined,
): string | undefined {
  const tasksQuery = useEnvironmentQuery(
    scheduledTaskId ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  return tasksQuery.data?.tasks.find((task) => task.id === scheduledTaskId)?.title;
}

export function FoldedMessageHeader(props: {
  icon: LucideIcon;
  label: string;
  summary: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      aria-expanded={props.expanded}
      data-scroll-anchor-ignore
      onClick={props.onToggle}
      className="flex w-full min-w-0 items-center gap-1.5 rounded-2xl px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring"
    >
      <Icon className="size-4 shrink-0 stroke-2 text-muted-foreground" />
      <span className="max-w-1/2 shrink-0 truncate text-muted-foreground">{props.label}</span>
      <span className="min-w-0 flex-1 truncate">{props.summary}</span>
      <ChevronDownIcon
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          props.expanded && "rotate-180",
        )}
      />
    </button>
  );
}

export function UserMessageProjectedStatus({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const status = row.projectedItem?.item.status;
  if (
    status === undefined ||
    status === "completed" ||
    status === "pending" ||
    status === "waiting"
  )
    return null;
  return (
    <div className="me-1 flex items-center gap-1.5">
      <span className="rounded-full border border-destructive/25 bg-destructive/8 px-1.5 py-0.5 text-3xs font-medium text-destructive">
        {status}
      </span>
    </div>
  );
}

export const ACTIONS_REVEAL_CLASS_NAME =
  "items-center text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100";

export function UserMessageIntentMarker({
  intent,
}: {
  readonly intent: "steer" | "promoted_queued_to_steer";
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="me-1 flex items-center justify-end gap-1 text-xs leading-none text-muted-foreground"
            data-user-message-intent={intent}
          />
        }
      >
        <Redo2Icon aria-hidden="true" className="size-3" />
        Steer
      </TooltipTrigger>
      <TooltipPopup side="top">
        {intent === "promoted_queued_to_steer"
          ? "Originally queued, then promoted to steer the active turn"
          : "Steered the active turn"}
      </TooltipPopup>
    </Tooltip>
  );
}

export function RevertUserMessageButton({
  turnCount,
  messageId,
}: {
  turnCount: number;
  messageId: MessageId;
}) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activity.isRevertingCheckpoint || activity.isWorking}
            onClick={() => ctx.onRevertToTurnCount(turnCount, messageId)}
            aria-label="Edit from here"
          />
        }
      >
        <PencilIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Edit from here</TooltipPopup>
    </Tooltip>
  );
}

const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;

const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

export const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  renderContextReference: (reference: ChatMarkdownContextReference) => ReactNode;
  skills: ReadonlyArray<ServerProviderSkill>;
  markdownCwd: string | undefined;
  collapsible?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const revealForFind = () => setExpanded(true);
  const revealRef = findRevealRef(revealForFind);
  const hasVisibleBody = props.text.trim().length > 0;
  const canCollapse =
    props.collapsible !== false && hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;
  const showCollapseControl = canCollapse;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          ref={revealRef}
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-thread-find-text="true"
          data-thread-find-fold={isCollapsed ? "" : undefined}
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            text={props.text}
            renderContextReference={props.renderContextReference}
            skills={props.skills}
            markdownCwd={props.markdownCwd}
          />
        </div>
      ) : null}
      {showCollapseControl ? (
        <div className="mt-1.5 flex items-center justify-end gap-2" data-user-message-footer="true">
          {showCollapseControl ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  renderContextReference?: (reference: ChatMarkdownContextReference) => ReactNode;
  skills: ReadonlyArray<ServerProviderSkill>;
  markdownCwd: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  if (props.text.length === 0) {
    return null;
  }
  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.markdownCwd}
      threadRef={ctx.threadRef ?? undefined}
      skills={props.skills}
      className="text-foreground"
      lineBreaks
      parseRawHtml={false}
      renderContextReference={props.renderContextReference}
      headingLevelOffset={MESSAGE_HEADING_LEVEL}
    />
  );
});
