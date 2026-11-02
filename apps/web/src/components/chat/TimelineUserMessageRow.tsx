import { InlineAudioPreview } from "../files/InlineAudioPreview";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { type TimelineRow, TimelineRowActivityCtx, TimelineRowCtx } from "./timelineRowContext";
import {
  MESSAGE_HEADING_LEVEL,
  MessageAuthorHeading,
  SlashCommandChip,
  TimelineRowTimestamp,
} from "./TimelineRowParts";
import {
  resolvePreviewAnnotationImage,
  userMessageFileLabel,
} from "./TimelineUserMessageRow.logic";
import { UserMessageContextReferenceChip } from "./UserMessageContextChips";
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
import {
  replaceComposerContextReferences,
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { memo, use, useState, type ReactNode } from "react";
import {
  createMessageAttachmentPreviewProjector,
  selectMessageImageResources,
} from "../../session-logic";
import {
  type ChatFileAttachment,
  type ChatMessage,
  isFileAttachment,
  isImageAttachment,
  isVideoAttachment,
} from "../../types";
import ChatMarkdown, { type ChatMarkdownContextReference } from "../ChatMarkdown";
import {
  CalendarClockIcon,
  ChevronDownIcon,
  DownloadIcon,
  EyeIcon,
  type LucideIcon,
  MessagesSquareIcon,
  PencilIcon,
  Redo2Icon,
} from "lucide-react";
import { Link as LinkIconNode } from "lucide";
import { Button, InlineButton } from "../ui/button";
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
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { chatMarkdownClipboardPayload } from "../../markdown-clipboard";
import { cn } from "~/lib/utils";
import { markdownProseDirection } from "~/textDirection";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { WorkflowOpeningBlock } from "./WorkflowOpeningBlock";

// Drawn inside the media so dark screenshots keep an edge on the dark background.
const MEDIA_EDGE_CLASS_NAME =
  "relative after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-black/9 dark:after:ring-white/12";

const BUBBLE_CHIP_CLASS_NAME =
  "[&_[data-slot=context-chip]]:[--context-chip-ink:var(--context-chip-message,var(--context-chip-accent))]";

function UserFilePreview(props: useRender.ComponentProps<"button">) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        type: "button",
        className:
          "group/file focus-visible:ring-ring/70 flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-control text-left focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none",
      },
      props,
    ),
  });
}

function UserFileCard({
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
        <span className="block truncate text-body group-hover/file:underline">{label}</span>
        <span className="block text-caption text-dim-foreground tabular-nums">
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
      className="flex w-64 max-w-full items-center gap-1 rounded-2xl surface-bubble py-2 ps-2 pe-1 text-foreground"
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
          <UserFilePreview aria-label={`Preview ${label}`} onClick={() => ctx.onFileOpen(file)}>
            {identity}
          </UserFilePreview>
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

function UserVideoAttachment({
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
          "flex aspect-[4/3] w-full items-center justify-center bg-black px-2 py-3 text-center text-caption text-white/70",
          standalone
            ? cn(MEDIA_EDGE_CLASS_NAME, "rounded-2xl", cornerClassName)
            : "rounded-lg border border-border",
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
      videoClassName={cn("aspect-auto size-full", !standalone && "rounded-lg border border-border")}
      stateClassName={cn(
        "aspect-auto min-h-full bg-black text-white",
        !standalone && "rounded-lg border border-border",
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

function AutomationMessageToggle(props: useRender.ComponentProps<"button">) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        type: "button",
        className:
          "flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-pane px-3.5 py-2.5 text-left text-body focus-visible:outline-2 focus-visible:outline-ring",
      },
      props,
    ),
  });
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
  const userMessageMeta = resolveUserMessageMeta(row.message.inputIntent, row.steerOffsetMs);

  return (
    <div
      className="group/user-row flex flex-col items-end gap-1"
      data-user-message-attribution="automation"
    >
      <div
        className={cn(
          "min-w-0 max-w-[80%] rounded-pane surface-bubble text-foreground",
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
            <UserMessageBody
              text={text}
              skills={ctx.skills}
              markdownCwd={ctx.markdownCwd}
              leadingCommand={row.command?.sigil === "/" ? row.command.name : undefined}
            />
          </div>
        ) : null}
      </div>
      {userMessageMeta && !row.continuesSteer ? (
        <UserMessageMeta intent={userMessageMeta.intent} label={userMessageMeta.label} />
      ) : null}
      <UserMessageProjectedStatus row={row} />
      {expanded ? (
        <div className="flex items-center justify-end whitespace-nowrap text-meta tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:static pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/user-row:opacity-100 has-[button]:-me-1.5">
          <div className="flex shrink-0 items-center gap-2">
            {scheduledTaskId ? (
              <InlineButton
                tone="muted"
                render={
                  <Link
                    to="/settings/scheduled-tasks"
                    search={{
                      environmentId: ctx.activeThreadEnvironmentId,
                      taskId: scheduledTaskId,
                    }}
                  />
                }
              >
                Open automation
              </InlineButton>
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
    <AutomationMessageToggle
      aria-expanded={props.expanded}
      data-scroll-anchor-ignore
      onClick={props.onToggle}
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
    </AutomationMessageToggle>
  );
}

function UserMessageProjectedStatus({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const status = row.projectedItem?.item.status;
  if (
    status === undefined ||
    status === "completed" ||
    status === "pending" ||
    status === "waiting"
  )
    return null;
  return (
    <div className="flex items-center gap-1.5">
      <span className="rounded-badge border border-transparent bg-error-tint px-1.5 py-0.5 text-micro text-error-foreground">
        {status}
      </span>
    </div>
  );
}

/** The "Sent by" line above a user message that someone other than the user sent. */
const USER_MESSAGE_ATTRIBUTION_CLASS_NAME = "text-2xs text-dim-foreground";

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const { onImageExpand, onFileOpen } = ctx;
  const coarsePointer = useMediaQuery({ pointer: "coarse" });
  const senderThreadId = row.message.senderThreadId;
  const resources = selectMessageImageResources(row.message.attachments);
  const previewUrls = useAssetUrls(ctx.activeThreadEnvironmentId, resources);
  const [projectPreviews] = useState(createMessageAttachmentPreviewProjector);
  const previewUrlsById = new Map(
    resources.flatMap((resource, index) => {
      const url = previewUrls[index];
      return url ? [[resource.attachmentId, url] as const] : [];
    }),
  );
  const messageWithPreviews = projectPreviews(row.message, (attachment) =>
    previewUrlsById.get(attachment.id),
  );
  const userImages = (messageWithPreviews.attachments ?? []).filter(isImageAttachment);
  const userFiles = (row.message.attachments ?? []).filter(isFileAttachment);
  const userVideos = userFiles.filter(isVideoAttachment);
  const userAudio = userFiles.filter(
    (file) => file.downloadable !== false && filePreviewKind(file) === "audio",
  );
  const otherUserFiles = userFiles.filter(
    (file) => !isVideoAttachment(file) && !userAudio.includes(file),
  );
  const unknownAttachments = (row.message.attachments ?? []).filter(
    (attachment) => !isImageAttachment(attachment) && !isFileAttachment(attachment),
  );
  const userMessage = resolveUserMessagePresentation(row.message);
  // Messages from other agents fold to one line so the user's own messages stay easy to find.
  const folded = userMessage.attribution === "agent";
  const [expanded, setExpanded] = useState(false);
  const revealFoldRef = findRevealRef(() => setExpanded(true));
  const senderShell = useQuietThreadShell(
    folded && senderThreadId
      ? { environmentId: ctx.activeThreadEnvironmentId, threadId: senderThreadId }
      : null,
  );
  const senderLabel = senderShell?.title.trim() || "Agent";
  const resolvedContext = resolveUserMessageContext({ ...row.message, text: userMessage.text });
  const previewImages = userImages.filter((image) => image.name.startsWith("preview-annotation-"));
  const revertTurnCount = row.revertTurnCount;
  const attachmentReferences = collectComposerContextReferences(resolvedContext.text).flatMap(
    (occurrence) => {
      const record = asKnownContextRecord(resolvedContext.recordsById.get(occurrence.contextId));
      return record?.kind === "file" || record?.kind === "image"
        ? [
            {
              attachmentId: record.attachmentId,
              contextId: occurrence.contextId,
              source: occurrence.source,
            },
          ]
        : [];
    },
  );
  const chippedAttachmentIds = new Set(
    attachmentReferences.map((reference) => reference.attachmentId),
  );
  const regularImages = userImages.filter((image) => !image.name.startsWith("preview-annotation-"));
  const unchippedFiles = otherUserFiles.filter((file) => !chippedAttachmentIds.has(file.id));
  // Images or videos sent without words show as media, not as a bubble around them.
  const mediaOnly =
    !folded &&
    userMessage.attribution !== "guest" &&
    resolvedContext.text.trim() === "" &&
    userAudio.length === 0 &&
    unchippedFiles.length === 0 &&
    unknownAttachments.length === 0 &&
    regularImages.length + userVideos.length > 0;
  // Media sent with words sits above the bubble as its own shape, like a chat app.
  const mediaAboveText =
    !folded &&
    userMessage.attribution !== "guest" &&
    !mediaOnly &&
    regularImages.length + userVideos.length > 0;
  const standaloneMedia = mediaOnly || mediaAboveText;
  // A lone image keeps its own shape; a 4:3 crop hides most of a wide screenshot.
  const loneImage = standaloneMedia && userVideos.length === 0 && regularImages.length === 1;
  // Several images share one rounded shape, split by hairlines.
  const collage =
    standaloneMedia &&
    userVideos.length === 0 &&
    regularImages.length > 1 &&
    regularImages.every((image) => image.source?.kind !== "snap-shot");
  // Corners that touch the bubble or a neighbouring message tighten, like the bubble's.
  const mediaCornerClassName = cn(
    row.groupedWithPrevious && "rounded-tr-md",
    (mediaAboveText || row.groupedWithNext) && "rounded-br-md",
  );
  // Files sent without words show as cards, not as a bubble around a name chip.
  const fileCardsOnly =
    !folded &&
    userMessage.attribution !== "guest" &&
    otherUserFiles.length > 0 &&
    regularImages.length + userVideos.length + userAudio.length + unknownAttachments.length === 0 &&
    replaceComposerContextReferences(resolvedContext.text, (reference) =>
      attachmentReferences.some(
        (attached) =>
          attached.contextId === reference.contextId &&
          otherUserFiles.some((file) => file.id === attached.attachmentId),
      )
        ? ""
        : reference.label,
    ).trim() === "";
  const audioOnly =
    !folded &&
    userMessage.attribution !== "guest" &&
    userAudio.length > 0 &&
    regularImages.length + userVideos.length + otherUserFiles.length + unknownAttachments.length ===
      0 &&
    replaceComposerContextReferences(resolvedContext.text, (reference) =>
      attachmentReferences.some(
        (attached) =>
          attached.contextId === reference.contextId &&
          userAudio.some((file) => file.id === attached.attachmentId),
      )
        ? ""
        : reference.label,
    ).trim() === "";
  const annotationRecordIds = resolvedContext.records
    .filter((record) => record.kind === "preview-annotation")
    .map((record) => record.contextId);
  const plainText = replaceComposerContextReferences(
    resolvedContext.text,
    (reference) => reference.label,
  );
  const promptLink = promptLinkFor(plainText);
  const foldSummary =
    plainText
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  const mediaCopyRecords = mediaOnly
    ? resolvedContext.records.flatMap((record) => {
        const known = asKnownContextRecord(record);
        return (known?.kind === "image" || known?.kind === "file") &&
          (regularImages.some((image) => image.id === known.attachmentId) ||
            userVideos.some((file) => file.id === known.attachmentId))
          ? [known]
          : [];
      })
    : [];
  const copyRecords = mediaOnly ? mediaCopyRecords : resolvedContext.records;
  const contextClipboardFragment =
    copyRecords.length === 0
      ? null
      : encodeComposerContextFragment({
          version: 1,
          source: {
            environmentId: ctx.activeThreadEnvironmentId,
            ...(ctx.threadRef ? { threadId: ctx.threadRef.threadId } : {}),
            messageId: row.message.id,
          },
          records: copyRecords,
        });
  const copyText =
    resolvedContext.text || mediaCopyRecords.map(formatComposerContextReference).join("\n");
  const onBodyCopyCapture = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (resolvedContext.records.length === 0 || !event.clipboardData) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const copiedMarkdown: string[] = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const container = document.createElement("div");
      container.appendChild(selection.getRangeAt(index).cloneContents());
      // Diagram source is copied text, not authority to export context records.
      for (const element of container.querySelectorAll(
        "[data-markdown-copy]:not([data-markdown-mermaid])",
      )) {
        copiedMarkdown.push(element.getAttribute("data-markdown-copy") ?? "");
      }
    }
    const fragment = selectedMessageContextFragment({
      markdown: copiedMarkdown.join("\n"),
      records: resolvedContext.records,
      environmentId: ctx.activeThreadEnvironmentId,
      ...(ctx.threadRef ? { threadId: ctx.threadRef.threadId } : {}),
      messageId: row.message.id,
    });
    if (!fragment) return;
    // Claim the copy: without preventDefault the browser default overwrites the
    // custom MIME type. The default content must then be written back explicitly.
    const payload = chatMarkdownClipboardPayload(selection);
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload?.text ?? selection.toString());
    if (payload) {
      event.clipboardData.setData(
        "text/html",
        encodeComposerContextClipboardHtml(payload.text, fragment, payload.html),
      );
    }
    event.clipboardData.setData(COMPOSER_CONTEXT_CLIPBOARD_MIME, fragment);
  };
  const renderContextReference = (reference: ChatMarkdownContextReference) => {
    const record = asKnownContextRecord(resolvedContext.recordsById.get(reference.contextId));
    if (record?.kind === "file" && userAudio.some((file) => file.id === record.attachmentId))
      return null;
    const annotationImage =
      record?.kind === "preview-annotation"
        ? resolvePreviewAnnotationImage({
            record,
            recordsById: resolvedContext.recordsById,
            userImages,
            previewImages,
            annotationRecordIds,
          })
        : null;
    const attachment =
      record?.kind === "image"
        ? (userImages.find((image) => image.id === record.attachmentId) ?? null)
        : record?.kind === "file"
          ? (userFiles.find((file) => file.id === record.attachmentId) ?? null)
          : null;
    return (
      <span data-thread-find-ignore>
        <UserMessageContextReferenceChip
          reference={reference}
          record={record}
          annotationImage={annotationImage}
          attachment={attachment}
          onExpandImage={(image) => {
            const preview = buildExpandedImagePreview(userImages, image.id);
            if (preview) onImageExpand(preview);
          }}
          onOpenFile={onFileOpen}
          onExpandVideo={(file) => {
            const preview = buildAttachmentVideoPreview(ctx.activeThreadEnvironmentId, file);
            if (preview) onImageExpand(preview);
          }}
        />
      </span>
    );
  };

  const mediaBlock =
    regularImages.length > 0 || userVideos.length > 0 ? (
      <div
        className={cn(
          "grid",
          !standaloneMedia
            ? "mb-2 max-w-[210px] grid-cols-2 gap-2"
            : loneImage
              ? "max-w-full"
              : collage
                ? cn(
                    MEDIA_EDGE_CLASS_NAME,
                    "w-64 max-w-full gap-px overflow-hidden rounded-2xl bg-black/9 dark:bg-white/12",
                    mediaCornerClassName,
                    regularImages.length === 2
                      ? "auto-rows-[154px] grid-cols-2"
                      : regularImages.length === 3
                        ? "auto-rows-[76.5px] grid-cols-[3fr_2fr]"
                        : "auto-rows-[77px] grid-cols-2",
                  )
                : regularImages.length + userVideos.length === 1
                  ? "w-80 max-w-full"
                  : "w-80 max-w-full grid-cols-2 gap-2",
        )}
      >
        {regularImages.map((image, index) => (
          <div
            key={image.id}
            className={cn(
              "bg-background/70",
              image.source?.kind === "snap-shot" && image.previewUrl
                ? cn(
                    "col-span-2",
                    standaloneMedia
                      ? cn(
                          MEDIA_EDGE_CLASS_NAME,
                          "min-h-16 justify-self-end overflow-hidden rounded-2xl",
                          loneImage && mediaCornerClassName,
                        )
                      : SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
                  )
                : loneImage
                  ? cn(MEDIA_EDGE_CLASS_NAME, "overflow-hidden rounded-2xl", mediaCornerClassName)
                  : collage
                    ? cn(
                        "overflow-hidden bg-background",
                        regularImages.length === 3 && index === 0 && "row-span-2",
                        regularImages.length > 3 &&
                          regularImages.length % 2 === 1 &&
                          index === regularImages.length - 1 &&
                          "col-span-2",
                      )
                    : standaloneMedia
                      ? cn(MEDIA_EDGE_CLASS_NAME, "aspect-[4/3] overflow-hidden rounded-2xl")
                      : "aspect-[4/3] overflow-hidden rounded-lg border border-border",
            )}
          >
            {image.previewUrl ? (
              <button
                type="button"
                className="block h-full w-full cursor-zoom-in"
                aria-label={`Preview ${image.name}`}
                onClick={() => {
                  const preview = buildExpandedImagePreview(regularImages, image.id);
                  if (!preview) return;
                  ctx.onImageExpand(preview);
                }}
              >
                {/* Isolate the thumbnail raster from nearby activity repaints in Chromium. */}
                <AttachmentImage
                  name={image.name}
                  mimeType={image.mimeType}
                  src={image.previewUrl}
                  alt={image.name}
                  decoding="async"
                  loading="lazy"
                  className={cn(
                    "block transform-gpu",
                    standaloneMedia && image.source?.kind === "snap-shot"
                      ? "h-auto max-h-48 w-auto min-w-24 max-w-full object-contain"
                      : loneImage
                        ? "h-48 w-auto min-w-24 max-w-full object-cover"
                        : "size-full object-cover",
                  )}
                />
              </button>
            ) : (
              <div
                className={cn(
                  "flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-caption text-dim-foreground",
                  loneImage && "h-48 w-64 max-w-full",
                  collage && "h-full",
                )}
              >
                {image.name}
              </div>
            )}
            {image.previewUrl && image.source?.kind === "snap-shot" ? (
              <SnapShotAttachmentDetails source={image.source} />
            ) : null}
          </div>
        ))}
        {userVideos.map((file) => (
          <UserVideoAttachment
            key={file.id}
            file={file}
            standalone={standaloneMedia}
            cornerClassName={
              regularImages.length + userVideos.length === 1 ? mediaCornerClassName : undefined
            }
          />
        ))}
      </div>
    ) : null;

  const userMessageMeta = resolveUserMessageMeta(row.message.inputIntent, row.steerOffsetMs);
  // Touch shows actions all the time, and narrow lanes have no room beside the
  // bubble, so both keep the actions on their own line.
  const floatActions = row.groupedWithNext === true && !coarsePointer;
  const messageActions = (
    <div
      className={cn(
        "flex items-center justify-end gap-x-2 gap-y-0.5",
        floatActions ? "flex-wrap" : "shrink-0",
      )}
    >
      {folded && senderThreadId ? (
        <InlineButton onClick={() => ctx.onOpenThread(senderThreadId)} tone="muted">
          Open thread
        </InlineButton>
      ) : null}
      <Tooltip>
        <TooltipTrigger render={<p className="text-dim-foreground text-meta tabular-nums" />}>
          {formatDayAwareTimestamp(row.message.createdAt, ctx.timestampFormat)}
        </TooltipTrigger>
        <TooltipPopup>
          {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
        </TooltipPopup>
      </Tooltip>
      <div className={cn("flex items-center gap-0.5", floatActions && "flex-wrap justify-end")}>
        {typeof revertTurnCount === "number" && (
          <RevertUserMessageButton turnCount={revertTurnCount} messageId={row.message.id} />
        )}
        {copyText && (
          <MessageCopyButton
            text={contextClipboardFragment ? copyText : plainText}
            {...(contextClipboardFragment
              ? {
                  extraFlavors: {
                    [COMPOSER_CONTEXT_CLIPBOARD_MIME]: contextClipboardFragment,
                  },
                }
              : {})}
            variant="ghost"
          />
        )}
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
  );
  return (
    <div
      className="group/user-row @container relative flex flex-col items-end gap-1"
      data-user-message-attribution={folded ? "agent" : undefined}
    >
      {userMessage.attribution === "t3code" ? (
        <p className={USER_MESSAGE_ATTRIBUTION_CLASS_NAME} data-user-message-attribution="t3code">
          Sent by T3 Code
        </p>
      ) : null}
      {/* The row's heading already names the guest for screen readers. */}
      {userMessage.guestName !== undefined ? (
        <div aria-hidden>
          <GuestMessageName name={userMessage.guestName} />
        </div>
      ) : null}
      {userMessageMeta && !row.continuesSteer ? (
        <UserMessageMeta intent={userMessageMeta.intent} label={userMessageMeta.label} />
      ) : null}
      {mediaAboveText ? (
        <div className="flex max-w-[80%] justify-end">
          {/* The heading leads the media so screen readers reach it before the images. */}
          <MessageAuthorHeading>You</MessageAuthorHeading>
          {mediaBlock}
        </div>
      ) : null}
      <div
        className={cn(
          "relative min-w-0 max-w-[min(80%,32.5rem)] rounded-pane text-foreground",
          (mediaAboveText || row.groupedWithPrevious) && "rounded-tr-md",
          row.groupedWithNext && "rounded-br-md",
          BUBBLE_CHIP_CLASS_NAME,
          userMessage.attribution === "guest"
            ? guestBubbleClassName(false)
            : !mediaOnly && !fileCardsOnly && !audioOnly && "surface-bubble",
          !folded && !mediaOnly && !fileCardsOnly && !audioOnly && "px-3.5 py-2.5",
          folded && expanded && "w-full",
        )}
      >
        {/* Outside the fold so a collapsed message still has a heading to navigate to. */}
        {mediaAboveText ? null : (
          <MessageAuthorHeading>
            {folded
              ? senderLabel
              : userMessage.guestName === undefined
                ? "You"
                : `${userMessage.guestName} (guest)`}
          </MessageAuthorHeading>
        )}
        {folded ? (
          <FoldedMessageHeader
            icon={MessagesSquareIcon}
            label={senderLabel}
            summary={foldSummary}
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
          />
        ) : null}
        {/* Find reads the DOM, so a folded message stays mounted but hidden while find is open. */}
        {!folded || expanded || ctx.findActive ? (
          <div
            ref={folded ? revealFoldRef : undefined}
            hidden={folded && !expanded}
            dir={markdownProseDirection(resolvedContext.text)}
            className={cn(
              folded && "px-3 pb-3",
              folded && !ctx.findActive && "max-h-96 overflow-auto",
            )}
          >
            {!mediaAboveText && mediaBlock}
            {userAudio.length > 0 ? (
              <div className={cn("flex max-w-full flex-col gap-1", !audioOnly && "mb-2")}>
                {userAudio.map((file) => (
                  <InlineAudioPreview
                    key={file.id}
                    name={file.name}
                    variant={audioOnly ? "bubble" : "chip"}
                    environmentId={ctx.activeThreadEnvironmentId}
                    resource={{
                      _tag: "attachment",
                      attachmentId: file.id,
                      fileName: file.name,
                      mimeType: file.mimeType,
                      disposition: "inline",
                    }}
                    onOpen={() => ctx.onFileOpen(file)}
                  />
                ))}
              </div>
            ) : null}
            {fileCardsOnly ? (
              <div className="flex flex-col items-end gap-1" onCopyCapture={onBodyCopyCapture}>
                {otherUserFiles.map((file) => (
                  <UserFileCard
                    key={file.id}
                    file={file}
                    copyMarkdown={
                      attachmentReferences.find((reference) => reference.attachmentId === file.id)
                        ?.source
                    }
                  />
                ))}
              </div>
            ) : null}
            {!fileCardsOnly && (unchippedFiles.length > 0 || unknownAttachments.length > 0) ? (
              <div className="mb-2 flex flex-col gap-1">
                {unchippedFiles.map((file) => {
                  const pastedText = file.source?._tag === "pasted-text";
                  const label = userMessageFileLabel(file);
                  const fileIdentity = (
                    <>
                      <PierreEntryIcon
                        pathValue={file.name}
                        kind="file"
                        theme={ctx.resolvedTheme}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{label}</span>
                        {file.downloadable === false || pastedText ? (
                          <span className="block text-caption text-dim-foreground tabular-nums">
                            {file.downloadable === false ? "Sending…" : formatBytes(file.sizeBytes)}
                          </span>
                        ) : null}
                      </span>
                    </>
                  );
                  if (file.downloadable !== false) {
                    return (
                      <div key={file.id} className="flex min-w-0 items-center gap-1">
                        <InlineButton
                          aria-label={`Preview ${label}`}
                          onClick={() => ctx.onFileOpen(file)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-2 py-1 text-body">
                            {fileIdentity}
                            <EyeIcon className="size-4 shrink-0" />
                          </span>
                        </InlineButton>
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
                      </div>
                    );
                  }

                  return (
                    <div key={file.id} className="flex min-w-0 items-center gap-2 py-1 text-body">
                      {fileIdentity}
                    </div>
                  );
                })}
                {unknownAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="flex min-w-0 items-center gap-2 py-1 text-body"
                  >
                    <PierreEntryIcon
                      pathValue={attachment.name}
                      kind="file"
                      theme={ctx.resolvedTheme}
                    />
                    <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {fileCardsOnly || audioOnly ? null : (
              <div onCopyCapture={onBodyCopyCapture}>
                <CollapsibleUserMessageBody
                  text={resolvedContext.text}
                  renderContextReference={renderContextReference}
                  skills={ctx.skills}
                  markdownCwd={ctx.markdownCwd}
                  leadingCommand={row.command?.sigil === "/" ? row.command.name : undefined}
                  collapsible={!folded}
                />
              </div>
            )}
          </div>
        ) : null}
        {floatActions ? (
          <div
            className={cn(
              "absolute end-full top-1/2 me-2 hidden w-max max-w-[calc(20cqw-0.5rem)] -translate-y-1/2 @min-[37rem]:flex",
              ACTIONS_REVEAL_CLASS_NAME,
            )}
          >
            {messageActions}
          </div>
        ) : null}
      </div>
      <UserMessageProjectedStatus row={row} />
      {!folded || expanded ? (
        <div
          className={cn(
            "absolute end-0 bottom-full z-10 flex items-center justify-end whitespace-nowrap pointer-coarse:static has-[button]:-me-1.5",
            floatActions && "@min-[37rem]:hidden",
            ACTIONS_REVEAL_CLASS_NAME,
          )}
        >
          {messageActions}
        </div>
      ) : null}
    </div>
  );
}

const ACTIONS_REVEAL_CLASS_NAME =
  "items-center text-meta tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/user-row:opacity-100";

function RevertUserMessageButton({
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

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  renderContextReference: (reference: ChatMarkdownContextReference) => ReactNode;
  skills: ReadonlyArray<ServerProviderSkill>;
  markdownCwd: string | undefined;
  /** The provider command the prompt opens with, drawn as a chip in place of its `/name`. */
  leadingCommand?: string | undefined;
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
            leadingCommand={props.leadingCommand}
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
              className="-me-2"
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
  renderContextReference?: ((reference: ChatMarkdownContextReference) => ReactNode) | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
  markdownCwd: string | undefined;
  leadingCommand?: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  if (props.text.length === 0) {
    return null;
  }
  const token = props.leadingCommand === undefined ? null : `/${props.leadingCommand}`;
  const text = props.text.trimStart();
  if (token !== null && text.startsWith(token)) {
    const rest = text.slice(token.length).trimStart();
    return (
      <div className="flex items-baseline gap-1.5">
        <SlashCommandChip name={token.slice(1)} />
        {rest ? (
          <div className="min-w-0 flex-1">
            <UserMessageBody
              text={rest}
              renderContextReference={props.renderContextReference}
              skills={props.skills}
              markdownCwd={props.markdownCwd}
            />
          </div>
        ) : null}
      </div>
    );
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

function UserMessageMeta({
  intent,
  label,
}: {
  readonly intent: "steer" | "promoted_queued_to_steer";
  readonly label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <p
            className="flex items-center gap-1 pe-1 text-caption text-dim-foreground tabular-nums"
            data-user-message-intent={intent}
          />
        }
      >
        <Redo2Icon aria-hidden className="size-3" />
        {label}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {intent === "promoted_queued_to_steer"
          ? "Originally queued, then promoted to steer the active turn"
          : "Steered the active turn"}
      </TooltipPopup>
    </Tooltip>
  );
}

function formatTurnOffset(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** Meta under a prompt: steers carry the moment they landed in the turn. */
function resolveUserMessageMeta(
  intent: ChatMessage["inputIntent"],
  steerOffsetMs: number | undefined,
): { intent: "steer" | "promoted_queued_to_steer"; label: string } | null {
  if (intent !== "steer" && intent !== "promoted_queued_to_steer") return null;
  return {
    intent,
    label: steerOffsetMs === undefined ? "steer" : `steer · at ${formatTurnOffset(steerOffsetMs)}`,
  };
}
