import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Maximize2Icon,
  PictureInPicture2Icon,
  XIcon,
} from "lucide-react";
import { Image as ImageGlyph, Text as TextGlyph } from "lucide";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { createPortal } from "react-dom";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { readVideoHandoff, type VideoHandoff } from "../media/videoHandoff";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { OpenMediaLink } from "../media/OpenMediaLink";
import { MediaActions, type MediaActionSource } from "../media/MediaActions";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { isContextMenuOpen } from "../../contextMenuFallback";
import {
  SnapShotAccessibilityData,
  SnapShotContentsButton,
  snapShotAccessibilityDetails,
} from "./SnapShotAttachmentDetails";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

const EXPANDED_MEDIA_STATE_CLASS_NAME =
  "flex aspect-auto h-48 min-h-0 w-[min(var(--media-width),32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white shadow-2xl";

function ExpandedMediaFailure({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className={EXPANDED_MEDIA_STATE_CLASS_NAME}>
      {children}
    </div>
  );
}

function ExpandedVideo({
  item,
  handoff,
  className,
  videoClassName,
}: {
  readonly item: ExpandedImageItem;
  readonly handoff: VideoHandoff | null;
  readonly className: string;
  readonly videoClassName: string;
}) {
  const asset = item.actionsSource?.asset;
  const assetUrl = useAssetUrlState(asset?.environmentId ?? null, asset?.resource ?? null);
  const refreshAssetUrl = useAssetUrlRefresh(asset?.environmentId ?? null, asset?.resource ?? null);
  const src = asset
    ? assetUrl._tag === "Success"
      ? assetUrl.url + (item.srcFragment ?? "")
      : null
    : item.src;
  return (
    <MediaVideoPlayer
      src={src}
      label={item.name}
      sourceFailed={assetUrl._tag === "Failure"}
      originalUrl={item.originalUrl}
      preload="metadata"
      autoPlay={handoff ? handoff.playing : (item.autoPlay ?? true)}
      resumeFrom={handoff ?? undefined}
      className={className}
      videoClassName={videoClassName}
      stateClassName={EXPANDED_MEDIA_STATE_CLASS_NAME}
      onRetry={asset ? refreshAssetUrl : undefined}
    />
  );
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: ExpandedImageDialogProps) {
  const [imageOffset, setImageOffset] = useState(0);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const [accessibilityDetailsSrc, setAccessibilityDetailsSrc] = useState<string | null>(null);
  const zoomableImageRef = useRef<ZoomableImageHandle>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  // A minimized video keeps playing in a corner while the thread stays usable.
  const [minimized, setMinimized] = useState(preview.minimized ?? false);
  const [videoHandoff, setVideoHandoff] = useState<VideoHandoff | null>(preview.handoff ?? null);
  const [returnFocusTarget] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // The offset accumulates without bound, so wrap it into range in both directions:
  // JavaScript `%` keeps the sign of the dividend, and a negative index blanks the dialog.
  const imageCount = preview.images.length;
  const index =
    imageCount > 0 ? (((preview.index + imageOffset) % imageCount) + imageCount) % imageCount : 0;
  const item = preview.images[index];
  const source: MediaActionSource = item?.actionsSource ?? {
    kind: item?.type === "video" ? "video" : "image",
    name: item?.name ?? "Media",
    src: item?.src ?? null,
  };
  const openFile = source.onOpenFile;
  const actionsSource: MediaActionSource = openFile
    ? {
        ...source,
        onOpenFile: () => {
          openFile();
          onClose();
        },
      }
    : source;

  const navigateImage = useCallback((direction: -1 | 1) => {
    setVideoHandoff(null);
    setImageOffset((current) => current + direction);
  }, []);
  const toggleMinimized = () => {
    setVideoHandoff(readVideoHandoff(mediaRef.current?.querySelector("video")));
    setMinimized((current) => !current);
  };

  // The element that opened the preview gets focus back on close. Without
  // this a close button click leaves focus on the unmounted dialog, and the
  // composer that owned the opener reads that as a blur and rests.
  const openerRef = useRef<Element | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement;
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isContextMenuOpen() || event.target instanceof HTMLVideoElement)
      return;
    if (zoomableImageRef.current?.pan(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (preview.images.length <= 1) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      navigateImage(-1);
      return;
    }
    if (event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    navigateImage(1);
  };

  useEffect(() => {
    // The mini player is not modal, so Escape stays with whatever has focus.
    if (minimized) return;
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || isContextMenuOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onEscape, { capture: true });
    return () => window.removeEventListener("keydown", onEscape, { capture: true });
  }, [minimized, onClose]);

  if (!item) return null;
  if (minimized && item.type === "video") {
    // Portaled so a transformed or virtualized ancestor can neither offset nor unmount it.
    return createPortal(
      <div
        ref={mediaRef}
        role="region"
        aria-label={`Mini player: ${item.name}`}
        className="fixed right-4 bottom-4 z-50 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border/70 bg-black shadow-2xl"
      >
        <ExpandedVideo
          key={index}
          item={item}
          handoff={videoHandoff}
          className="block w-full"
          videoClassName="aspect-video w-full"
        />
        <div className="absolute top-2 right-2 flex gap-1">
          <Button
            type="button"
            size="icon-xs"
            variant="media-close"
            onClick={toggleMinimized}
            aria-label="Expand video"
          >
            <Maximize2Icon />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="media-close"
            onClick={onClose}
            aria-label="Close mini player"
          >
            <XIcon />
          </Button>
        </div>
      </div>,
      document.body,
    );
  }
  const mediaLabel = item.type === "video" ? "video" : "image";
  const openOriginalLink =
    item.originalUrl && resolveExternalWebLinkHost(item.originalUrl) !== null ? (
      <OpenMediaLink originalUrl={item.originalUrl} />
    ) : null;
  const accessibilityDetails = item.source ? snapShotAccessibilityDetails(item.source) : undefined;
  const showingAccessibilityDetails =
    Boolean(accessibilityDetails) && accessibilityDetailsSrc === item.src;
  const contentsLabel = showingAccessibilityDetails
    ? "Show screenshot"
    : accessibilityDetails?.format === "json"
      ? "Show accessibility JSON"
      : "Show extracted text";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1 max-h-[92vh] w-[92vw] max-w-[92vw] items-center overflow-visible [--media-width:92vw] [--media-height:min(86vh,calc(100vh-160px))] sm:[--media-width:calc(92vw-96px)]"
        onKeyDown={onKeyDown}
        initialFocus={closeButtonRef}
        finalFocus={() => returnFocusTarget}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <DialogTitle className="sr-only">Expanded {mediaLabel} preview</DialogTitle>
        {preview.images.length > 1 && (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="left-0 top-auto -bottom-12 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Previous media"
            onClick={() => navigateImage(-1)}
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        )}
        <MediaActions source={actionsSource}>
          <div
            ref={mediaRef}
            className="relative isolate z-10 max-h-[92vh] max-w-[var(--media-width)]"
          >
            {item.type === "video" ? (
              <Button
                type="button"
                size="icon-xs"
                variant="media-close"
                className="absolute right-9 -top-10 z-20"
                onClick={toggleMinimized}
                aria-label="Open in mini player"
              >
                <PictureInPicture2Icon />
              </Button>
            ) : null}
            <Button
              type="button"
              ref={closeButtonRef}
              size="icon-xs"
              variant="media-close"
              className="absolute right-0 -top-10 z-20"
              onClick={onClose}
              aria-label={`Close ${mediaLabel} preview`}
            >
              <XIcon />
            </Button>
            {item.type === "video" ? (
              <ExpandedVideo
                key={index}
                item={item}
                handoff={videoHandoff}
                className="block max-h-[var(--media-height)] max-w-[var(--media-width)] text-center"
                videoClassName="aspect-auto max-h-[var(--media-height)] w-auto max-w-[var(--media-width)] rounded-lg border border-border/70 shadow-2xl"
              />
            ) : showingAccessibilityDetails ? (
              accessibilityDetails ? (
                <SnapShotAccessibilityData
                  details={accessibilityDetails}
                  className="h-[min(var(--media-height),40rem)] w-[min(var(--media-width),42rem)] transition-opacity duration-140 ease-out starting:opacity-0 rounded-lg border border-border/70 bg-background p-4 text-xs leading-5 shadow-2xl motion-reduce:transition-none"
                />
              ) : null
            ) : item.src === null || failedImageSrc === item.src ? (
              <ExpandedMediaFailure>
                <p>
                  {openOriginalLink
                    ? "This image could not be loaded."
                    : "Image unavailable. The file may have been moved or deleted."}
                </p>
                {openOriginalLink}
              </ExpandedMediaFailure>
            ) : (
              <ZoomableImage
                ref={zoomableImageRef}
                key={`${index}:${item.src}`}
                src={item.src}
                name={item.name}
                onError={() => setFailedImageSrc(item.src)}
              />
            )}
            <div className="mt-2 flex max-w-[var(--media-width)] items-center justify-center gap-1.5 text-xs text-white/80">
              <span className="truncate" aria-live="polite" aria-atomic="true">
                {item.name}
                {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
              </span>
              {accessibilityDetails && item.source ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label={contentsLabel}
                        aria-pressed={showingAccessibilityDetails}
                        onClick={() =>
                          setAccessibilityDetailsSrc(showingAccessibilityDetails ? null : item.src)
                        }
                        size="icon-micro"
                        variant="overlay"
                      />
                    }
                  >
                    <MorphIcon
                      className="size-3"
                      aria-hidden="true"
                      icon={showingAccessibilityDetails ? ImageGlyph : TextGlyph}
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{contentsLabel}</TooltipPopup>
                </Tooltip>
              ) : item.source ? (
                <SnapShotContentsButton source={item.source} side="top" />
              ) : null}
            </div>
          </div>
        </MediaActions>
        {preview.images.length > 1 && (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="right-0 top-auto -bottom-12 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Next media"
            onClick={() => navigateImage(1)}
          >
            <ChevronRightIcon className="size-5" />
          </Button>
        )}
      </DialogPopup>
    </Dialog>
  );
});
