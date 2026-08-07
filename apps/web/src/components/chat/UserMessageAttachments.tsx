import { memo } from "react";
import type { ChatAttachment } from "../../types";
import { cn } from "~/lib/utils";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";

interface UserMessageAttachmentsProps {
  images: ReadonlyArray<ChatAttachment>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}

const MAX_VISIBLE_IMAGES = 4;

export const UserMessageAttachments = memo(function UserMessageAttachments(
  props: UserMessageAttachmentsProps,
) {
  if (props.images.length === 0) {
    return null;
  }

  const initialVisibleImages = props.images.slice(0, MAX_VISIBLE_IMAGES);
  const collapsedPreview =
    props.images.length > MAX_VISIBLE_IMAGES &&
    !initialVisibleImages[MAX_VISIBLE_IMAGES - 1]?.previewUrl
      ? props.images.slice(MAX_VISIBLE_IMAGES).find((image) => image.previewUrl)
      : undefined;
  const visibleImages = collapsedPreview
    ? [...initialVisibleImages.slice(0, MAX_VISIBLE_IMAGES - 1), collapsedPreview]
    : initialVisibleImages;
  const collapsedImageCount = props.images.length - visibleImages.length;
  const visibleImageCount = visibleImages.length;
  const isMosaic = visibleImageCount > 1;
  const visibleImageIds = new Set(visibleImages.map((image) => image.id));
  const hiddenImagesWithoutPreviews = props.images.filter(
    (image) => !visibleImageIds.has(image.id) && !image.previewUrl,
  );

  return (
    <div className="flex w-full max-w-[420px] flex-col items-end gap-1 self-end">
      <div
        className={cn(
          "grid w-full overflow-hidden rounded-lg border border-border/80 bg-border/80",
          !isMosaic && "grid-cols-1",
          visibleImageCount === 2 && "aspect-[2/1] grid-cols-2 gap-px",
          visibleImageCount === 3 && "aspect-[3/2] grid-cols-[2fr_1fr] grid-rows-2 gap-px",
          visibleImageCount >= 4 && "aspect-square max-w-[360px] grid-cols-2 grid-rows-2 gap-px",
        )}
        data-user-message-attachments="true"
        data-user-message-attachments-collapsed={collapsedImageCount > 0 ? "true" : "false"}
      >
        {visibleImages.map((image, index) => {
          const isCollapsedTile = collapsedImageCount > 0 && index === visibleImages.length - 1;
          return (
            <div
              key={image.id}
              className={cn(
                "relative min-h-0 overflow-hidden bg-background/70",
                visibleImageCount === 3 && index === 0 && "row-span-2",
              )}
            >
              {image.previewUrl ? (
                <button
                  type="button"
                  className="relative h-full w-full cursor-zoom-in"
                  aria-label={
                    isCollapsedTile
                      ? `Preview ${image.name} and ${collapsedImageCount} more images`
                      : `Preview ${image.name}`
                  }
                  onClick={() => {
                    const preview = buildExpandedImagePreview(props.images, image.id);
                    if (preview) {
                      props.onImageExpand(preview);
                    }
                  }}
                >
                  <img
                    src={image.previewUrl}
                    alt={image.name}
                    className={cn(
                      "block w-full object-cover",
                      isMosaic ? "size-full" : "h-auto max-h-[220px]",
                    )}
                  />
                  {isCollapsedTile ? (
                    <span
                      className="absolute inset-0 flex items-center justify-center bg-black/55 text-lg font-medium text-white backdrop-blur-md"
                      aria-hidden="true"
                    >
                      +{collapsedImageCount}
                    </span>
                  ) : null}
                </button>
              ) : (
                <div
                  className={cn(
                    "flex items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70",
                    isMosaic ? "h-full" : "min-h-[72px]",
                  )}
                >
                  {image.name}
                  {isCollapsedTile ? (
                    <span
                      className="absolute inset-0 flex items-center justify-center bg-black/55 text-lg font-medium text-white backdrop-blur-md"
                      aria-hidden="true"
                    >
                      +{collapsedImageCount}
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {hiddenImagesWithoutPreviews.length > 0 ? (
        <div
          className="text-right text-[11px] text-muted-foreground/70"
          data-user-message-attachments-without-previews="true"
        >
          {hiddenImagesWithoutPreviews.map((image) => image.name).join(", ")}
        </div>
      ) : null}
    </div>
  );
});
