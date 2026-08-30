import { memo, useCallback, useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { downloadVideoPreview, type ExpandedImagePreview } from "./ExpandedImagePreview";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: ExpandedImageDialogProps) {
  const [imageOffset, setImageOffset] = useState(0);
  const [failedVideoSrc, setFailedVideoSrc] = useState<string | null>(null);
  const [downloadingVideoSrc, setDownloadingVideoSrc] = useState<string | null>(null);
  const [downloadFailedVideoSrc, setDownloadFailedVideoSrc] = useState<string | null>(null);
  const index = (preview.index + imageOffset + preview.images.length) % preview.images.length;

  const navigateImage = useCallback((direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
  }, []);

  const downloadVideo = async (src: string, name: string) => {
    setDownloadFailedVideoSrc(null);
    setDownloadingVideoSrc(src);
    try {
      await downloadVideoPreview(src, name);
    } catch {
      setDownloadFailedVideoSrc(src);
    } finally {
      setDownloadingVideoSrc((current) => (current === src ? null : current));
    }
  };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
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
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateImage, onClose, preview.images.length]);

  const item = preview.images[index];
  if (!item) return null;
  const mediaLabel = item.type === "video" ? "video" : "image";

  const isDownloadingVideo = downloadingVideoSrc === item.src;
  const videoDownloadFailed = downloadFailedVideoSrc === item.src;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label={`Expanded ${mediaLabel} preview`}
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label={`Close ${mediaLabel} preview`}
        onClick={onClose}
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
          onClick={onClose}
          aria-label={`Close ${mediaLabel} preview`}
        >
          <XIcon />
        </Button>
        {item.type === "video" && failedVideoSrc === item.src ? (
          <div className="flex h-48 w-[min(92vw,32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black px-6 text-center text-white shadow-2xl">
            <p className="text-sm">
              {videoDownloadFailed
                ? "Could not download this video."
                : "This video format cannot be played here."}
            </p>
            <Button
              size="sm"
              variant="secondary"
              aria-busy={isDownloadingVideo || undefined}
              aria-disabled={isDownloadingVideo || undefined}
              onClick={() => {
                if (isDownloadingVideo) return;
                void downloadVideo(item.src, item.name);
              }}
            >
              <DownloadIcon />
              {isDownloadingVideo ? "Downloading…" : "Download video"}
            </Button>
          </div>
        ) : item.type === "video" ? (
          <video
            src={item.src}
            aria-label={item.name}
            autoPlay
            controls
            playsInline
            onError={() => setFailedVideoSrc(item.src)}
            className="max-h-[86vh] max-w-[92vw] rounded-lg border border-border/70 bg-black object-contain shadow-2xl"
          />
        ) : (
          <img
            src={item.src}
            alt={item.name}
            className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
            draggable={false}
          />
        )}
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
    </div>
  );
});
