import { useGT } from "gt-react";
import { ImageIcon } from "lucide-react";

import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { type TimelineRow } from "./timelineRowContext";

/**
 * The provider reports only that a generation started and how it ended, so this shows no
 * percentage: an image-shaped frame holds the place until the picture lands in the reply.
 */
export function ImageGenerationTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "image-generation" }>;
}) {
  const gt = useGT();
  const count = row.itemIds.length;
  const label = gt("{count, plural, =1 {Generating image…} other {Generating {count} images…}}", {
    count,
  });
  return (
    <div className="min-w-0 px-1">
      <div
        ref={observeVisibleAnimation}
        role="img"
        aria-label={label}
        className="image-generation-frame @container relative aspect-[4/3] w-[min(100%,clamp(11rem,56dvh,20rem))] overflow-hidden rounded-lg border border-border/70 bg-muted/60"
        data-image-generation={count}
      >
        <span aria-hidden className="image-generation-sheen absolute inset-y-0 start-0" />
        <ImageIcon
          aria-hidden
          className="absolute inset-0 m-auto hidden size-6 text-muted-foreground/45 @min-[10rem]:block"
          strokeWidth={1.5}
        />
        <span className="absolute end-2 top-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full border border-border/70 bg-background/85 px-2 py-0.5 text-muted-foreground text-xs">
          <span
            aria-hidden
            className="image-generation-pulse size-1.5 shrink-0 rounded-full bg-current"
          />
          <span className="truncate">{label}</span>
        </span>
      </div>
    </div>
  );
}
