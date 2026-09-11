import { BookmarkIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";

/**
 * Bookmark tab that shows the stash count beside the composer's other attachments
 * and opens the stash menu.
 *
 * On save the badge gives one quiet acknowledgement: it lifts to full
 * opacity and the count ticks over. `pulseKey` changes per stash, remounting
 * the count so the transition replays without a continuous animation.
 */
export const ComposerStashBadge = memo(function ComposerStashBadge(props: {
  count: number;
  menuOpen: boolean;
  pulseKey: number;
  pulsing: boolean;
  onToggleMenu: () => void;
}) {
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

  return (
    <>
      {/* The live region stays mounted even with an empty stash so the first
          save injects its message into an existing region instead of mounting
          one that already contains it, which screen readers may not announce.
          It renders outside the badge so the count's 0-to-1 mount does not
          replace its DOM node. */}
      <span role="status" className="sr-only">
        {props.pulsing ? (
          <span key={props.pulseKey}>Draft saved to Stash. Open Stash to restore it.</span>
        ) : null}
      </span>
      {props.count === 0 ? null : (
        <ComposerBanner.Root
          density="comfortable"
          width="content"
          data-composer-shoulder-tab
          className="ml-auto"
        >
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
      )}
    </>
  );
});
