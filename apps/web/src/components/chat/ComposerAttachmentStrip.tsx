import type {
  ChatAttachment,
  ChatFileAttachment,
  EnvironmentId,
  ScopedThreadRef,
  SnapShotSource,
} from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { CircleAlertIcon, PaperclipIcon, PlayIcon, XIcon } from "lucide-react";
import { type ComponentProps, useLayoutEffect, useRef } from "react";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  composerFileNeedsReattach,
} from "../../composerDraftStore";
import { retryAttachmentUpload, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import { formatAttachmentUploadProgress } from "../../lib/attachmentUploadState";
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
import {
  attachVideoThumbnail,
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { PierreEntryIcon } from "./PierreEntryIcon";
import {
  SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
  SnapShotAttachmentDetails,
} from "./SnapShotAttachmentDetails";
import { prepareVideoFirstFrame } from "../../lib/videoFirstFrame";

function ComposerVideoThumbnail({ file }: { file: File }) {
  const setVideo = (video: HTMLVideoElement | null) => {
    if (!video) return;
    return attachVideoThumbnail(video, file);
  };

  return (
    <video
      ref={setVideo}
      muted
      playsInline
      preload="metadata"
      aria-hidden="true"
      onLoadedMetadata={(event) => prepareVideoFirstFrame(event.currentTarget)}
      className="pointer-events-none absolute inset-0 size-full object-cover"
    />
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
        "mb-3 flex max-w-full gap-2",
        pendingSnapShotIds.length > 0 ||
          expandedImages.some((image) => image.source?.kind === "snap-shot")
          ? "snap-x snap-proximity overflow-x-auto overscroll-x-contain pb-1 scrollbar-thumb-foreground/18 scrollbar-track-transparent [scrollbar-width:thin] [&::-webkit-scrollbar]:h-2.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-3 [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-foreground/18 [&::-webkit-scrollbar-thumb]:bg-clip-content [&::-webkit-scrollbar-thumb:hover]:bg-foreground/28 [&::-webkit-scrollbar-track]:mx-1 [&::-webkit-scrollbar-track]:bg-transparent"
          : "flex-wrap",
      )}
    >
      {expandedImages
        .map((image) => {
          const upload = supportsAttachmentUploads ? uploadsByImageId[image.id] : undefined;
          const snapShotAnimationPending =
            image.source?.kind === "snap-shot" && pendingSnapShotIdSet.has(image.id);
          const snapShotArrival =
            image.source?.kind === "snap-shot" &&
            shouldAnimateSnapShotArrival(image.source.capturedAt);
          return (
            <SnapShotAttachmentFrame
              key={image.id}
              data-chat-composer-expanded-image="true"
              aria-hidden={snapShotAnimationPending || undefined}
              inert={snapShotAnimationPending || undefined}
              arrival={snapShotArrival}
              animateArrival={snapShotAnimations && !snapShotAnimationPending && snapShotArrival}
              animationId={snapShotAnimationPending ? image.id : undefined}
              animationSource={snapShotAnimationPending ? image.source : undefined}
              className={cn(
                "group/attachment shrink-0 snap-start bg-background",
                image.source?.kind === "snap-shot"
                  ? SNAP_SHOT_ATTACHMENT_FRAME_CLASS
                  : "relative h-16 w-16 overflow-hidden rounded-lg border border-border/80",
                snapShotAnimationPending && "invisible",
              )}
            >
              {image.previewUrl ? (
                <button
                  type="button"
                  className="h-full w-full cursor-zoom-in"
                  aria-label={`Preview ${image.name}`}
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
                      isHeicImageFile({ name: image.name, type: image.mimeType }) ? (
                        <AttachmentImage
                          name={image.name}
                          mimeType={image.mimeType}
                          src={image.previewUrl}
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
              {image.source?.kind === "snap-shot" ? (
                <SnapShotAttachmentDetails
                  source={image.source}
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
                            image,
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
              <span
                className={cn(
                  "absolute right-1 top-1 flex",
                  image.source?.kind === "snap-shot" &&
                    "opacity-0 transition-opacity pointer-coarse:opacity-100 group-hover/attachment:opacity-100 group-focus-within/attachment:opacity-100",
                )}
              >
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
            className="relative h-16 w-16 shrink-0 snap-start overflow-hidden rounded-lg border border-border/80 bg-black"
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
                  <ComposerVideoThumbnail file={file.file} />
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
            <Button
              variant="media-close"
              size="icon-xs"
              className="absolute right-1 top-1"
              onClick={() => onRemoveFile(file.id)}
              aria-label={`Remove ${file.name}`}
            >
              <XIcon />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** Non-media file attachments, listed under the media row. */
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
    <div className="mb-3 flex flex-col gap-1">
      {files.map((file) => {
        const fileCanUpload =
          supportsAttachmentUploads &&
          maxFileAttachmentBytes !== null &&
          file.sizeBytes <= maxFileAttachmentBytes;
        const upload = fileCanUpload ? uploadsByImageId[file.id] : undefined;
        const needsReattach = composerFileNeedsReattach(file);
        const canReattachFile = fileStagingLimit !== null && file.sizeBytes <= fileStagingLimit;
        return (
          <div
            key={file.id}
            className="flex min-w-0 items-center gap-2 py-1 text-sm text-foreground"
          >
            <PierreEntryIcon pathValue={file.name} kind="file" theme={resolvedTheme} />
            <button
              type="button"
              disabled={needsReattach}
              className="min-w-0 flex-1 truncate text-left hover:underline focus-visible:outline-2"
              onClick={() => onPreviewFile(file.id)}
            >
              {file.name}
            </button>
            <span className="shrink-0 text-xs text-secondary-label">
              {needsReattach
                ? canReattachFile
                  ? "Attach again"
                  : "Remove to send"
                : upload?.status === "uploading"
                  ? formatAttachmentUploadProgress(upload.progress)
                  : formatAttachmentSize(file.sizeBytes)}
            </span>
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
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => onRemoveFile(file.id)}
              aria-label={`Remove ${file.name}`}
            >
              <XIcon />
            </Button>
          </div>
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
          <PaperclipIcon />
        </TooltipTrigger>
        <TooltipPopup>Attach files</TooltipPopup>
      </Tooltip>
    </>
  );
}
