import { BookmarkIcon } from "lucide-react";
import { memo, type ComponentProps } from "react";

import { cn } from "~/lib/utils";

/**
 * Bookmark pill perched on the composer's top-right shoulder. Shows the
 * stash count and doubles as the click target for opening the stash menu.
 *
 * On save the badge gives one quiet acknowledgement: it lifts to full
 * opacity and the count ticks over. `pulseKey` changes per stash, remounting
 * the count so the transition replays without a continuous animation.
 */
export const ComposerStashBadge = memo(function ComposerStashBadge(
  props: {
    count: number;
    pulseKey: number;
    pulsing: boolean;
    menuOpen: boolean;
  } & Omit<ComponentProps<"button">, "children">,
) {
  const { count, pulseKey, pulsing, menuOpen, className, onPointerDown, ...buttonProps } = props;

  if (count === 0) return null;

  return (
    <button
      {...buttonProps}
      type="button"
      data-prompt-stash-badge="true"
      aria-label={`Stashed prompts: ${count}. Open stash.`}
      aria-expanded={menuOpen}
      className={cn(
        "absolute -top-3 right-4 z-10 inline-flex cursor-pointer items-center gap-1.5 rounded-full border bg-popover px-2.5 py-0.5 text-xs shadow-sm",
        "transition-[color,border-color,opacity] duration-200",
        menuOpen || pulsing
          ? "border-border text-foreground opacity-100"
          : "border-border/70 text-muted-foreground opacity-70 hover:opacity-100 hover:text-foreground",
        className,
      )}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        // Keep composer focus so Escape/typing flows stay intact.
        event.preventDefault();
      }}
    >
      <BookmarkIcon className="size-3" aria-hidden="true" />
      Stash
      <span
        key={pulseKey}
        className={cn(
          "rounded-full px-1.5 text-[10px] font-medium tabular-nums",
          pulsing
            ? "prompt-stash-count-enter bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        {count}
      </span>
    </button>
  );
});
