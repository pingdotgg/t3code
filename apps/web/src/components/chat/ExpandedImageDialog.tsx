import { memo, useCallback, useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

function clampImageIndex(index: number, imageCount: number): number {
  if (imageCount <= 0) return 0;
  return Math.min(Math.max(index, 0), imageCount - 1);
}

function useExpandedImageDialogKeyboardNavigation({
  imageCount,
  navigateImage,
  onClose,
}: {
  imageCount: number;
  navigateImage: (direction: -1 | 1) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (imageCount <= 1) return;
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
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [imageCount, navigateImage, onClose]);
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: ExpandedImageDialogProps) {
  const imageCount = preview.images.length;
  const [imageIndex, setImageIndex] = useState(() => clampImageIndex(preview.index, imageCount));
  const activeImageIndex = clampImageIndex(imageIndex, imageCount);

  const navigateImage = useCallback(
    (direction: -1 | 1) => {
      setImageIndex((existing) => {
        if (imageCount <= 1) return existing;
        return (existing + direction + imageCount) % imageCount;
      });
    },
    [imageCount],
  );
  const navigateToPreviousImage = useCallback(() => {
    navigateImage(-1);
  }, [navigateImage]);
  const navigateToNextImage = useCallback(() => {
    navigateImage(1);
  }, [navigateImage]);

  useExpandedImageDialogKeyboardNavigation({
    imageCount,
    navigateImage,
    onClose,
  });

  const item = preview.images[activeImageIndex];
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
      {imageCount > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={navigateToPreviousImage}
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
          {imageCount > 1 ? ` (${activeImageIndex + 1}/${imageCount})` : ""}
        </p>
      </div>
      {imageCount > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={navigateToNextImage}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </div>
  );
});
