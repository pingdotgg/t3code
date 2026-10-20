import { memo, useEffect, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Image as ImageGlyph, Text as TextGlyph } from "lucide";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
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
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { expandedImageKey } from "./ExpandedImagePreview";

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
  const src =
    asset && assetUrl._tag === "Success" ? assetUrl.url + (item.srcFragment ?? "") : item.src;
  return (
    <MediaVideoPlayer
      src={src}
      label={item.name}
      sourceFailed={src === null && assetUrl._tag === "Failure"}
      originalUrl={item.originalUrl}
      preload="metadata"
      autoPlay={item.autoPlay ?? true}
      className="block max-h-[var(--media-height)] max-w-[var(--media-width)] text-center"
      videoClassName="aspect-auto max-h-[var(--media-height)] w-auto max-w-[var(--media-width)] rounded-lg border border-border/70 shadow-2xl"
      stateClassName={EXPANDED_MEDIA_STATE_CLASS_NAME}
      onRetry={
        asset
          ? async () => {
              try {
                return (await refreshAssetUrl()) ?? item.src;
              } catch (error) {
                if (item.src !== null) return item.src;
                throw error;
              }
            }
          : undefined
      }
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
  // JavaScript `%` keeps the sign of the dividend, and a negative index blanks the dialog.
  const imageCount = preview.images.length;
  const index =
    imageCount > 0 ? (((preview.index + imageOffset) % imageCount) + imageCount) % imageCount : 0;
  const item = preview.images[index];
  const asset = item?.actionsSource?.asset;
  const mediaAsset =
    asset?.resource._tag === "github-media" || asset?.resource._tag === "bitbucket-media"
      ? asset
      : undefined;
  const mediaAssetUrl = useAssetUrlState(
    mediaAsset?.environmentId ?? null,
    mediaAsset?.resource ?? null,
  );
  const imageSrc =
    mediaAsset && mediaAssetUrl._tag === "Success"
      ? mediaAssetUrl.url + (item?.srcFragment ?? "")
      : (item?.src ?? null);
  const originalSource: MediaActionSource = item?.actionsSource ?? {
    kind: item?.type === "video" ? "video" : "image",
    name: item?.name ?? "Media",
    src: item?.src ?? null,
  };
  const { asset: sourceAsset, ...directSource } = originalSource;
  const source =
    sourceAsset?.resource._tag === "bitbucket-media" && mediaAssetUrl._tag === "Failure"
      ? { ...directSource, src: imageSrc }
      : originalSource;
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

  const navigateImage = (direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
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
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || isContextMenuOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onEscape, { capture: true });
    return () => window.removeEventListener("keydown", onEscape, { capture: true });
  }, [onClose]);

  if (!item) return null;
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
        className="row-start-1 h-full max-h-[92vh] w-[92vw] max-w-[92vw] items-center justify-center overflow-visible [--media-width:92vw] [--media-height:min(calc((100vh-var(--native-titlebar-height,0px))*0.86),calc(100vh-var(--native-titlebar-height,0px)-160px))] sm:[--media-width:calc(92vw-96px)]"
        onKeyDown={onKeyDown}
        initialFocus={closeButtonRef}
        finalFocus={() => returnFocusTarget}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <DialogTitle className="sr-only">Expanded {mediaLabel} preview</DialogTitle>
        <Button
          type="button"
          ref={closeButtonRef}
          size="icon-sm"
          variant="media-close"
          className="absolute right-0 top-0 z-20"
          onClick={onClose}
          aria-label={`Close ${mediaLabel} preview`}
        >
          <XIcon />
        </Button>
        {preview.images.length > 1 && (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="left-0 top-auto bottom-0 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Previous media"
            onClick={() => navigateImage(-1)}
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        )}
        <MediaActions source={actionsSource}>
          <div className="relative isolate z-10 flex max-h-full max-w-[var(--media-width)] flex-col items-center">
            {item.type === "video" ? (
              <ExpandedVideo key={index} item={item} />
            ) : showingAccessibilityDetails ? (
              accessibilityDetails ? (
                <SnapShotAccessibilityData
                  details={accessibilityDetails}
                  className="h-[min(var(--media-height),40rem)] w-[min(var(--media-width),42rem)] transition-opacity duration-140 ease-out starting:opacity-0 rounded-lg border border-border/70 bg-background p-4 text-xs leading-5 shadow-2xl motion-reduce:transition-none"
                />
              ) : null
            ) : imageSrc === null || failedImageSrc === imageSrc ? (
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
                key={`${index}:${imageSrc}`}
                src={imageSrc}
                name={item.name}
                mimeType={item.mimeType}
                onError={() => setFailedImageSrc(imageSrc)}
              />
            )}
            <div className="mt-2 flex max-w-[var(--media-width)] items-center justify-center gap-1.5 text-xs text-white/80 max-sm:px-10">
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
            className="right-0 top-auto bottom-0 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
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

/**
 * The chat view's open media preview. It lives outside ChatView so opening or
 * closing it renders only the dialog host, not the whole chat chrome.
 */
const expandedImagePreviewAtom = Atom.make<{
  readonly threadKey: string;
  readonly preview: ExpandedImagePreview;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("chat:expanded-image-preview"));

export function openExpandedImagePreview(threadKey: string, preview: ExpandedImagePreview): void {
  appAtomRegistry.set(expandedImagePreviewAtom, { threadKey, preview });
}

function closeExpandedImagePreview(): void {
  appAtomRegistry.set(expandedImagePreviewAtom, null);
}

function closeExpandedImagePreviewFor(threadKey: string): void {
  if (appAtomRegistry.get(expandedImagePreviewAtom)?.threadKey === threadKey) {
    closeExpandedImagePreview();
  }
}

export function ExpandedImageDialogHost({ threadKey }: { readonly threadKey: string }) {
  const state = useAtomValue(expandedImagePreviewAtom);
  const preview = state?.threadKey === threadKey ? state.preview : null;
  const item = preview?.images[preview.index];
  const ownedSrc = item?.ownsSrc === true ? item.src : null;
  useEffect(() => {
    if (ownedSrc === null) return;
    return () => URL.revokeObjectURL(ownedSrc);
  }, [ownedSrc]);
  // Leaving the thread (or the chat view) drops its preview.
  useEffect(() => () => closeExpandedImagePreviewFor(threadKey), [threadKey]);
  if (preview === null) return null;
  return (
    <ExpandedImageDialog
      key={expandedImageKey(preview)}
      preview={preview}
      onClose={closeExpandedImagePreview}
    />
  );
}
