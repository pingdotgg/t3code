import { cn } from "~/lib/utils";
import type { ChatImageAttachment } from "~/types";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";

export function MessageImageAttachments({
  images,
  onImageExpand,
  className,
}: {
  images: ReadonlyArray<ChatImageAttachment>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  className?: string;
}) {
  if (images.length === 0) return null;

  return (
    <div className={cn("grid max-w-[420px] grid-cols-2 gap-2", className)}>
      {images.map((image) => (
        <div
          key={image.id}
          className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
        >
          {image.previewUrl ? (
            <button
              type="button"
              className="h-full w-full cursor-zoom-in"
              aria-label={`Preview ${image.name}`}
              onClick={() => {
                const preview = buildExpandedImagePreview(images, image.id);
                if (preview) onImageExpand(preview);
              }}
            >
              <img
                src={image.previewUrl}
                alt={image.name}
                className="block h-auto max-h-[220px] w-full object-cover"
              />
            </button>
          ) : (
            <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
              {image.name}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
