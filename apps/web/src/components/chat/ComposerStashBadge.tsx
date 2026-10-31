import { ArchiveIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";

/**
 * Filled "Stash 3" chip in the tray row, after the branch. Opens the stash menu.
 * On save the chip gives one quiet acknowledgement: the count ticks over.
 * `pulseKey` changes per stash, remounting the count so the transition replays
 * without a continuous animation.
 */
export const ComposerStashBadge = memo(function ComposerStashBadge(props: {
  count: number;
  menuOpen: boolean;
  /** Bumped per stash; each new key replays the pulse. 0 means never pulsed. */
  pulseKey: number;
  onToggleMenu: () => void;
}) {
  if (props.count === 0) return null;

  return (
    <Button
      variant="ghost-muted"
      size="micro"
      data-prompt-stash-badge="true"
      data-pressed={props.menuOpen ? "" : undefined}
      aria-label={`Stashed prompts: ${props.count}. Open stash.`}
      aria-expanded={props.menuOpen}
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onToggleMenu}
    >
      <ArchiveIcon aria-hidden />
      <span>Stash</span>
      <span
        key={props.pulseKey}
        className={cn(
          "text-foreground tabular-nums",
          props.pulseKey > 0 &&
            "transition-[opacity,translate] duration-180 ease-out starting:translate-y-0.5 starting:opacity-0 motion-reduce:transition-none",
        )}
      >
        {props.count}
      </span>
    </Button>
  );
});
