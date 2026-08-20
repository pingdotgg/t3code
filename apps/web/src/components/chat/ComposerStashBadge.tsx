import { BookmarkIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

/**
 * Bookmark control that shows the stash count and opens the stash menu. It
 * sits behind the composer's shoulder unless another drawer needs that space,
 * then moves into the composer's existing controls.
 *
 * On save the badge gives one quiet acknowledgement: it lifts to full
 * opacity and the count ticks over. `pulseKey` changes per stash, remounting
 * the count so the transition replays without a continuous animation.
 */
export const ComposerStashBadge = memo(function ComposerStashBadge(props: {
  count: number;
  menuOpen: boolean;
  placement?: "inline" | "tab";
  pulseKey: number;
  pulsing: boolean;
  onToggleMenu: () => void;
}) {
  if (props.count === 0) return null;
  const inline = props.placement === "inline";
  const count = (
    <span
      key={props.pulseKey}
      className={cn(
        "text-[10px] font-medium leading-none tabular-nums",
        props.pulsing
          ? "animate-[prompt-stash-count-enter_180ms_ease-out_both] text-primary motion-reduce:animate-none"
          : "text-muted-foreground",
      )}
    >
      {props.count}
    </span>
  );

  if (inline) {
    return (
      <Button
        size="micro"
        variant="ghost-muted"
        data-prompt-stash-badge="true"
        aria-label={`Stashed prompts: ${props.count}. Open stash.`}
        aria-expanded={props.menuOpen}
        className={cn(
          "shrink-0 gap-1 px-1.5",
          (props.menuOpen || props.pulsing) &&
            "[--control-icon-color:currentColor] text-foreground",
        )}
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onToggleMenu}
      >
        <BookmarkIcon className="size-3 shrink-0" aria-hidden="true" />
        {count}
      </Button>
    );
  }

  return (
    <button
      type="button"
      data-prompt-stash-badge="true"
      aria-label={`Stashed prompts: ${props.count}. Open stash.`}
      aria-expanded={props.menuOpen}
      className={cn(
        "chat-composer-shoulder-tab chat-composer-stash-tab absolute -top-7 right-4 z-0 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-t-xl border border-b-0 px-3 pb-1 text-xs leading-none",
        "transition-[color,border-color] duration-200",
        props.menuOpen && "pointer-events-none",
        props.menuOpen || props.pulsing
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
      onPointerDown={(event) => {
        // Keep composer focus so Escape/typing flows stay intact.
        event.preventDefault();
      }}
      onClick={props.onToggleMenu}
    >
      <BookmarkIcon className="size-3 shrink-0" aria-hidden="true" />
      Stash
      {count}
    </button>
  );
});
