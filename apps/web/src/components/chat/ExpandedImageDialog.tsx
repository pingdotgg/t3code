import { m } from "~/i18n/messages";
import {
  lazy,
  memo,
  Suspense,
  useEffect,
  use,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";
import { T, useGT, msg } from "gt-react";
import { useBlocker } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ImageIcon,
  ImagesIcon,
  PencilIcon,
  TextIcon,
  XIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { OpenMediaLink } from "../media/OpenMediaLink";
import {
  ImageActionsContext,
  MediaActions,
  useMediaReadUrl,
  type MediaActionSource,
} from "../media/MediaActions";
import { readMediaBlob } from "../media/mediaContent";
import type { ImageEditorResult } from "../image-editor/ImageEditor";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { isContextMenuOpen } from "../../contextMenuFallback";
import {
  SnapShotAccessibilityData,
  SnapShotCopyButton,
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
import { registerThreadOverlay } from "./threadOverlayRetention";
import { mediaReferenceFileName } from "@t3tools/client-runtime/media-reference";
import { mediaMimeType, mediaMimeTypeFromExtension } from "@t3tools/shared/mediaPreview";
import { MAX_COMPRESSIBLE_SOURCE_BYTES } from "~/lib/imageCompression";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";
import { useStableCallback } from "~/hooks/useStableCallback";
import { toastManager } from "../ui/toast";
import { useComposerDraftStore } from "~/composerDraftStore";
import { resolveThreadOverlayKey } from "~/threadRoutes";
import { cn } from "~/lib/utils";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
  dockEditor?: boolean;
  /** An inline right panel shares the row, so the docked editor splits the rest with the chat. */
  dockBesidePanel?: boolean;
  onProtectionChange?: (protectedEdit: boolean) => void;
  onApply?: (item: ExpandedImageItem, result: ImageEditorResult) => Promise<void>;
  onLoadGallery?: () => Promise<ExpandedImageItem[]>;
  onApplyBatch?: (items: ExpandedImageItem[], prompt: string) => Promise<void>;
  onFrameSheet?: (
    item: ExpandedImageItem,
    file: File,
    context: string,
    original: File,
  ) => Promise<void>;
}

const ImageEditor = lazy(() =>
  import("../image-editor/ImageEditor").then((module) => ({ default: module.ImageEditor })),
);
const ImageGallery = lazy(() =>
  import("../image-editor/ImageGallery").then((module) => ({ default: module.ImageGallery })),
);

const EXPANDED_MEDIA_STATE_CLASS_NAME =
  "flex aspect-auto h-48 min-h-0 w-[min(var(--media-width),32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white shadow-2xl";

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

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
  onApply,
  onLoadGallery,
  onApplyBatch,
  onFrameSheet,
  onProtectionChange,
  dockEditor = false,
  dockBesidePanel = false,
}: ExpandedImageDialogProps) {
  const gt = useGT();
  const nativeTitlebarHeight = useNativeTitlebarHeight();
  const imageActions = use(ImageActionsContext);
  const [imageOffset, setImageOffset] = useState(0);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const [imageWidth, setImageWidth] = useState<{ src: string | null; width: number } | null>(null);
  const [accessibilityDetailsSrc, setAccessibilityDetailsSrc] = useState<string | null>(null);
  const [galleryItems, setGalleryItems] = useState<ExpandedImageItem[] | null>(
    preview.gallery ? preview.images : null,
  );
  const [gallery, setGallery] = useState(preview.gallery ?? false);
  const [galleryPreviewIndex, setGalleryPreviewIndex] = useState<number | null>(null);
  const [editing, setEditing] = useState<{
    item: ExpandedImageItem;
    src: string;
    mimeType: string | undefined;
    docked: boolean;
  } | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const mounted = useRef(true);
  const readUrl = useMediaReadUrl();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- protect this mounted preview from competing chat image actions while work is pending
  useEffect(() => {
    onProtectionChange?.(operationBusy || (editing !== null && editorDirty));
  }, [operationBusy, editing, editorDirty, onProtectionChange]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- async image preparation must not submit after this thread's preview unmounts
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the original-file blob URL owned by the mounted editor
  useEffect(
    () => () => {
      if (editing) URL.revokeObjectURL(editing.src);
    },
    [editing],
  );
  const zoomableImageRef = useRef<ZoomableImageHandle>(null);
  const [returnFocus] = useState(() => {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return { target, focusVisible: target?.matches(":focus-visible") ?? false };
  });
  // The host unmounts the dialog outright, so Base UI never runs finalFocus. Without
  // this, focus stays on the removed dialog, and the composer that owned the opener
  // reads that as a blur and rests. Preserve mouse focus when Escape closes it.
  const close = () => {
    flushSync(onClose);
    const { target, focusVisible } = returnFocus;
    if (target?.isConnected) target.focus({ preventScroll: true, focusVisible });
  };
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const images = galleryPreviewIndex !== null ? (galleryItems ?? preview.images) : preview.images;
  const imageCount = images.length;
  const index =
    imageCount > 0
      ? (((galleryPreviewIndex ?? preview.index + imageOffset) % imageCount) + imageCount) %
        imageCount
      : 0;
  const item = images[index];
  const source: MediaActionSource = item?.actionsSource ?? {
    kind: item?.type === "video" ? "video" : "image",
    name: item?.name ?? gt("Media"),
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

  const navigateImage = (direction: -1 | 1) => {
    if (galleryPreviewIndex !== null)
      setGalleryPreviewIndex((current) => (current ?? 0) + direction);
    else setImageOffset((current) => current + direction);
  };
  const backFromPreview = () => {
    if (galleryPreviewIndex !== null) setGallery(true);
    else close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      editing ||
      gallery ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      (event.target instanceof HTMLElement && event.target.isContentEditable)
    )
      return;
    if (event.defaultPrevented || isContextMenuOpen() || event.target instanceof HTMLVideoElement)
      return;
    if (zoomableImageRef.current?.pan(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (images.length <= 1) return;
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

  const startEditor = async (selectedItem = item) => {
    if (!selectedItem || loading) return;
    setLoading(true);
    setEditorError(null);
    const original = selectedItem.editorSession
      ? Promise.resolve(selectedItem.editorSession.originalFile)
      : selectedItem.actionsSource?.file
        ? Promise.resolve(selectedItem.actionsSource.file)
        : readUrl(
            selectedItem.actionsSource ?? {
              kind: "image",
              name: selectedItem.name,
              src: selectedItem.src,
            },
          ).then(readMediaBlob);
    const result = await original
      .then((blob) => {
        if (blob.size > MAX_COMPRESSIBLE_SOURCE_BYTES)
          throw new Error(gt("Image editing supports source files up to 50 MB."));
        return blob;
      })
      .then(
        (blob) => ({ blob, error: null }),
        (error: unknown) => ({ blob: null, error }),
      );
    if (!mounted.current) return;
    setLoading(false);
    if (result.blob) {
      setEditorDirty(false);
      setEditing({
        item: selectedItem,
        src: URL.createObjectURL(result.blob),
        mimeType: result.blob.type || itemMimeType(selectedItem),
        docked: dockEditor && galleryItems === null,
      });
    } else
      setEditorError(
        result.error instanceof Error
          ? result.error.message
          : gt("Unable to open the image editor."),
      );
  };
  const startEditorStable = useStableCallback(startEditor);
  const initialEditStarted = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a direct editor request loads fresh source bytes after the preview mounts
  useEffect(() => {
    if (!preview.edit || initialEditStarted.current) return;
    initialEditStarted.current = true;
    void startEditorStable();
  }, [preview.edit, startEditorStable]);
  const showGallery = async () => {
    if (loading) return;
    setEditorError(null);
    if (!galleryItems && onLoadGallery) {
      setLoading(true);
      const result = await onLoadGallery().then(
        (items) => ({ items, error: null }),
        (error: unknown) => ({ items: null, error }),
      );
      if (!mounted.current) return;
      setLoading(false);
      if (!result.items) {
        setEditorError(
          result.error instanceof Error
            ? result.error.message
            : gt("Unable to load conversation images."),
        );
        return;
      }
      setGalleryItems(result.items);
    } else if (!galleryItems) setGalleryItems(preview.images);
    setGallery(true);
  };

  if (!item && !gallery) return null;
  const isVideo = item?.type === "video";
  const openOriginalLink =
    item?.originalUrl && resolveExternalWebLinkHost(item.originalUrl) !== null ? (
      <OpenMediaLink originalUrl={item.originalUrl} />
    ) : null;
  const accessibilityDetails = item?.source ? snapShotAccessibilityDetails(item.source) : undefined;
  const showingAccessibilityDetails =
    Boolean(accessibilityDetails) && accessibilityDetailsSrc === item?.src;
  const contentsLabel = showingAccessibilityDetails
    ? gt("Show screenshot")
    : accessibilityDetails?.format === "json"
      ? gt("Show accessibility JSON")
      : gt("Show extracted text");

  const cancelEditor = () => {
    if (editing?.docked || preview.edit) close();
    else setEditing(null);
  };
  const editor = editing ? (
    <Suspense
      fallback={
        <p role="status">
          <T>Loading image editor…</T>
        </p>
      }
    >
      <ImageEditor
        key={editing.src}
        src={editing.src}
        name={editing.item.editorSession?.originalFile.name ?? editing.item.name}
        mimeType={editing.mimeType}
        initialOptions={editing.item.editorOptions ?? editing.item.editorSession?.options}
        {...(editing.item.editorSession
          ? { initialDocument: editing.item.editorSession.document }
          : {})}
        onBusyChange={setOperationBusy}
        onDirtyChange={setEditorDirty}
        resolveSrc={() => Promise.resolve(editing.src)}
        onCancel={cancelEditor}
        onApply={async (result) => {
          if (!mounted.current)
            throw new Error(gt("The image preview was closed. Reopen it to add these edits."));
          const apply = editing.item.onApply ?? preview.onApply ?? onApply;
          if (!apply)
            throw new Error(gt("Open the image from a thread to add edits to a message."));
          await apply(editing.item, result);
          close();
        }}
      />
    </Suspense>
  ) : null;

  if (editing?.docked) {
    return (
      <aside
        aria-label={gt("Image editor")}
        data-docked-image-editor
        className={cn(
          "flex h-full min-h-0 border-l border-border bg-background [-webkit-app-region:no-drag] max-lg:absolute max-lg:inset-0 max-lg:z-40 max-lg:w-full max-lg:max-w-none max-lg:min-w-0 [&>section]:h-full",
          dockBesidePanel
            ? // Chat, editor and panel each keep a usable width down to 1200px; below that the editor covers the row.
              "max-w-[56rem] min-w-[30rem] flex-1 @max-[1200px]/image-workspace:absolute @max-[1200px]/image-workspace:inset-0 @max-[1200px]/image-workspace:z-40 @max-[1200px]/image-workspace:w-full @max-[1200px]/image-workspace:max-w-none @max-[1200px]/image-workspace:min-w-0"
            : "w-[min(56%,56rem)] shrink-0 @max-[900px]/image-workspace:absolute @max-[900px]/image-workspace:inset-0 @max-[900px]/image-workspace:z-40 @max-[900px]/image-workspace:w-full",
        )}
        style={{
          paddingTop: `max(${nativeTitlebarHeight}px, var(--workspace-topbar-height, 0px))`,
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented || isContextMenuOpen()) return;
          if (
            event.target instanceof Element &&
            event.target.closest('[role="listbox"], [role="menu"]')
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (!operationBusy) close();
        }}
      >
        {editor}
      </aside>
    );
  }

  return (
    <ImageActionsContext
      value={
        imageActions
          ? {
              ...imageActions,
              openFile: (source) => {
                imageActions.openFile(source);
                close();
              },
            }
          : null
      }
    >
      <Dialog
        open
        onOpenChange={(open, eventDetails) => {
          if (open) return;
          if (operationBusy) {
            eventDetails.cancel();
            return;
          }
          if (editing) {
            eventDetails.cancel();
            if (eventDetails.reason === "outside-press" && editorDirty) return;
            cancelEditor();
            return;
          }
          // Escape belongs to an open context menu first.
          if (eventDetails.reason === "escape-key" && isContextMenuOpen()) {
            eventDetails.cancel();
            return;
          }
          if (!gallery && galleryPreviewIndex !== null) backFromPreview();
          else close();
        }}
      >
        <DialogPopup
          {...composerFloatingLayerProps}
          variant="media"
          mediaControlsPlacement="inside"
          showCloseButton={false}
          bottomStickOnMobile={false}
          className={`row-start-1 h-full max-h-full w-[min(92vw,calc(100vw-2rem))] max-w-full translate-y-0 ${editing || gallery ? "justify-center overflow-visible" : "justify-start overflow-hidden"}`}
          onKeyDown={onKeyDown}
          initialFocus={closeButtonRef}
          finalFocus={() => returnFocus.target}
          onClick={(event) => {
            if (event.target !== event.currentTarget || operationBusy) return;
            if (editing) {
              if (!editorDirty) cancelEditor();
            } else if (gallery) close();
            else backFromPreview();
          }}
        >
          <DialogTitle className="sr-only">
            {editing || preview.edit
              ? gt("Edit image")
              : gallery
                ? gt("Conversation images")
                : isVideo
                  ? gt("Expanded video preview")
                  : gt("Expanded image preview")}
          </DialogTitle>
          {editing ? editor : null}
          {galleryItems !== null ? (
            <div hidden={!gallery || editing !== null} className="h-full min-h-0 w-full">
              <Suspense
                fallback={
                  <p role="status">
                    <T>Loading image gallery…</T>
                  </p>
                }
              >
                <ImageGallery
                  images={galleryItems}
                  onOpen={(selectedIndex, edit) => {
                    setGalleryPreviewIndex(selectedIndex);
                    setGallery(false);
                    if (edit) void startEditor(galleryItems[selectedIndex]);
                  }}
                  onClose={
                    preview.gallery
                      ? close
                      : () => {
                          setGallery(false);
                          setGalleryPreviewIndex(null);
                        }
                  }
                  readImage={async (image) =>
                    readMediaBlob(
                      await readUrl(
                        image.actionsSource ?? { kind: "image", name: image.name, src: image.src },
                      ),
                    )
                  }
                  onApply={async (selectedItems, prompt) => {
                    if (!onApplyBatch)
                      throw new Error(gt("Open the gallery from a thread to add image feedback."));
                    await onApplyBatch(selectedItems, prompt);
                    close();
                  }}
                  {...(onFrameSheet ? { onFrameSheet } : {})}
                  onBusyChange={setOperationBusy}
                />
              </Suspense>
            </div>
          ) : null}
          {!editing && preview.edit && item ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-4">
              {editorError ? (
                <p role="alert" className="text-sm text-destructive">
                  {editorError}
                </p>
              ) : (
                <p role="status">
                  <T>Loading image editor…</T>
                </p>
              )}
              <Button
                ref={closeButtonRef}
                variant="media-close"
                onClick={close}
                aria-label={gt("Back, close image editor")}
              >
                <ArrowLeftIcon aria-hidden />
                <T>Back</T>
              </Button>
            </div>
          ) : null}
          {!editing && !gallery && !preview.edit && item ? (
            <>
              <div
                className="z-20 mx-auto mb-4 w-full min-w-[min(100%,12rem)] max-w-full shrink-0 pt-3 @container/media-toolbar [@media(max-height:400px)]:mb-1 [@media(max-height:400px)]:pt-1"
                style={{
                  width:
                    !showingAccessibilityDetails &&
                    item.type !== "video" &&
                    item.src !== null &&
                    failedImageSrc !== item.src &&
                    imageWidth?.src === item.src
                      ? imageWidth.width
                      : undefined,
                }}
              >
                <div className="flex h-9 items-center gap-2">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {galleryPreviewIndex !== null && (
                      <Button
                        type="button"
                        size="sm"
                        variant="media-close"
                        className="max-w-full max-sm:size-9 @max-[24rem]/media-toolbar:size-9"
                        onClick={backFromPreview}
                        aria-label={gt("Back, return to image gallery")}
                      >
                        <ArrowLeftIcon aria-hidden />
                        <span className="max-sm:sr-only @max-[24rem]/media-toolbar:sr-only">
                          <T>Back</T>
                        </span>
                      </Button>
                    )}
                    {item.type !== "video" && (
                      <Button
                        size="sm"
                        variant="media-close"
                        className="max-w-full max-sm:size-9 @max-[24rem]/media-toolbar:size-9"
                        aria-label={gt("Edit image")}
                        disabled={loading}
                        onClick={() => {
                          void startEditor();
                        }}
                      >
                        <PencilIcon aria-hidden />
                        <span className="max-sm:sr-only @max-[24rem]/media-toolbar:sr-only">
                          <T>Edit image</T>
                        </span>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="media-close"
                      className="max-w-full max-sm:size-9 @max-[24rem]/media-toolbar:size-9"
                      aria-label={onLoadGallery ? gt("All images") : gt("Gallery")}
                      disabled={loading}
                      onClick={() => {
                        void showGallery();
                      }}
                    >
                      <ImagesIcon aria-hidden />
                      <span className="max-sm:sr-only @max-[24rem]/media-toolbar:sr-only">
                        {onLoadGallery ? gt("All images") : gt("Gallery")}
                      </span>
                    </Button>
                  </div>
                  <Button
                    type="button"
                    ref={closeButtonRef}
                    size="icon"
                    variant="media-close"
                    className="@max-[24rem]/media-toolbar:size-9"
                    onClick={close}
                    aria-label={isVideo ? gt("Close video preview") : gt("Close image preview")}
                    title={isVideo ? gt("Close video preview") : gt("Close image preview")}
                  >
                    <XIcon aria-hidden />
                  </Button>
                </div>
              </div>
              {editorError && (
                <p
                  role="alert"
                  className="z-20 max-w-full shrink-0 rounded-lg bg-background p-3 text-sm text-destructive"
                >
                  {editorError}
                </p>
              )}
              <div
                className="relative flex min-h-0 w-full flex-1 flex-col items-center"
                onClick={(event) => {
                  if (event.target === event.currentTarget && !operationBusy) backFromPreview();
                }}
              >
                {images.length > 1 && (
                  <Button
                    type="button"
                    size="icon"
                    variant="media-navigation"
                    className="left-0 top-auto bottom-0 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
                    aria-label={gt("Previous media")}
                    onClick={() => navigateImage(-1)}
                  >
                    <ChevronLeftIcon className="size-5" />
                  </Button>
                )}
                <MediaActions
                  source={actionsSource}
                  showTooltip={false}
                  disabled={loading || operationBusy}
                  onEditImage={item.type === "video" ? undefined : () => startEditor()}
                  onOpenFile={
                    imageActions && item.type !== "video"
                      ? () => {
                          imageActions.openFile(source);
                          close();
                        }
                      : undefined
                  }
                >
                  <div className="flex h-full min-h-0 w-full min-w-0 flex-col items-center sm:px-12">
                    <div className="relative isolate z-10 flex min-h-0 w-full flex-1 items-center justify-center [container-type:size] [--media-width:100cqw] [--media-height:100cqh]">
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
                              ? gt("This image could not be loaded.")
                              : gt("Image unavailable. The file may have been moved or deleted.")}
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
                          onViewportWidthChange={(width) =>
                            setImageWidth((current) =>
                              current?.src === item.src && current.width === width
                                ? current
                                : { src: item.src, width },
                            )
                          }
                        />
                      )}
                    </div>
                    <div className="mt-2 flex min-h-0 w-full min-w-0 shrink-0 items-center justify-center gap-1.5 text-xs text-white/80 max-sm:px-10">
                      <span className="truncate" aria-live="polite" aria-atomic="true">
                        {item.name}
                        {images.length > 1 ? ` (${index + 1}/${images.length})` : ""}
                      </span>
                      {item.onCopySnapshot && (
                        <div className="-my-1.5">
                          <SnapShotCopyButton onCopy={item.onCopySnapshot} />
                        </div>
                      )}
                      {accessibilityDetails && item.source ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                aria-label={contentsLabel}
                                aria-pressed={showingAccessibilityDetails}
                                onClick={() =>
                                  setAccessibilityDetailsSrc(
                                    showingAccessibilityDetails ? null : item.src,
                                  )
                                }
                                size="icon-micro"
                                variant="overlay"
                              />
                            }
                          >
                            {showingAccessibilityDetails ? (
                              <ImageIcon className="size-3" aria-hidden="true" />
                            ) : (
                              <TextIcon className="size-3" aria-hidden="true" />
                            )}
                          </TooltipTrigger>
                          <TooltipPopup side="top">{contentsLabel}</TooltipPopup>
                        </Tooltip>
                      ) : item.source ? (
                        <SnapShotContentsButton source={item.source} side="top" />
                      ) : null}
                    </div>
                  </div>
                </MediaActions>
                {images.length > 1 && (
                  <Button
                    type="button"
                    size="icon"
                    variant="media-navigation"
                    className="right-0 top-auto bottom-0 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
                    aria-label={gt("Next media")}
                    onClick={() => navigateImage(1)}
                  >
                    <ChevronRightIcon className="size-5" />
                  </Button>
                )}
              </div>
            </>
          ) : null}
        </DialogPopup>
      </Dialog>
    </ImageActionsContext>
  );
});

// Keep preview state outside ChatView to isolate dialog renders.
type ExpandedImagePreviewState = {
  readonly id: number;
  readonly threadKey: string;
  readonly preview: ExpandedImagePreview;
  readonly replacementBlocked: boolean;
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

export function openExpandedImagePreview(
  threadKey: string,
  preview: ExpandedImagePreview,
  options?: { replaceCurrent?: boolean },
): boolean {
  const current = appAtomRegistry.get(expandedImagePreviewAtom);
  const next = { id: (current?.id ?? 0) + 1, threadKey, preview, replacementBlocked: false };
  if (current?.replacementBlocked && !options?.replaceCurrent) {
    canOpenExpandedImagePreview();
    const unused = ownedSrc(next);
    if (unused !== null && unused !== ownedSrc(current)) URL.revokeObjectURL(unused);
    return false;
  }
  setExpandedImagePreview(next);
  return true;
}

export function canOpenExpandedImagePreview(): boolean {
  const current = appAtomRegistry.get(expandedImagePreviewAtom);
  if (!current?.replacementBlocked) return true;
  toastManager.add({
    id: "image-edit-preview-blocked",
    type: "info",
    title: m(msg("Image edit in progress")),
    description: m(msg("Apply or close the image editor before opening another image.")),
  });
  return false;
}

function closeExpandedImagePreview(): void {
  setExpandedImagePreview(null);
}

// Leaving the thread's route (or the chat view) drops its preview.
registerThreadOverlay((threadKey) => {
  const current = appAtomRegistry.get(expandedImagePreviewAtom);
  if (current !== null && current.threadKey !== threadKey && !current.replacementBlocked)
    closeExpandedImagePreview();
});

export function ExpandedImageDialogHost({
  threadKey,
  ...props
}: { readonly threadKey: string } & Omit<ExpandedImageDialogProps, "preview" | "onClose">) {
  const gt = useGT();
  const state = useAtomValue(expandedImagePreviewAtom);
  const preview = state?.threadKey === threadKey ? state.preview : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- release this host's preview and protection when its chat pane unmounts
  useEffect(
    () => () => {
      if (appAtomRegistry.get(expandedImagePreviewAtom)?.threadKey === threadKey)
        closeExpandedImagePreview();
    },
    [threadKey],
  );
  useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (current.pathname === next.pathname || !preview || !state?.replacementBlocked)
        return false;
      const store = useComposerDraftStore.getState();
      const resolveDraft = (draftId: Parameters<typeof store.getDraftSession>[0]) =>
        store.getDraftSession(draftId) ?? store.getPromotedDraftRedirect(draftId);
      const nextKey = resolveThreadOverlayKey(next.params, resolveDraft);
      if (nextKey !== null && nextKey === resolveThreadOverlayKey(current.params, resolveDraft))
        return false;
      toastManager.add({
        id: "image-edit-navigation-blocked",
        type: "info",
        title: gt("Image edit in progress"),
        description: gt(
          "Finish the image action, then apply or close the editor before leaving this thread.",
        ),
      });
      return true;
    },
    enableBeforeUnload: false,
  });
  const onProtectionChange = useStableCallback((replacementBlocked: boolean) => {
    const current = appAtomRegistry.get(expandedImagePreviewAtom);
    if (current?.preview !== preview || current.replacementBlocked === replacementBlocked) return;
    appAtomRegistry.set(expandedImagePreviewAtom, { ...current, replacementBlocked });
  });
  if (preview === null) return null;
  return (
    <ExpandedImageDialog
      key={`${expandedImageKey(preview)}:${state?.id}`}
      preview={preview}
      onClose={closeExpandedImagePreview}
      onProtectionChange={onProtectionChange}
      {...props}
    />
  );
}
