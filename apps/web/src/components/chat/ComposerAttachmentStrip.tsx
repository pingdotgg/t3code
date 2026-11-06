import type {
  ChatAttachment,
  ChatFileAttachment,
  EnvironmentId,
  PreviewAnnotationPayload,
  ScopedThreadRef,
  SnapShotSource,
} from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { decodeFilePreviewText, filePreviewKind } from "@t3tools/shared/filePreview";
import {
  CircleAlertIcon,
  MessageCircleIcon,
  MousePointerClickIcon,
  PlayIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  composerFileNeedsReattach,
} from "../../composerDraftStore";
import { retryAttachmentUpload, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import {
  type AttachmentUploadState,
  formatAttachmentUploadProgress,
} from "../../lib/attachmentUploadState";
import {
  isPullRequestSummaryContext,
  previewAnnotationContextLabel,
  reviewCommentContextLabel,
} from "../../lib/composerContextRecords";
import { isTerminalContextExpired, type TerminalContextDraft } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { isHeicImageFile } from "../../lib/imageCompression";
import {
  type PendingSnapShotAnimation,
  scheduleSnapShotAnimationDestination,
  setSnapShotAnimationDestination,
  shouldAnimateSnapShotArrival,
} from "../../lib/snapShotAnimation";
import { cn } from "~/lib/utils";
import { getRestingComposerImagePreviewCounts } from "../composerFooterLayout";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import { AttachmentImage } from "../media/AttachmentImage";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerImageThumbnail } from "./ComposerImageThumbnail";
import { composerFloatingLayerProps } from "./composerEventScope";
import type { PreparingComposerImage } from "./preparingComposerImages";
import {
  attachVideoThumbnail,
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { PierreEntryIcon, pierreFileIconColor } from "./PierreEntryIcon";
import {
  SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
  SnapShotAttachmentDetails,
} from "./SnapShotAttachmentDetails";
import { prepareVideoFirstFrame } from "../../lib/videoFirstFrame";

function formatVideoDuration(seconds: number) {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function ComposerVideoThumbnail({
  file,
  showDuration,
}: {
  readonly file: File;
  readonly showDuration: boolean;
}) {
  const [duration, setDuration] = useState<number | null>(null);
  const setVideo = (video: HTMLVideoElement | null) => {
    if (!video) return;
    return attachVideoThumbnail(video, file);
  };

  return (
    <>
      <video
        ref={setVideo}
        muted
        playsInline
        preload="metadata"
        aria-hidden="true"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration);
          prepareVideoFirstFrame(video);
        }}
        className="pointer-events-none absolute inset-0 size-full object-cover"
      />
      {showDuration && duration !== null ? (
        <span className="pointer-events-none absolute bottom-0.5 right-1 z-10 font-mono text-3xs tabular-nums text-white drop-shadow-md">
          {formatVideoDuration(duration)}
        </span>
      ) : null}
    </>
  );
}

function SnapShotAttachmentFrame({
  animationId,
  animationSource,
  arrival,
  animateArrival,
  className,
  ...props
}: ComponentProps<"div"> & {
  readonly animationId?: string | undefined;
  readonly animationSource?: SnapShotSource | undefined;
  readonly arrival?: boolean | undefined;
  readonly animateArrival?: boolean | undefined;
}) {
  const frameRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the mounted tile into view and registers it as the SnapShot animation destination
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame || (!animationId && !arrival)) return;
    frame.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (!animationId) return;

    return scheduleSnapShotAnimationDestination(animationId, () =>
      setSnapShotAnimationDestination(animationId, frame, animationSource),
    );
  }, [animationId, animationSource, arrival]);

  return (
    <div
      ref={frameRef}
      className={cn(
        animateArrival &&
          !animationId &&
          "origin-center transition-[opacity,scale] duration-300 ease-drawer starting:scale-95 starting:opacity-0 motion-reduce:transition-none motion-reduce:starting:scale-100 motion-reduce:starting:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

/** Image, SnapShot and video tiles above the composer editor. */
export function ComposerAttachmentMediaRow({
  images,
  expandedImages,
  preparingImages,
  videos,
  pendingSnapShotAnimations,
  pendingSnapShotIds,
  uncommittedSnapShotIds,
  nonPersistedImageIds,
  snapShotAnimations,
  supportsAttachmentUploads,
  maxFileAttachmentBytes,
  environmentId,
  attachmentDraftTarget,
  canOperateThread,
  onExpandImage,
  onFileOpen,
  onRemoveImage,
  onRemoveFile,
}: {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly expandedImages: ReadonlyArray<ComposerImageAttachment>;
  readonly preparingImages: ReadonlyArray<PreparingComposerImage>;
  readonly videos: ReadonlyArray<ComposerFileAttachment>;
  readonly pendingSnapShotAnimations: ReadonlyArray<PendingSnapShotAnimation>;
  readonly pendingSnapShotIds: ReadonlyArray<string>;
  readonly uncommittedSnapShotIds: ReadonlyArray<string>;
  readonly nonPersistedImageIds: ReadonlyArray<string>;
  readonly snapShotAnimations: boolean;
  readonly supportsAttachmentUploads: boolean;
  readonly maxFileAttachmentBytes: number | null;
  readonly environmentId: EnvironmentId;
  readonly attachmentDraftTarget: ScopedThreadRef | DraftId;
  readonly canOperateThread: boolean;
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
  readonly onFileOpen: (attachment: ChatFileAttachment) => void;
  readonly onRemoveImage: (imageId: string) => void;
  readonly onRemoveFile: (fileId: string) => void;
}) {
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const pendingSnapShotIdSet = new Set(pendingSnapShotIds);
  const nonPersistedImageIdSet = new Set(nonPersistedImageIds);
  return (
    <div
      className={cn(
        "mb-3 flex max-w-full gap-1.5",
        pendingSnapShotIds.length > 0 ||
          expandedImages.some((image) => image.source?.kind === "snap-shot")
          ? "snap-x snap-proximity overflow-x-auto overscroll-x-contain pb-1 scrollbar-thumb-foreground/18 scrollbar-track-transparent [scrollbar-width:thin] [&::-webkit-scrollbar]:h-2.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-3 [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-foreground/18 [&::-webkit-scrollbar-thumb]:bg-clip-content [&::-webkit-scrollbar-thumb:hover]:bg-foreground/28 [&::-webkit-scrollbar-track]:mx-1 [&::-webkit-scrollbar-track]:bg-transparent"
          : "flex-wrap",
      )}
    >
      {/* A preparing image renders through the same tile, keyed by the id its compressed image
          takes, so the thumbnail element survives the swap. */}
      {[
        ...expandedImages.map((image) => ({ image, ready: image })),
        ...preparingImages.map((image) => ({ image, ready: null })),
      ]
        .map(({ image, ready }) => {
          const upload =
            ready && supportsAttachmentUploads ? uploadsByImageId[image.id] : undefined;
          const source = ready?.source;
          const snapShotAnimationPending =
            source?.kind === "snap-shot" && pendingSnapShotIdSet.has(image.id);
          const snapShotArrival =
            source?.kind === "snap-shot" && shouldAnimateSnapShotArrival(source.capturedAt);
          return (
            <SnapShotAttachmentFrame
              key={image.id}
              data-chat-composer-expanded-image="true"
              aria-hidden={snapShotAnimationPending || undefined}
              inert={snapShotAnimationPending || undefined}
              arrival={snapShotArrival}
              animateArrival={snapShotAnimations && !snapShotAnimationPending && snapShotArrival}
              animationId={snapShotAnimationPending ? image.id : undefined}
              animationSource={snapShotAnimationPending ? source : undefined}
              className={cn(
                "group/attachment shrink-0 snap-start bg-background",
                source?.kind === "snap-shot"
                  ? SNAP_SHOT_ATTACHMENT_FRAME_CLASS
                  : "relative size-12 overflow-hidden rounded-lg border border-border/80",
                snapShotAnimationPending && "invisible",
              )}
            >
              {!ready || ready.previewUrl ? (
                <button
                  type="button"
                  className={cn("h-full w-full", ready && "cursor-zoom-in")}
                  aria-label={`Preview ${image.name}`}
                  disabled={!ready}
                  onClick={() => {
                    const preview = buildExpandedImagePreview(images, image.id);
                    if (!preview) return;
                    onExpandImage(preview);
                  }}
                >
                  <ComposerImageThumbnail
                    file={image.file}
                    alt={image.name}
                    className="h-full w-full object-cover"
                    fallback={
                      ready && isHeicImageFile({ name: ready.name, type: ready.mimeType }) ? (
                        <AttachmentImage
                          name={ready.name}
                          mimeType={ready.mimeType}
                          src={ready.previewUrl}
                          alt={image.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="flex h-full items-center justify-center px-1 text-3xs text-secondary-label">
                          {image.name}
                        </span>
                      )
                    }
                  />
                </button>
              ) : (
                <div className="flex h-full w-full items-center justify-center px-1 text-center text-3xs text-secondary-label">
                  {image.name}
                </div>
              )}
              {source?.kind === "snap-shot" ? (
                <SnapShotAttachmentDetails
                  source={source}
                  className={cn(
                    upload?.status === "uploading" && "bottom-4",
                    upload?.status === "failed" && "bottom-8",
                  )}
                />
              ) : null}
              {nonPersistedImageIdSet.has(image.id) && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        role="img"
                        aria-label="Draft attachment may not persist"
                        className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-warning-foreground"
                      >
                        <CircleAlertIcon className="size-3" />
                      </span>
                    }
                  />
                  <TooltipPopup side="top">
                    Draft attachment could not be saved locally and may be lost on navigation.
                  </TooltipPopup>
                </Tooltip>
              )}
              {(ready ? upload?.status === "uploading" : supportsAttachmentUploads) && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground">
                  {formatAttachmentUploadProgress(
                    upload?.status === "uploading" ? upload.progress : 0,
                  )}
                </span>
              )}
              {ready && upload?.status === "failed" && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="overlay"
                        size="icon-xs"
                        className="absolute bottom-1 left-1"
                        onClick={() =>
                          retryAttachmentUpload({
                            environmentId,
                            image: ready,
                            draftTarget: attachmentDraftTarget,
                          })
                        }
                        disabled={!canOperateThread}
                        aria-label={`Retry upload for ${image.name}`}
                      />
                    }
                  >
                    <RefreshIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{upload.reason}</TooltipPopup>
                </Tooltip>
              )}
              <span className="absolute right-1 top-1 flex opacity-0 transition-opacity pointer-coarse:opacity-100 group-hover/attachment:opacity-100 group-focus-within/attachment:opacity-100">
                <Button
                  variant="media-close"
                  size="icon-xs"
                  onClick={() => onRemoveImage(image.id)}
                  aria-label={`Remove ${image.name}`}
                >
                  <XIcon />
                </Button>
              </span>
            </SnapShotAttachmentFrame>
          );
        })
        .concat(
          uncommittedSnapShotIds.map((captureId) => (
            <SnapShotAttachmentFrame
              key={captureId}
              aria-hidden="true"
              animationId={captureId}
              animationSource={
                pendingSnapShotAnimations.find((capture) => capture.id === captureId)?.source
              }
              className={cn(
                SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
                "invisible shrink-0 snap-start bg-background",
              )}
            />
          )),
        )}
      {videos.map((file) => {
        const fileCanUpload =
          supportsAttachmentUploads &&
          maxFileAttachmentBytes !== null &&
          file.sizeBytes <= maxFileAttachmentBytes;
        const upload = fileCanUpload ? uploadsByImageId[file.id] : undefined;
        return (
          <div
            key={file.id}
            className="group/attachment relative size-12 shrink-0 snap-start overflow-hidden rounded-lg border border-border/80 bg-black"
          >
            <button
              type="button"
              className="flex h-full w-full cursor-zoom-in flex-col items-center justify-center gap-1 px-1 text-white"
              aria-label={`Play ${file.name}`}
              onClick={() => {
                if (file.file !== null) {
                  const preview = buildExpandedImagePreview([file], file.id);
                  if (preview) onExpandImage(preview);
                  return;
                }
                if (!file.uploadedAttachmentId) return;
                onFileOpen({ ...file, id: file.uploadedAttachmentId });
              }}
            >
              {file.file && (
                <>
                  <ComposerVideoThumbnail
                    file={file.file}
                    showDuration={upload?.status !== "uploading"}
                  />
                  <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/10" />
                </>
              )}
              <PlayIcon className="relative z-10 size-4 fill-current drop-shadow-md" />
            </button>
            {upload?.status === "uploading" && (
              <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground">
                {formatAttachmentUploadProgress(upload.progress)}
              </span>
            )}
            {upload?.status === "failed" && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="overlay"
                      size="icon-xs"
                      className="absolute bottom-1 left-1"
                      onClick={() =>
                        retryAttachmentUpload({
                          environmentId,
                          image: file,
                          draftTarget: attachmentDraftTarget,
                        })
                      }
                      disabled={!canOperateThread}
                      aria-label={`Retry upload for ${file.name}`}
                    />
                  }
                >
                  <RefreshIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">{upload.reason}</TooltipPopup>
              </Tooltip>
            )}
            <span className="absolute right-1 top-1 flex opacity-0 transition-opacity pointer-coarse:opacity-100 group-hover/attachment:opacity-100 group-focus-within/attachment:opacity-100">
              <Button
                variant="media-close"
                size="icon-xs"
                onClick={() => onRemoveFile(file.id)}
                aria-label={`Remove ${file.name}`}
              >
                <XIcon />
              </Button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

const COUNTABLE_TEXT_MAX_BYTES = 1024 * 1024;
const COUNTABLE_PDF_MAX_BYTES = 20 * 1024 * 1024;

function fileTypeLabel(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1);
  return extension.length <= 4 ? extension.toUpperCase() : null;
}

function plural(count: number, noun: string) {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

/** Reads a page or line count from local bytes; resolves null for other files. */
async function readLocalFileDetail(
  source: File,
  name: string,
  mimeType: string,
  signal: AbortSignal,
): Promise<string | null> {
  const kind = filePreviewKind({ name, mimeType });
  const countLines =
    (kind === "text" || kind === "markdown") && source.size <= COUNTABLE_TEXT_MAX_BYTES;
  const countPages = kind === "pdf" && source.size <= COUNTABLE_PDF_MAX_BYTES;
  if (!countPages && !countLines) return null;
  const bytes = await source.arrayBuffer();
  if (countLines) {
    const { text } = decodeFilePreviewText(new Uint8Array(bytes));
    const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return plural(lines, "line");
  }
  const { openPdf } = await import("../files/pdfDocument");
  signal.throwIfAborted();
  const task = openPdf(bytes);
  const destroy = () => void task.destroy();
  signal.addEventListener("abort", destroy, { once: true });
  try {
    return plural((await task.promise).numPages, "page");
  } finally {
    signal.removeEventListener("abort", destroy);
    destroy();
  }
}

/** Page or line count for a picked file; null until known, and for other files. */
function useLocalFileDetail(file: ComposerFileAttachment): string | null {
  const [detail, setDetail] = useState<{ readonly file: File; readonly text: string } | null>(null);
  const source = file.file;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the picked file's bytes off the render path and drops the read when the file changes or unmounts
  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    readLocalFileDetail(source, file.name, file.mimeType, controller.signal)
      .then((text) => {
        if (text !== null && !controller.signal.aborted) setDetail({ file: source, text });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [source, file.name, file.mimeType]);
  return detail?.file === source ? detail.text : null;
}

/** File-type mark: the icon with its short type name, both in the icon's color. */
function FileTypeMark({
  name,
  mimeType,
  resolvedTheme,
}: {
  readonly name: string;
  readonly mimeType: string;
  readonly resolvedTheme: "light" | "dark";
}) {
  const label = fileTypeLabel(name);
  const color = pierreFileIconColor(name, resolvedTheme, mimeType);
  return (
    <span
      aria-hidden
      className="relative flex h-8 w-7 shrink-0 flex-col items-center justify-center gap-px overflow-hidden rounded-sm"
      style={{ color }}
    >
      <span className="absolute inset-0 bg-current opacity-12" />
      <PierreEntryIcon
        pathValue={name}
        mimeType={mimeType}
        kind="file"
        theme={resolvedTheme}
        {...(label ? { className: "size-3.5" } : {})}
      />
      {label ? (
        <span className="relative font-mono font-semibold text-4xs leading-none tracking-tight">
          {label}
        </span>
      ) : null}
    </span>
  );
}

function ComposerCardShell({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative flex h-12 min-w-0 max-w-64 shrink-0 items-center gap-2 overflow-clip rounded-lg border border-border bg-muted/40 pe-1 ps-2 transition-[opacity,scale] duration-200 ease-out starting:scale-95 starting:opacity-0 motion-reduce:transition-none",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function ComposerCardText({
  title,
  meta,
  metaClassName,
  onOpen,
  disabled,
}: {
  readonly title: string;
  readonly meta: ReactNode;
  readonly metaClassName?: string | undefined;
  readonly onOpen?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
}) {
  const content = (
    <>
      <span
        className={cn(
          "w-full truncate font-medium text-foreground text-xs",
          onOpen && !disabled && "group-hover/card:underline",
        )}
      >
        {title}
      </span>
      <span className={cn("w-full truncate text-3xs text-muted-foreground", metaClassName)}>
        {meta}
      </span>
    </>
  );
  const className = "flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left";
  return onOpen ? (
    <button
      type="button"
      disabled={disabled}
      className={cn(className, "group/card focus-visible:outline-2")}
      onClick={onOpen}
    >
      {content}
    </button>
  ) : (
    <span className={className}>{content}</span>
  );
}

function ComposerCardRemove({
  label,
  onRemove,
}: {
  readonly label: string;
  readonly onRemove: () => void;
}) {
  return (
    <Button variant="ghost" size="icon-xs" onClick={onRemove} aria-label={`Remove ${label}`}>
      <XIcon />
    </Button>
  );
}

function ComposerFileCard({
  file,
  upload,
  resolvedTheme,
  canReattachFile,
  environmentId,
  attachmentDraftTarget,
  canOperateThread,
  onPreviewFile,
  onRemoveFile,
}: {
  readonly file: ComposerFileAttachment;
  readonly upload: AttachmentUploadState | undefined;
  readonly resolvedTheme: "light" | "dark";
  readonly canReattachFile: boolean;
  readonly environmentId: EnvironmentId;
  readonly attachmentDraftTarget: ScopedThreadRef | DraftId;
  readonly canOperateThread: boolean;
  readonly onPreviewFile: (fileId: string) => void;
  readonly onRemoveFile: (fileId: string) => void;
}) {
  const needsReattach = composerFileNeedsReattach(file);
  const detail = useLocalFileDetail(file);
  const uploading = !needsReattach && upload?.status === "uploading";
  const meta = needsReattach
    ? canReattachFile
      ? "Attach again"
      : "Remove to send"
    : uploading
      ? `Uploading · ${formatAttachmentUploadProgress(upload.progress)} of ${formatAttachmentSize(file.sizeBytes)}`
      : [formatAttachmentSize(file.sizeBytes), detail].filter(Boolean).join(" · ");
  return (
    <ComposerCardShell data-composer-file-card={file.id}>
      <FileTypeMark name={file.name} mimeType={file.mimeType} resolvedTheme={resolvedTheme} />
      <ComposerCardText
        title={file.name}
        meta={meta}
        metaClassName={
          uploading ? "text-info-foreground" : needsReattach ? "text-warning-foreground" : undefined
        }
        disabled={needsReattach}
        onOpen={() => onPreviewFile(file.id)}
      />
      {uploading ? (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-border">
          <span
            className="block h-full bg-info transition-[width] duration-300 ease-out motion-reduce:transition-none"
            style={{ width: formatAttachmentUploadProgress(upload.progress) }}
          />
        </span>
      ) : null}
      {!needsReattach && upload?.status === "failed" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() =>
                  retryAttachmentUpload({
                    environmentId,
                    image: file,
                    draftTarget: attachmentDraftTarget,
                  })
                }
                disabled={!canOperateThread}
                aria-label={`Retry upload for ${file.name}`}
              />
            }
          >
            <RefreshIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">{upload.reason}</TooltipPopup>
        </Tooltip>
      ) : null}
      <ComposerCardRemove label={file.name} onRemove={() => onRemoveFile(file.id)} />
    </ComposerCardShell>
  );
}

/** Non-media file attachments, shown as cards beside the media row. */
export function ComposerAttachmentFileList({
  files,
  resolvedTheme,
  supportsAttachmentUploads,
  maxFileAttachmentBytes,
  fileStagingLimit,
  environmentId,
  attachmentDraftTarget,
  canOperateThread,
  onPreviewFile,
  onRemoveFile,
}: {
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly resolvedTheme: "light" | "dark";
  readonly supportsAttachmentUploads: boolean;
  readonly maxFileAttachmentBytes: number | null;
  readonly fileStagingLimit: number | null;
  readonly environmentId: EnvironmentId;
  readonly attachmentDraftTarget: ScopedThreadRef | DraftId;
  readonly canOperateThread: boolean;
  readonly onPreviewFile: (fileId: string) => void;
  readonly onRemoveFile: (fileId: string) => void;
}) {
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  return (
    <div className="contents">
      {files.map((file) => {
        const fileCanUpload =
          supportsAttachmentUploads &&
          maxFileAttachmentBytes !== null &&
          file.sizeBytes <= maxFileAttachmentBytes;
        return (
          <ComposerFileCard
            key={file.id}
            file={file}
            upload={fileCanUpload ? uploadsByImageId[file.id] : undefined}
            resolvedTheme={resolvedTheme}
            canReattachFile={fileStagingLimit !== null && file.sizeBytes <= fileStagingLimit}
            environmentId={environmentId}
            attachmentDraftTarget={attachmentDraftTarget}
            canOperateThread={canOperateThread}
            onPreviewFile={onPreviewFile}
            onRemoveFile={onRemoveFile}
          />
        );
      })}
    </div>
  );
}

/** Captured terminal output, shown as a card beside the files. */
export function ComposerTerminalContextCards({
  contexts,
  onRemove,
}: {
  readonly contexts: ReadonlyArray<TerminalContextDraft>;
  readonly onRemove: (contextId: string) => void;
}) {
  return (
    <div className="contents">
      {contexts.map((context) => {
        const expired = isTerminalContextExpired(context);
        const lineCount = context.lineEnd - context.lineStart + 1;
        const card = (
          <ComposerCardShell key={context.id} data-composer-terminal-card={context.id}>
            <span
              aria-hidden
              className={cn(
                "relative flex h-8 w-7 shrink-0 items-center justify-center overflow-hidden rounded-sm text-(--context-chip-terminal)",
                expired && "text-warning-foreground",
              )}
            >
              <span className="absolute inset-0 bg-current opacity-12" />
              <TerminalIcon className="relative size-4" />
            </span>
            <ComposerCardText
              title={context.terminalLabel}
              meta={expired ? "Expired · remove to send" : plural(lineCount, "line")}
              metaClassName={expired ? "text-warning-foreground" : undefined}
            />
            <ComposerCardRemove
              label={`terminal output from ${context.terminalLabel}`}
              onRemove={() => onRemove(context.id)}
            />
          </ComposerCardShell>
        );
        if (expired || context.text.length === 0) return card;
        return (
          <Tooltip key={context.id}>
            <TooltipTrigger render={card} />
            <TooltipPopup side="top" className="max-w-md">
              <pre className="max-h-48 overflow-hidden whitespace-pre-wrap font-mono text-2xs leading-snug">
                {context.text.split("\n", 12).join("\n")}
              </pre>
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

function previewAnnotationChipLabel(annotation: PreviewAnnotationPayload): {
  readonly label: string;
  readonly code: boolean;
} {
  const element = annotation.elements[0]?.element;
  const target = element?.componentName ?? element?.selector ?? element?.tagName;
  if (target && !annotation.comment.trim()) return { label: target, code: true };
  return { label: previewAnnotationContextLabel(annotation), code: false };
}

function reviewCommentChipLabel(comment: ReviewCommentContext): string {
  const pullRequest = /^PR #(\d+)/u.exec(comment.sectionTitle);
  if (pullRequest && !isPullRequestSummaryContext(comment)) {
    return `#${pullRequest[1]} review comment`;
  }
  return reviewCommentContextLabel(comment);
}

function ComposerContextChip({
  mark,
  markClassName,
  label,
  code,
  tooltip,
  onRemove,
  removeLabel,
  ...props
}: Omit<ComponentProps<"span">, "children"> & {
  readonly mark: ReactNode;
  readonly markClassName: string;
  readonly label: string;
  readonly code?: boolean;
  readonly tooltip?: string | undefined;
  readonly onRemove: () => void;
  readonly removeLabel: string;
}) {
  const chip = (
    <span
      className="flex h-6 min-w-0 max-w-64 shrink-0 items-center gap-1.5 rounded-md border border-border bg-muted/40 pe-0.5 ps-2 transition-[opacity,scale] duration-200 ease-out starting:scale-95 starting:opacity-0 motion-reduce:transition-none"
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center font-mono font-semibold text-3xs [&_svg]:size-3",
          markClassName,
        )}
      >
        {mark}
      </span>
      <span
        className={cn(
          "min-w-0 truncate text-foreground/85",
          code ? "font-mono text-2xs" : "text-xs",
        )}
      >
        {label}
      </span>
      <Button
        variant="ghost"
        size="icon-tiny"
        onClick={onRemove}
        aria-label={`Remove ${removeLabel}`}
      >
        <XIcon />
      </Button>
    </span>
  );
  if (!tooltip) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top" className="max-w-sm whitespace-pre-wrap">
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Review comments and picked preview elements, shown as small chips under the cards. */
export function ComposerContextChipRow({
  reviewComments,
  previewAnnotations,
  onRemoveReviewComment,
  onRemovePreviewAnnotation,
}: {
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly onRemoveReviewComment: (commentId: string) => void;
  readonly onRemovePreviewAnnotation: (annotationId: string) => void;
}) {
  return (
    <div className="flex min-w-0 basis-full flex-wrap items-center gap-1.5">
      {reviewComments.map((comment) => {
        const pullRequest = comment.sectionId.startsWith("pull-request:");
        const label = reviewCommentChipLabel(comment);
        return (
          <ComposerContextChip
            key={comment.id}
            data-composer-context-chip={comment.id}
            mark={pullRequest ? "PR" : <MessageCircleIcon />}
            markClassName={
              pullRequest ? "text-(--context-chip-pr-open)" : "text-(--context-chip-review-comment)"
            }
            label={label}
            tooltip={comment.text.trim() || undefined}
            removeLabel={label}
            onRemove={() => onRemoveReviewComment(comment.id)}
          />
        );
      })}
      {previewAnnotations.map((annotation) => {
        const { label, code } = previewAnnotationChipLabel(annotation);
        return (
          <ComposerContextChip
            key={annotation.id}
            data-composer-context-chip={annotation.id}
            mark={code ? "</>" : <MousePointerClickIcon />}
            markClassName="text-(--context-chip-preview-annotation)"
            label={label}
            code={code}
            tooltip={annotation.comment.trim() || annotation.pageTitle || undefined}
            removeLabel={label}
            onRemove={() => onRemovePreviewAnnotation(annotation.id)}
          />
        );
      })}
    </div>
  );
}

export function ComposerFilePreviewDialog({
  file,
  onRemove,
  onPreviewFileIdChange,
}: {
  readonly file: ComposerFileAttachment;
  readonly onRemove: (fileId: string) => void;
  readonly onPreviewFileIdChange: (fileId: string | null) => void;
}) {
  const onClose = () => onPreviewFileIdChange(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        className="h-[min(85vh,52rem)] max-w-4xl overflow-hidden"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{file.name}</DialogTitle>
        <AttachmentFilePreview
          key={file.id}
          name={file.name}
          mimeType={file.mimeType}
          sizeBytes={file.sizeBytes}
          file={file.file}
          origin="Draft"
          {...(file.uploadedAttachmentId && file.uploadEnvironmentId
            ? {
                asset: {
                  environmentId: file.uploadEnvironmentId,
                  attachmentId: file.uploadedAttachmentId,
                },
              }
            : {})}
          onRemove={() => {
            onRemove(file.id);
            onClose();
          }}
          onClose={onClose}
        />
      </DialogPopup>
    </Dialog>
  );
}

/** Thumbnails beside the single-line prompt while the composer rests. */
export function ComposerRestingImagePreviews({
  images,
  allImages,
  resolvedTheme,
  onExpandImage,
  onShowMore,
}: {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly allImages: ReadonlyArray<ComposerImageAttachment>;
  readonly resolvedTheme: "light" | "dark";
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
  readonly onShowMore: () => void;
}) {
  const counts = getRestingComposerImagePreviewCounts(images.length);
  const visibleImages = images.slice(0, counts.visibleCount);
  return (
    <div data-chat-composer-resting-images="true" className="flex shrink-0 items-center gap-1 ps-1">
      {visibleImages.map((image) => (
        <button
          key={image.id}
          type="button"
          className="relative size-7 shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-muted/60"
          aria-label={`Preview ${image.name}`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            const preview = buildExpandedImagePreview(allImages, image.id);
            if (preview) onExpandImage(preview);
          }}
        >
          {image.previewUrl ? (
            <ComposerImageThumbnail
              file={image.file}
              alt=""
              className="size-full object-cover"
              fallback={
                isHeicImageFile({ name: image.name, type: image.mimeType }) ? (
                  <AttachmentImage
                    name={image.name}
                    mimeType={image.mimeType}
                    src={image.previewUrl}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : (
                  <PierreEntryIcon
                    pathValue={image.name}
                    kind="file"
                    theme={resolvedTheme}
                    className="m-auto size-3.5"
                  />
                )
              }
            />
          ) : (
            <PierreEntryIcon
              pathValue={image.name}
              kind="file"
              theme={resolvedTheme}
              className="m-auto size-3.5"
            />
          )}
        </button>
      ))}
      {counts.overflowCount > 0 ? (
        <button
          type="button"
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/70 bg-muted/60 font-medium text-secondary-label text-xs tabular-nums outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          aria-label={`Show ${String(counts.overflowCount)} more image attachments`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={onShowMore}
        >
          +{counts.overflowCount}
        </button>
      ) : null}
    </div>
  );
}

/** Attachments of the queued message being edited; they are already uploaded. */
export function ComposerQueuedAttachmentRow({
  attachments,
  onRemove,
}: {
  readonly attachments: ReadonlyArray<{
    readonly attachment: ChatAttachment;
    readonly url: string | null;
  }>;
  readonly onRemove: (attachmentId: string) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {attachments.map(({ attachment, url }) => (
        <div
          key={attachment.id}
          className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
        >
          {attachment.type === "image" && url ? (
            <img src={url} alt={attachment.name} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center px-1 text-center text-3xs text-secondary-label">
              {attachment.name}
            </div>
          )}
          <Button
            variant="media-close"
            size="icon-xs"
            className="absolute right-1 top-1"
            onClick={() => onRemove(attachment.id)}
            aria-label={`Remove ${attachment.name}`}
          >
            <XIcon />
          </Button>
        </div>
      ))}
    </div>
  );
}

export function ComposerAttachButton({
  addComposerAttachments,
  focusComposer,
}: {
  readonly addComposerAttachments: (files: File[]) => Promise<boolean>;
  readonly focusComposer: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          // Inserting a chip refocuses the editor after the draft renders;
          // focusing synchronously here would report the editor's stale text
          // over the prompt that was just written.
          void addComposerAttachments(files).then((inserted) => {
            if (!inserted) focusComposer();
          });
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => inputRef.current?.click()}
              aria-label="Attach files"
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipPopup>Attach files</TooltipPopup>
      </Tooltip>
    </>
  );
}
