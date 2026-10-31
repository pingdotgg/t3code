import { memo, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { cn } from "~/lib/utils";
import {
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  ImageIcon,
  MinusIcon,
  PlusIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { flushSync } from "react-dom";
import { Button } from "../ui/button";
import { Image as ImageGlyph, Text as TextGlyph } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { OpenMediaLink } from "../media/OpenMediaLink";
import { MediaActions, useMediaByteAction, type MediaActionSource } from "../media/MediaActions";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { isContextMenuOpen } from "../../contextMenuFallback";
import {
  SnapShotAccessibilityData,
  SnapShotContentsButton,
  snapShotAccessibilityDetails,
} from "./SnapShotAttachmentDetails";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ZoomableImage, type ZoomableImageHandle, type ZoomableImageView } from "./ZoomableImage";
import { readLocalApi } from "../../localApi";
import { toastManager } from "../ui/toast";
import { composerFloatingLayerProps } from "./composerEventScope";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { expandedImageKey } from "./ExpandedImagePreview";
import { registerThreadOverlay } from "./threadOverlayRetention";
import { mediaReferenceFileName } from "@t3tools/client-runtime/media-reference";
import { mediaMimeType, mediaMimeTypeFromExtension } from "@t3tools/shared/mediaPreview";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

const EXPANDED_MEDIA_STATE_CLASS_NAME =
  "flex aspect-auto h-48 min-h-0 w-[min(var(--media-width),32rem)] flex-col items-center justify-center gap-3 rounded-card border border-border bg-black p-6 text-center text-body text-white shadow-dialog";

function ExpandedMediaFailure({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className={EXPANDED_MEDIA_STATE_CLASS_NAME}>
      {children}
    </div>
  );
}

function itemMimeType(item: ExpandedImageItem): string | undefined {
  if (item.mimeType) return item.mimeType;
  const reference = item.actionsSource?.reference;
  const fileName = reference && mediaReferenceFileName(reference);
  if (fileName) {
    return mediaMimeTypeFromExtension(fileName.slice(fileName.lastIndexOf("."))) ?? undefined;
  }
  return mediaMimeType(item.src ?? "") ?? undefined;
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

/** An http(s) destination the viewer can hand to the system browser, never a blob or data URL. */
function browserUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const protocol = new URL(url, window.location.href).protocol;
    return protocol === "http:" || protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function MediaBarButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

function MediaThumbnail({ item }: { item: ExpandedImageItem }) {
  const [failed, setFailed] = useState(false);
  if (item.type === "video" || item.src === null || failed) {
    const Icon = item.type === "video" ? VideoIcon : ImageIcon;
    return <Icon aria-hidden="true" className="size-3.5 text-dim-foreground" />;
  }
  return (
    <img
      src={item.src}
      alt=""
      aria-hidden="true"
      draggable={false}
      loading="lazy"
      decoding="async"
      className="size-full object-cover"
      onError={() => setFailed(true)}
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
  const [naturalSize, setNaturalSize] = useState<{
    src: string;
    width: number;
    height: number;
  } | null>(null);
  const [view, setView] = useState<ZoomableImageView | null>(null);
  const zoomableImageRef = useRef<ZoomableImageHandle>(null);
  const [returnFocusTarget] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  // The host unmounts the dialog outright, so Base UI never runs finalFocus. Without
  // this, focus stays on the removed dialog, and the composer that owned the opener
  // reads that as a blur and rests.
  const close = () => {
    flushSync(onClose);
    if (returnFocusTarget?.isConnected) returnFocusTarget.focus({ preventScroll: true });
  };
  const closeButtonRef = useRef<HTMLButtonElement>(null);
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
          close();
        },
      }
    : source;
  const runByteAction = useMediaByteAction(actionsSource);

  const navigateImage = (direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
  };
  const selectImage = (target: number) => {
    setImageOffset(target - preview.index);
  };

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
  const imageFailed = item.src === null || failedImageSrc === item.src;
  const zoomable = item.type !== "video" && !showingAccessibilityDetails && !imageFailed;
  const unavailable = actionsSource.src === null && actionsSource.asset === undefined;
  const canCopyImage =
    item.type !== "video" &&
    !unavailable &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.clipboard?.write) &&
    typeof ClipboardItem !== "undefined";
  const externalUrl =
    item.originalUrl && resolveExternalWebLinkHost(item.originalUrl) !== null
      ? item.originalUrl
      : browserUrl(item.src);
  const openExternally = actionsSource.onOpenFile
    ? { label: "Open in file viewer", run: actionsSource.onOpenFile }
    : externalUrl
      ? {
          label: item.originalUrl ? "Open original" : "Open in browser",
          run: () => {
            void readLocalApi()
              ?.shell.openExternal(externalUrl)
              .catch((error: unknown) => {
                toastManager.add({
                  type: "error",
                  title: "Could not open link",
                  description: error instanceof Error ? error.message : "An error occurred.",
                });
              });
          },
        }
      : null;
  const dimensions =
    naturalSize && naturalSize.src === item.src
      ? `${naturalSize.width.toLocaleString()} × ${naturalSize.height.toLocaleString()}`
      : null;
  const meta = [
    imageCount > 1 ? `${index + 1} of ${imageCount}` : null,
    item.type === "video" ? null : dimensions,
    item.sizeBytes !== undefined ? formatAttachmentSize(item.sizeBytes) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const zoomPercent = view ? `${Math.round(view.scale * 100)}%` : "100%";

  return (
    <Dialog
      open
      onOpenChange={(open, eventDetails) => {
        if (open) return;
        // Escape belongs to an open context menu first.
        if (eventDetails.reason === "escape-key" && isContextMenuOpen()) {
          eventDetails.cancel();
          return;
        }
        close();
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        // --media-height keeps ZoomableImage's reserved 200px for the bar and thumbnails.
        className="row-start-1 h-full max-h-[92vh] w-[92vw] max-w-[92vw] items-center justify-center overflow-visible [--media-width:92vw] [--media-height:min(calc((100vh-var(--native-titlebar-height,0px))*0.86),calc(100vh-var(--native-titlebar-height,0px)-200px))] sm:[--media-width:calc(92vw-96px)]"
        onKeyDownCapture={(event) => {
          if (
            event.key !== "Escape" ||
            isContextMenuOpen() ||
            !(event.target instanceof Node) ||
            !event.currentTarget.contains(event.target)
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
        onKeyDown={onKeyDown}
        initialFocus={closeButtonRef}
        finalFocus={() => returnFocusTarget}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <DialogTitle className="sr-only">Expanded {mediaLabel} preview</DialogTitle>
        <div className="relative isolate z-10 flex w-fit min-w-[min(var(--media-width),36rem)] max-w-[var(--media-width)] flex-col items-center gap-2.5">
          <div
            role="toolbar"
            aria-label={`${item.name} actions`}
            className="flex h-10 w-0 min-w-full items-center gap-2 rounded-card surface-popover pr-1.5 pl-3"
          >
            <ImageIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span
              className="min-w-0 truncate text-label text-foreground"
              aria-live="polite"
              aria-atomic="true"
            >
              {item.name}
              <span className="sr-only">
                {imageCount > 1 ? ` (${index + 1}/${imageCount})` : ""}
              </span>
            </span>
            {meta ? (
              <span className="shrink-0 text-meta text-dim-foreground tabular-nums max-sm:hidden">
                {meta}
              </span>
            ) : null}
            <span className="flex-1" />
            {accessibilityDetails && item.source ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-sm"
                      variant={showingAccessibilityDetails ? "secondary" : "ghost"}
                      aria-label={contentsLabel}
                      aria-pressed={showingAccessibilityDetails}
                      onClick={() =>
                        setAccessibilityDetailsSrc(showingAccessibilityDetails ? null : item.src)
                      }
                    />
                  }
                >
                  <MorphIcon
                    aria-hidden="true"
                    icon={showingAccessibilityDetails ? ImageGlyph : TextGlyph}
                  />
                </TooltipTrigger>
                <TooltipPopup side="bottom">{contentsLabel}</TooltipPopup>
              </Tooltip>
            ) : item.source ? (
              <SnapShotContentsButton source={item.source} side="bottom" />
            ) : null}
            {zoomable ? (
              <div className="flex h-7 shrink-0 items-center rounded-control surface-well px-0.5 max-sm:hidden">
                {/* aria-disabled keeps focus in the dialog when a click reaches a zoom limit, so arrow keys still navigate. */}
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  aria-label="Zoom out"
                  aria-disabled={!view?.canZoomOut}
                  onClick={() => zoomableImageRef.current?.zoomOut()}
                >
                  <MinusIcon aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  aria-label={`Zoom ${zoomPercent}, reset to fit`}
                  aria-disabled={!view?.canZoomOut}
                  onClick={() => zoomableImageRef.current?.resetZoom()}
                >
                  <span className="min-w-8 text-center tabular-nums">{zoomPercent}</span>
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  aria-label="Zoom in"
                  aria-disabled={!view?.canZoomIn}
                  onClick={() => zoomableImageRef.current?.zoomIn()}
                >
                  <PlusIcon aria-hidden="true" />
                </Button>
              </div>
            ) : null}
            {item.type !== "video" ? (
              <MediaBarButton
                label="Copy image"
                disabled={!canCopyImage}
                onClick={() => void runByteAction("copy-image")}
              >
                <CopyIcon aria-hidden="true" />
              </MediaBarButton>
            ) : null}
            <MediaBarButton
              label={`Save ${mediaLabel}`}
              disabled={unavailable}
              onClick={() => void runByteAction("save")}
            >
              <DownloadIcon aria-hidden="true" />
            </MediaBarButton>
            {openExternally ? (
              <MediaBarButton label={openExternally.label} onClick={openExternally.run}>
                <ExternalLinkIcon aria-hidden="true" />
              </MediaBarButton>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    ref={closeButtonRef}
                    size="icon-sm"
                    variant="secondary"
                    onClick={close}
                    aria-label={`Close ${mediaLabel} preview`}
                  />
                }
              >
                <XIcon aria-hidden="true" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Close</TooltipPopup>
            </Tooltip>
          </div>
          <MediaActions source={actionsSource}>
            <div className="max-w-[var(--media-width)]">
              {item.type === "video" ? (
                <ExpandedVideo key={index} item={item} />
              ) : showingAccessibilityDetails ? (
                accessibilityDetails ? (
                  <SnapShotAccessibilityData
                    details={accessibilityDetails}
                    className="h-[min(var(--media-height),40rem)] w-[min(var(--media-width),42rem)] transition-opacity duration-140 ease-out starting:opacity-0 rounded-card surface-panel p-4 text-meta leading-5 motion-reduce:transition-none"
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
                  mimeType={itemMimeType(item)}
                  onError={() => setFailedImageSrc(item.src)}
                  onNaturalSize={(size) => {
                    if (item.src !== null) setNaturalSize({ src: item.src, ...size });
                  }}
                  onViewChange={setView}
                />
              )}
            </div>
          </MediaActions>
          {imageCount > 1 ? (
            <div
              role="listbox"
              aria-label="Media in this message"
              aria-orientation="horizontal"
              className="flex w-0 min-w-full justify-center-safe gap-2 overflow-x-auto p-0.5"
            >
              {preview.images.map((thumbnail, thumbnailIndex) => (
                <button
                  // Items have no ids and the same media can repeat, so the position is the identity.
                  // oxlint-disable-next-line react/no-array-index-key
                  key={thumbnailIndex}
                  type="button"
                  role="option"
                  aria-selected={thumbnailIndex === index}
                  aria-label={`${thumbnail.name} (${thumbnailIndex + 1}/${imageCount})`}
                  tabIndex={thumbnailIndex === index ? 0 : -1}
                  className="group flex h-9 w-14 shrink-0 cursor-pointer outline-none"
                  onClick={() => selectImage(thumbnailIndex)}
                >
                  <span
                    className={cn(
                      "flex size-full items-center justify-center overflow-hidden rounded-row bg-muted group-focus-visible:ring-2 group-focus-visible:ring-inset group-focus-visible:ring-ring",
                      thumbnailIndex === index
                        ? "ring-2 ring-ring"
                        : "opacity-70 ring-1 ring-border group-hover:opacity-100",
                    )}
                  >
                    <MediaThumbnail item={thumbnail} />
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
});

// Keep preview state outside ChatView to isolate dialog renders.
type ExpandedImagePreviewState = {
  readonly threadKey: string;
  readonly preview: ExpandedImagePreview;
} | null;

const expandedImagePreviewAtom = Atom.make<ExpandedImagePreviewState>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("chat:expanded-image-preview"),
);

function ownedSrc(state: ExpandedImagePreviewState): string | null {
  const item = state?.preview.images[state.preview.index];
  return item?.ownsSrc === true ? item.src : null;
}

// The preview owns a blob URL made for it, so whatever replaces it releases that URL.
function setExpandedImagePreview(next: ExpandedImagePreviewState): void {
  const previous = ownedSrc(appAtomRegistry.get(expandedImagePreviewAtom));
  appAtomRegistry.set(expandedImagePreviewAtom, next);
  if (previous !== null && previous !== ownedSrc(next)) URL.revokeObjectURL(previous);
}

export function openExpandedImagePreview(threadKey: string, preview: ExpandedImagePreview): void {
  setExpandedImagePreview({ threadKey, preview });
}

function closeExpandedImagePreview(): void {
  setExpandedImagePreview(null);
}

// Leaving the thread's route (or the chat view) drops its preview.
registerThreadOverlay((threadKey) => {
  const current = appAtomRegistry.get(expandedImagePreviewAtom);
  if (current !== null && current.threadKey !== threadKey) closeExpandedImagePreview();
});

export function ExpandedImageDialogHost({ threadKey }: { readonly threadKey: string }) {
  const state = useAtomValue(expandedImagePreviewAtom);
  const preview = state?.threadKey === threadKey ? state.preview : null;
  if (preview === null) return null;
  return (
    <ExpandedImageDialog
      key={expandedImageKey(preview)}
      preview={preview}
      onClose={closeExpandedImagePreview}
    />
  );
}
