import { Dialog } from "@base-ui/react/dialog";
import { memo, useCallback, useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  open,
  onOpenChange,
  onOpenChangeComplete,
}: ExpandedImageDialogProps) {
  const [imageOffset, setImageOffset] = useState(0);
  const imageCount = preview?.images.length ?? 0;
  const index =
    preview && imageCount > 0 ? (preview.index + imageOffset + imageCount) % imageCount : 0;

  const navigateImage = useCallback((direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
  }, []);

  useEffect(() => {
    if (!open || !preview) return;

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
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
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateImage, open, preview]);

  const item = preview?.images[index];

  return (
    <Dialog.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) setImageOffset(0);
        onOpenChangeComplete(nextOpen);
      }}
    >
      {item && preview ? (
        <Dialog.Portal>
          <Dialog.Backdrop
            forceRender
            className="fixed inset-0 z-50 bg-black/75 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0"
          />
          <Dialog.Viewport className="fixed inset-0 z-50">
            <Dialog.Popup className="fixed inset-0 flex items-center justify-center px-4 py-6 outline-none transition-[scale,opacity] duration-200 ease-in-out [-webkit-app-region:no-drag] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0">
              <Dialog.Title className="sr-only">Expanded image preview</Dialog.Title>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                className="absolute inset-0 z-0 cursor-zoom-out"
                onClick={() => onOpenChange(false)}
              />
              {preview.images.length > 1 && (
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
                  onClick={() => onOpenChange(false)}
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
                  {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
                </p>
              </div>
              {preview.images.length > 1 && (
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
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  );
});
