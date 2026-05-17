import { memo, useCallback, useEffect, useEffectEvent, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

function useExpandedImagePreviewNavigation(sourcePreview: ExpandedImagePreview) {
  const [navigationState, setNavigationState] = useState(() => ({
    sourcePreview,
    index: sourcePreview.index,
  }));
  const index =
    navigationState.sourcePreview === sourcePreview ? navigationState.index : sourcePreview.index;

  const navigateImage = useCallback(
    (direction: -1 | 1) => {
      setNavigationState((existing) => {
        if (sourcePreview.images.length <= 1) return existing;
        const currentIndex =
          existing.sourcePreview === sourcePreview ? existing.index : sourcePreview.index;
        const nextIndex =
          (currentIndex + direction + sourcePreview.images.length) % sourcePreview.images.length;
        if (nextIndex === currentIndex && existing.sourcePreview === sourcePreview) {
          return existing;
        }
        return { sourcePreview, index: nextIndex };
      });
    },
    [sourcePreview],
  );

  return {
    images: sourcePreview.images,
    index,
    navigateImage,
  };
}

function useExpandedImageKeyboardShortcuts(input: {
  imageCount: number;
  navigateImage: (direction: -1 | 1) => void;
  onClose: () => void;
}) {
  const onKeyDown = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      input.onClose();
      return;
    }
    if (input.imageCount <= 1) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      input.navigateImage(-1);
      return;
    }
    if (event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    input.navigateImage(1);
  });

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview: initialPreview,
  onClose,
}: ExpandedImageDialogProps) {
  const { images, index, navigateImage } = useExpandedImagePreviewNavigation(initialPreview);

  useExpandedImageKeyboardShortcuts({
    imageCount: images.length,
    navigateImage,
    onClose,
  });

  const item = images[index];
  if (!item) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={onClose}
      />
      {images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => navigateImage(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute right-2 top-2"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <XIcon />
        </Button>
        <img
          src={item.src}
          alt={item.name}
          className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
          draggable={false}
        />
        <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
          {item.name}
          {images.length > 1 ? ` (${index + 1}/${images.length})` : ""}
        </p>
      </div>
      {images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => navigateImage(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </div>
  );
});
