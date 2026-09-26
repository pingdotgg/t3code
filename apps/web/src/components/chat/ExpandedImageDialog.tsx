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
  ImageIcon,
  SquareDashedMousePointerIcon,
  TextIcon,
  XIcon,
} from "lucide-react";
import { imageRegionCitationName, type ImageRegion } from "~/lib/imageRegionCitation";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Popover, PopoverPopup } from "../ui/popover";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { useComposerHandleContext } from "../../composerHandleContext";
import { OpenMediaLink } from "../media/OpenMediaLink";
import { MediaActions, useMediaActionUrl, type MediaActionSource } from "../media/MediaActions";
import { readMediaImageRegion } from "../media/mediaContent";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { isContextMenuOpen } from "../../contextMenuFallback";
import {
  SnapShotAccessibilityData,
  SnapShotContentsButton,
  snapShotAccessibilityDetails,
} from "./SnapShotAttachmentDetails";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CitationCommentEditor } from "./CitationCommentEditor";
import { ImageRegionCiteLayer } from "./ImageRegionCiteLayer";
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

function ExpandedVideo({ item }: { readonly item: ExpandedImageItem }) {
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
      autoPlay={item.autoPlay ?? true}
      className="block max-h-[var(--media-height)] max-w-[var(--media-width)] text-center"
      videoClassName="aspect-auto max-h-[var(--media-height)] w-auto max-w-[var(--media-width)] rounded-lg border border-border/70 shadow-2xl"
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
  const actionUrl = useMediaActionUrl(source);
  const accessibilityDetails = item?.source ? snapShotAccessibilityDetails(item.source) : undefined;
  const showingAccessibilityDetails =
    Boolean(accessibilityDetails) && accessibilityDetailsSrc === item?.src;

  // Citing sends a crop of the image to the composer, so it needs a composer and loaded pixels.
  const composerRef = useComposerHandleContext();
  const [citeMode, setCiteMode] = useState(false);
  const [pendingRegion, setPendingRegion] = useState<ImageRegion | null>(null);
  const [citedRegionsBySrc, setCitedRegionsBySrc] = useState<
    ReadonlyMap<string, ReadonlyArray<ImageRegion>>
  >(() => new Map());
  const [citing, setCiting] = useState(false);
  const pendingRegionRef = useRef<HTMLDivElement>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const citableSrc =
    composerRef !== null &&
    item !== undefined &&
    item.type !== "video" &&
    item.src !== null &&
    failedImageSrc !== item.src &&
    !showingAccessibilityDetails
      ? item.src
      : null;
  const selecting = citeMode && citableSrc !== null;
  const toggleCiteMode = () => {
    setCiteMode((current) => !current);
    setPendingRegion(null);
  };
  const citeRegion = async (region: ImageRegion, comment: string) => {
    if (!item || citableSrc === null) return;
    const composer = composerRef?.current;
    if (!composer) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "No composer to cite into",
          description: "Open a thread, then cite the region again.",
        }),
      );
      return;
    }
    const src = citableSrc;
    const name = imageRegionCitationName(item.name);
    // The crop's outline matches the one the user drew.
    const outlineColor = pendingRegionRef.current
      ? getComputedStyle(pendingRegionRef.current).borderTopColor
      : "";
    setCiting(true);
    try {
      const crop = async () =>
        readMediaImageRegion(await actionUrl(), region, { name, outlineColor });
      if (!(await composer.citeImageRegion(crop, comment))) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "The composer can't take this region right now",
            description:
              "Finish any pending approval or question, or wait for the connection, then cite again.",
          }),
        );
        return;
      }
      setCitedRegionsBySrc((current) =>
        new Map(current).set(src, [...(current.get(src) ?? []), region]),
      );
      setPendingRegion((current) => (current === region ? null : current));
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not cite the region",
          description: error instanceof Error ? error.message : "The image could not be read.",
        }),
      );
    } finally {
      setCiting(false);
    }
  };

  const navigateImage = useCallback((direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
    setPendingRegion(null);
  }, []);

  // Closing the comment box removes the focused field, dropping focus to the page. The dialog
  // keeps its keys (C, arrows) without focusing the media, whose tooltip shows the file path.
  useEffect(() => {
    if (pendingRegion === null && document.activeElement === document.body) {
      popupRef.current?.focus({ preventScroll: true });
    }
  }, [pendingRegion]);

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
    if (
      citableSrc !== null &&
      event.key.toLowerCase() === "c" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.repeat
    ) {
      event.preventDefault();
      event.stopPropagation();
      toggleCiteMode();
      return;
    }
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
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || isContextMenuOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      // Each Escape backs out one step: the pending region, then region selection, then the dialog.
      if (selecting && pendingRegion) {
        setPendingRegion(null);
      } else if (selecting) {
        setCiteMode(false);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onEscape, { capture: true });
    return () => window.removeEventListener("keydown", onEscape, { capture: true });
  }, [onClose, pendingRegion, selecting]);

  if (!item) return null;
  const mediaLabel = item.type === "video" ? "video" : "image";
  const openOriginalLink =
    item.originalUrl && resolveExternalWebLinkHost(item.originalUrl) !== null ? (
      <OpenMediaLink originalUrl={item.originalUrl} />
    ) : null;
  const contentsLabel = showingAccessibilityDetails
    ? "Show screenshot"
    : accessibilityDetails?.format === "json"
      ? "Show accessibility JSON"
      : "Show extracted text";
  const ContentsIcon = showingAccessibilityDetails ? ImageIcon : TextIcon;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        ref={popupRef}
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
          <div className="relative isolate z-10 max-h-[92vh] max-w-[var(--media-width)]">
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
              <ExpandedVideo key={index} item={item} />
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
                selecting={selecting}
                overlay={
                  selecting ? (
                    <ImageRegionCiteLayer
                      cited={citedRegionsBySrc.get(item.src) ?? []}
                      pending={pendingRegion}
                      pendingRef={pendingRegionRef}
                      onSelect={setPendingRegion}
                    />
                  ) : undefined
                }
              />
            )}
            <Popover
              open={selecting && pendingRegion !== null}
              onOpenChange={(open) => {
                if (!open) setPendingRegion(null);
              }}
            >
              <PopoverPopup
                {...composerFloatingLayerProps}
                anchor={pendingRegionRef}
                side="bottom"
                align="start"
                width="md"
                padding="compact"
                aria-label="Comment on selected region"
                initialFocus={() => {
                  commentInputRef.current?.focus({ preventScroll: true });
                  return false;
                }}
                finalFocus={false}
              >
                {pendingRegion ? (
                  <CitationCommentEditor
                    key={`${pendingRegion.x}:${pendingRegion.y}:${pendingRegion.width}:${pendingRegion.height}`}
                    label="Comment on selected region"
                    description="Enter to cite the region with this comment; Shift+Enter for a new line."
                    submitLabel={citing ? "Citing…" : "Cite"}
                    submitDisabled={citing}
                    inputRef={commentInputRef}
                    onSubmit={(comment) => void citeRegion(pendingRegion, comment)}
                    onCancel={() => setPendingRegion(null)}
                  />
                ) : null}
              </PopoverPopup>
            </Popover>
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
                    <ContentsIcon className="size-3" aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{contentsLabel}</TooltipPopup>
                </Tooltip>
              ) : item.source ? (
                <SnapShotContentsButton source={item.source} side="top" />
              ) : null}
              {citableSrc !== null ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-pressed={selecting}
                        aria-keyshortcuts="C"
                        data-pressed={selecting ? "" : undefined}
                        onClick={toggleCiteMode}
                        size="micro"
                        variant="overlay"
                      />
                    }
                  >
                    <SquareDashedMousePointerIcon aria-hidden="true" />
                    Cite
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {selecting ? "Stop selecting (C)" : "Select a region to cite (C)"}
                  </TooltipPopup>
                </Tooltip>
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
