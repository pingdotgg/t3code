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
import { shouldCollapseUserMessage } from "./MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  asKnownContextRecord,
  resolveUserMessageContext,
  selectedMessageContextFragment,
} from "~/lib/composerContextRecords";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { chatMarkdownClipboardPayload } from "../../markdown-clipboard";
import type { ChatMarkdownContextReference } from "../ChatMarkdown";
import { cn } from "~/lib/utils";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { WorkflowOpeningBlock } from "./WorkflowOpeningBlock";
import { TimelineRowCtx, TimelineRowActivityCtx, type TimelineRow } from "./timelineRowContext";
import {
  MESSAGE_HEADING_LEVEL,
  MessageAuthorHeading,
  TimelineRowTimestamp,
} from "./TimelineRowParts";
import { UserMessageContextReferenceChip } from "./UserMessageContextChips";
import { resolvePreviewAnnotationImage } from "./TimelineUserMessageRow.logic";

// Drawn inside the media so dark screenshots keep an edge on the dark background.
const MEDIA_EDGE_CLASS_NAME =
  "relative after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-black/9 dark:after:ring-white/12";

const BUBBLE_CHIP_CLASS_NAME =
  "[&_[data-slot=context-chip]]:[--context-chip-ink:var(--context-chip-message,var(--context-chip-accent))]";

function UserVideoAttachment({ file }: { readonly file: ChatFileAttachment }) {
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
      <div className="flex aspect-[4/3] w-full items-center justify-center rounded-lg border border-border/80 bg-black px-2 py-3 text-center text-2xs text-white/70">
        {file.name}
      </div>
    );
  }

  return (
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
      videoClassName="aspect-auto size-full rounded-lg border border-border/80"
      stateClassName="aspect-auto min-h-full rounded-lg border border-border/80 bg-black text-white"
      onRetry={asset ? refreshAssetUrl : undefined}
      actionsSource={asset ? { kind: "video", name: file.name, src, asset } : undefined}
    />
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

function UserMessageProjectedStatus({
  row,
  className,
}: {
  row: Extract<TimelineRow, { kind: "message" }>;
  className?: string | undefined;
}) {
  const status = row.projectedItem?.item.status;
  if (
    status === undefined ||
    status === "completed" ||
    status === "pending" ||
    status === "waiting"
  )
    return null;
  return (
    <div className={cn("me-1 flex items-center justify-end gap-1.5", className)}>
      <span className="rounded-full border border-destructive/25 bg-destructive/8 px-1.5 py-0.5 text-3xs font-medium text-destructive">
        {status}
      </span>
    </div>
  );
}

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const { onImageExpand, onFileOpen } = ctx;
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
  const chippedAttachmentIds = new Set(
    collectComposerContextReferences(resolvedContext.text).flatMap((occurrence) => {
      const record = asKnownContextRecord(resolvedContext.recordsById.get(occurrence.contextId));
      return record?.kind === "file" || record?.kind === "image" ? [record.attachmentId] : [];
    }),
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
  // A lone image keeps its own shape; a 4:3 crop hides most of a wide screenshot.
  const loneImage =
    mediaOnly &&
    userVideos.length === 0 &&
    regularImages.length === 1 &&
    regularImages[0]!.source?.kind !== "snap-shot";
  // Several images sent without words share one rounded shape, split by hairlines.
  const collage =
    mediaOnly &&
    userVideos.length === 0 &&
    regularImages.length > 1 &&
    regularImages.every((image) => image.source?.kind !== "snap-shot");
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
  const contextClipboardFragment =
    resolvedContext.records.length === 0
      ? null
      : encodeComposerContextFragment({
          version: 1,
          source: {
            environmentId: ctx.activeThreadEnvironmentId,
            ...(ctx.threadRef ? { threadId: ctx.threadRef.threadId } : {}),
            messageId: row.message.id,
          },
          records: resolvedContext.records,
        });
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

  // Another of your messages follows directly: time and actions move beside the bubble so the
  // two stack tight. Touch has no hover, so it keeps them inline.
  const stacked = row.groupedWithNext === true;

  return (
    <div
      className={cn(
        "group flex items-end",
        stacked
          ? "flex-row flex-wrap justify-end gap-x-2 gap-y-1 pointer-coarse:flex-col pointer-coarse:flex-nowrap pointer-coarse:gap-1"
          : "flex-col gap-1",
      )}
      data-user-message-attribution={folded ? "agent" : undefined}
      data-user-message-grouped={stacked || row.groupedWithPrevious ? "" : undefined}
    >
      {userMessage.attribution === "t3code" ? (
        <p
          className="me-1 text-2xs text-muted-foreground/70"
          data-user-message-attribution="t3code"
        >
          Sent by T3 Code
        </p>
      ) : null}
      {/* The row's heading already names the guest for screen readers. */}
      {userMessage.guestName !== undefined ? (
        <div aria-hidden>
          <GuestMessageName name={userMessage.guestName} />
        </div>
      ) : null}
      {(row.message.inputIntent === "steer" ||
        row.message.inputIntent === "promoted_queued_to_steer") &&
      !row.continuesSteer ? (
        <div className={cn(stacked && "flex basis-full justify-end")}>
          <UserMessageIntentMarker intent={row.message.inputIntent} />
        </div>
      ) : null}
      <div
        className={cn(
          "relative min-w-0 max-w-[80%] rounded-2xl text-message-foreground",
          stacked && "order-1 rounded-br-md",
          row.groupedWithPrevious && "rounded-tr-md",
          BUBBLE_CHIP_CLASS_NAME,
          userMessage.attribution === "guest"
            ? guestBubbleClassName(false)
            : !mediaOnly && "bg-message",
          !folded && !mediaOnly && "p-3",
          folded && expanded && "w-full",
        )}
      >
        {/* Outside the fold so a collapsed message still has a heading to navigate to. */}
        <MessageAuthorHeading>
          {folded
            ? senderLabel
            : userMessage.guestName === undefined
              ? "You"
              : `${userMessage.guestName} (guest)`}
        </MessageAuthorHeading>
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
            className={cn(
              folded && "px-3 pb-3",
              folded && !ctx.findActive && "max-h-96 overflow-auto",
            )}
          >
            {(regularImages.length > 0 || userVideos.length > 0) && (
              <div
                className={cn(
                  "grid",
                  !mediaOnly
                    ? "mb-2 max-w-[210px] grid-cols-2 gap-2"
                    : loneImage
                      ? "max-w-full"
                      : collage
                        ? cn(
                            MEDIA_EDGE_CLASS_NAME,
                            "w-80 max-w-full gap-px overflow-hidden rounded-2xl bg-black/9 dark:bg-white/12",
                            regularImages.length === 2
                              ? "auto-rows-[12rem] grid-cols-2"
                              : regularImages.length === 3
                                ? "auto-rows-[calc(6rem-0.5px)] grid-cols-[3fr_2fr]"
                                : "auto-rows-[6rem] grid-cols-2",
                          )
                        : "w-80 max-w-full grid-cols-2 gap-2",
                )}
              >
                {regularImages.map((image, index) => (
                  <div
                    key={image.id}
                    className={cn(
                      "bg-background/70",
                      image.source?.kind === "snap-shot" && image.previewUrl
                        ? cn(SNAP_SHOT_ATTACHMENT_FRAME_CLASS, "col-span-2")
                        : loneImage
                          ? cn(MEDIA_EDGE_CLASS_NAME, "overflow-hidden rounded-2xl")
                          : collage
                            ? cn(
                                "overflow-hidden bg-background",
                                regularImages.length === 3 && index === 0 && "row-span-2",
                                regularImages.length > 3 &&
                                  regularImages.length % 2 === 1 &&
                                  index === regularImages.length - 1 &&
                                  "col-span-2",
                              )
                            : "aspect-[4/3] overflow-hidden rounded-lg border border-border/80",
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
                            // A fixed height keeps the row from growing when the image loads.
                            loneImage
                              ? "h-48 w-auto min-w-24 max-w-full object-cover"
                              : "size-full object-cover",
                          )}
                        />
                      </button>
                    ) : (
                      <div
                        className={cn(
                          "flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-2xs text-muted-foreground/70",
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
                  <UserVideoAttachment key={file.id} file={file} />
                ))}
              </div>
            )}
            {userAudio.length > 0 ? (
              <div className="mb-2 flex max-w-full flex-col gap-1">
                {userAudio.map((file) => (
                  <InlineAudioPreview
                    key={file.id}
                    name={file.name}
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
            {unchippedFiles.length > 0 || unknownAttachments.length > 0 ? (
              <div className="mb-2 flex flex-col gap-1">
                {unchippedFiles.map((file) => {
                  const fileIdentity = (
                    <>
                      <PierreEntryIcon
                        pathValue={file.name}
                        kind="file"
                        theme={ctx.resolvedTheme}
                      />
                      <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    </>
                  );
                  if (file.downloadable !== false) {
                    return (
                      <div key={file.id} className="flex min-w-0 items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Preview ${file.name}`}
                          onClick={() => ctx.onFileOpen(file)}
                          className="focus-visible:ring-ring/70 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1 text-left text-sm hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
                        >
                          {fileIdentity}
                          <EyeIcon className="size-4 shrink-0" />
                        </button>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost-muted"
                                aria-label={`Download ${file.name}`}
                                onClick={() => ctx.onFileDownload(file)}
                              />
                            }
                          >
                            <DownloadIcon />
                          </TooltipTrigger>
                          <TooltipPopup side="top">Download {file.name}</TooltipPopup>
                        </Tooltip>
                      </div>
                    );
                  }

                  return (
                    <div key={file.id} className="flex min-w-0 items-center gap-2 py-1 text-sm">
                      {fileIdentity}
                    </div>
                  );
                })}
                {unknownAttachments.map((attachment) => (
                  <div key={attachment.id} className="flex min-w-0 items-center gap-2 py-1 text-sm">
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
            <div onCopyCapture={onBodyCopyCapture}>
              <CollapsibleUserMessageBody
                text={resolvedContext.text}
                renderContextReference={renderContextReference}
                skills={ctx.skills}
                markdownCwd={ctx.markdownCwd}
                collapsible={!folded}
              />
            </div>
          </div>
        ) : null}
      </div>
      <UserMessageProjectedStatus row={row} className={cn(stacked && "order-2 basis-full")} />
      {!folded || expanded ? (
        <div
          className={cn(
            "flex items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100",
            stacked
              ? "pb-1 pointer-coarse:order-3 pointer-coarse:w-full pointer-coarse:max-w-[80%] pointer-coarse:pb-0"
              : "w-full max-w-[80%]",
          )}
        >
          <div className="flex shrink-0 items-center gap-2">
            {folded && senderThreadId ? (
              <InlineButton onClick={() => ctx.onOpenThread(senderThreadId)} tone="muted">
                Open thread
              </InlineButton>
            ) : null}
            <Tooltip>
              <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
                {formatDayAwareTimestamp(row.message.createdAt, ctx.timestampFormat)}
              </TooltipTrigger>
              <TooltipPopup>
                {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
              </TooltipPopup>
            </Tooltip>
            <div className="flex items-center gap-0.5">
              {typeof revertTurnCount === "number" && (
                <RevertUserMessageButton turnCount={revertTurnCount} messageId={row.message.id} />
              )}
              {resolvedContext.text && (
                <MessageCopyButton
                  text={contextClipboardFragment ? resolvedContext.text : plainText}
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
        </div>
      ) : null}
    </div>
  );
}

function UserMessageIntentMarker({
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
