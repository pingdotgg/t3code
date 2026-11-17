import { threadIssueKeyOf, type ScopedThreadRef, type ThreadIssueLink } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";

import { IssueGlyph } from "../issue/issuePresentation";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

/**
 * The thread details panel's issue rows, one per linked issue, beside the pull request rows. A
 * row names the issue as it was when linked and opens it in the right panel, which reads its
 * live state.
 */
export function ThreadDetailsIssueRows({
  links,
  threadRef,
}: {
  links: ReadonlyArray<ThreadIssueLink>;
  threadRef: ScopedThreadRef;
}) {
  if (links.length === 0) return null;
  return (
    <>
      {links.map((link) => (
        <ThreadDetailsControl
          key={threadIssueKeyOf(link)}
          part="row"
          render={<a href={link.url} target="_blank" rel="noopener noreferrer" />}
          aria-label={`Issue ${link.displayKey}: ${link.title}`}
          onClick={(event) => {
            event.stopPropagation();
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            useRightPanelStore.getState().openIssue(threadRef, link);
          }}
        >
          <IssueGlyph.issue aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            {link.displayKey}: {link.title}
          </span>
        </ThreadDetailsControl>
      ))}
    </>
  );
}
