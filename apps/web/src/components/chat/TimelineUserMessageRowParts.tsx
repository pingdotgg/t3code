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
import { ACTIONS_REVEAL_CLASS_NAME, BUBBLE_CHIP_CLASS_NAME, CollapsibleUserMessageBody, FoldedMessageHeader, MEDIA_EDGE_CLASS_NAME, RevertUserMessageButton, UserFileCard, UserMessageIntentMarker, UserMessageProjectedStatus, UserVideoAttachment } from "./TimelineUserMessageRow";

export function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
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
                    "w-80 max-w-full gap-px overflow-hidden rounded-2xl bg-black/9 dark:bg-white/12",
                    mediaCornerClassName,
                    regularImages.length === 2
                      ? "auto-rows-[12rem] grid-cols-2"
                      : regularImages.length === 3
                        ? "auto-rows-[calc(6rem-0.5px)] grid-cols-[3fr_2fr]"
                        : "auto-rows-[6rem] grid-cols-2",
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
        <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
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
      className="group @container flex flex-col items-end gap-1"
      data-user-message-attribution={folded ? "agent" : undefined}
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
        <UserMessageIntentMarker intent={row.message.inputIntent} />
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
          "relative min-w-0 max-w-[80%] rounded-2xl text-message-foreground",
          (mediaAboveText || row.groupedWithPrevious) && "rounded-tr-md",
          row.groupedWithNext && "rounded-br-md",
          BUBBLE_CHIP_CLASS_NAME,
          userMessage.attribution === "guest"
            ? guestBubbleClassName(false)
            : !mediaOnly && !fileCardsOnly && !audioOnly && "bg-message",
          !folded && !mediaOnly && !fileCardsOnly && !audioOnly && "p-3",
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
                          <span className="block text-xs text-muted-foreground tabular-nums">
                            {file.downloadable === false ? "Sending…" : formatBytes(file.sizeBytes)}
                          </span>
                        ) : null}
                      </span>
                    </>
                  );
                  if (file.downloadable !== false) {
                    return (
                      <div key={file.id} className="flex min-w-0 items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Preview ${label}`}
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
            {fileCardsOnly || audioOnly ? null : (
              <div onCopyCapture={onBodyCopyCapture}>
                <CollapsibleUserMessageBody
                  text={resolvedContext.text}
                  renderContextReference={renderContextReference}
                  skills={ctx.skills}
                  markdownCwd={ctx.markdownCwd}
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
            "flex w-full max-w-[80%] justify-end pe-1",
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

