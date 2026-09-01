import { BookmarkIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";

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
    <ComposerBanner.Count
      key={props.pulseKey}
      className={cn(
        props.pulsing
          ? "animate-[prompt-stash-count-enter_180ms_ease-out_both] text-primary motion-reduce:animate-none"
          : "text-muted-foreground",
      )}
    >
      {props.count}
    </ComposerBanner.Count>
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
          "shrink-0 gap-1 px-1.5 text-xs sm:text-xs",
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
    <ComposerBanner.Root width="content" data-composer-shoulder-tab className="ml-auto">
      <ComposerBanner.Row
        render={<button type="button" />}
        data-prompt-stash-badge="true"
        aria-label={`Stashed prompts: ${props.count}. Open stash.`}
        aria-expanded={props.menuOpen}
        className={cn(
          "transition-colors duration-200",
          props.menuOpen && "pointer-events-none",
          props.menuOpen || props.pulsing
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onToggleMenu}
      >
        <ComposerBanner.Icon>
          <BookmarkIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content>Stash</ComposerBanner.Content>
        <ComposerBanner.Actions>{count}</ComposerBanner.Actions>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
});
