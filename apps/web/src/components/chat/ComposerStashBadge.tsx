import { BookmarkIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

export interface StashFlyGhost {
  /** Monotonic id; a new value remounts the ghost so the animation replays. */
  key: number;
  snippet: string;
}

/**
 * Bookmark pill perched on the composer's top-right shoulder. Shows the
 * current method's stash count and doubles as the click target for opening
 * the stash menu. On each save a ghost of the stashed prompt flies from the
 * composer into the badge (one-shot animation; see index.css).
 */
export const ComposerStashBadge = memo(function ComposerStashBadge(props: {
  count: number;
  ghost: StashFlyGhost | null;
  menuOpen: boolean;
  onToggleMenu: () => void;
}) {
  if (props.count === 0 && !props.ghost) return null;

  return (
    <>
      {props.ghost ? (
        <div
          key={props.ghost.key}
          aria-hidden="true"
          className="prompt-stash-ghost pointer-events-none absolute inset-x-4 top-2 z-20 truncate rounded-xl border border-primary/40 bg-popover/95 px-3.5 py-2 text-sm text-foreground/90 shadow-lg [--stash-fly-x:38%] [--stash-fly-y:-2.75rem]"
        >
          {props.ghost.snippet}
        </div>
      ) : null}
      {props.count > 0 ? (
        <button
          type="button"
          data-prompt-stash-badge="true"
          aria-label={`Stashed prompts: ${props.count}. Open stash.`}
          aria-expanded={props.menuOpen}
          className={cn(
            "absolute -top-3 right-4 z-10 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border/80 bg-popover px-2.5 py-0.5 text-xs text-muted-foreground shadow-sm transition-colors hover:border-border hover:text-foreground",
            props.menuOpen && "border-primary/50 text-foreground",
          )}
          onPointerDown={(event) => {
            // Keep composer focus so Escape/typing flows stay intact.
            event.preventDefault();
          }}
          onClick={props.onToggleMenu}
        >
          <BookmarkIcon className="size-3" aria-hidden="true" />
          Stash
          <span
            key={props.ghost?.key ?? "static"}
            className={cn(
              "rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground",
              props.ghost && "prompt-stash-badge-pop",
            )}
          >
            {props.count}
          </span>
        </button>
      ) : null}
    </>
  );
});
