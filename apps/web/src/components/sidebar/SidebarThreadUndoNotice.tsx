import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import {
  threadUndoLabel,
  undoLatestThreadAction,
  useThreadUndoNotice,
} from "../../hooks/showThreadUndoNotice";
import { cn } from "../../lib/utils";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { InlineButton } from "../ui/button";
import { SidebarMenuItem } from "../ui/sidebar";

/** Fills the free space in the sidebar footer's utility row, so it never moves or covers the list. */
export function SidebarThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // Short enough to fit beside the utility icons; screen readers hear the full summary.
  const summary = notice
    ? notice.count === 1
      ? notice.action
      : `${notice.action} ${notice.count}`
    : null;

  // Keeps the last text on screen while it fades out, then unmounts on transitionend.
  const [shownSummary, setShownSummary] = useState(summary);
  if (summary && summary !== shownSummary) setShownSummary(summary);
  const text = summary ?? shownSummary;
  if (!text) return null;

  return (
    // No min-w-0: the undo button sets this item's minimum, so a shared row squeezes its neighbour.
    <SidebarMenuItem className="flex flex-1" aria-hidden={!summary} inert={!summary}>
      <div
        onTransitionEnd={(event) => {
          if (!summary && event.target === event.currentTarget) setShownSummary(null);
        }}
        // Reversed wrap: a summary that does not fit beside the undo button drops to a
        // second line that overflow hides, instead of truncating mid-word. Browse mode
        // reads the button first; the live announcement carries the full sentence.
        className={cn(
          "flex h-6 min-w-0 flex-1 flex-row-reverse flex-wrap gap-x-1 overflow-hidden text-2xs leading-6 whitespace-nowrap text-sidebar-muted-foreground transition-opacity duration-200 ease-out starting:opacity-0",
          !summary && "opacity-0",
        )}
      >
        <InlineButton onClick={undoLatestThreadAction}>{threadUndoLabel(keybindings)}</InlineButton>
        <span>{text},</span>
      </div>
    </SidebarMenuItem>
  );
}
